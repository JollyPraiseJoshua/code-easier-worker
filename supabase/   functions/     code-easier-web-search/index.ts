const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DIRECTORY_URL =
  "https://searx.space/data/instances.json";

const MAX_INSTANCE_ATTEMPTS = 4;
const MAX_RESULTS = 10;
const TIMEOUT_MS = 4000;

function cleanText(value: unknown, max = 1000): string {
  if (typeof value !== "string") return "";

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string") return "";

  try {
    const url = new URL(value);

    if (!["https:", "http:"].includes(url.protocol)) {
      return "";
    }

    url.hash = "";

    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        ["fbclid", "gclid"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }

    return url.toString();
  } catch {
    return "";
  }
}

function sourceType(url: string): string {
  try {
    const host = new URL(url).hostname
      .toLowerCase()
      .replace(/^www\./, "");

    if (
      host === "wikipedia.org" ||
      host.endsWith(".wikipedia.org")
    ) {
      return "wikipedia";
    }

    const officialDomains = [
      "developer.mozilla.org",
      "web.dev",
      "developer.android.com",
      "nodejs.org",
      "typescriptlang.org",
      "react.dev",
      "reactnative.dev",
      "docs.expo.dev",
      "supabase.com",
      "docs.deno.com",
      "docs.python.org",
      "docs.oracle.com",
      "learn.microsoft.com",
      "developer.apple.com",
      "docs.flutter.dev",
      "dart.dev",
      "go.dev",
      "rust-lang.org",
      "docs.rs",
      "developer.chrome.com",
      "vite.dev",
      "nextjs.org",
      "firebase.google.com",
      "cloud.google.com",
      "docs.aws.amazon.com",
    ];

    if (
      officialDomains.some(
        (domain) =>
          host === domain || host.endsWith("." + domain),
      )
    ) {
      return "official_documentation";
    }

    return "general_web";
  } catch {
    return "general_web";
  }
}

function sourceName(type: string): string {
  if (type === "official_documentation") {
    return "Official documentation";
  }

  if (type === "wikipedia") return "Wikipedia";

  return "Web search";
}

function score(result: any): number {
  if (result.sourceType === "official_documentation") {
    return 100;
  }

  if (result.sourceType === "wikipedia") return 60;

  return 20;
}

async function requestJson(
  url: string,
  timeout = TIMEOUT_MS,
): Promise<{ data: any | null; error: string }> {
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (compatible; CODE-EASIER-AI/1.0)",
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      return {
        data: null,
        error: `HTTP ${response.status}`,
      };
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("json")) {
      return {
        data: null,
        error: "Server did not return JSON",
      };
    }

    try {
      return {
        data: await response.json(),
        error: "",
      };
    } catch {
      return {
        data: null,
        error: "Invalid JSON response",
      };
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    return {
      data: null,
      error: message.includes("Timeout")
        ? "Request timed out"
        : "Network request failed",
    };
  }
}

// Randomize the order of public search servers.
function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled;
}

async function discoverInstances(): Promise<{
  instances: string[];
  error: string;
}> {
  const configured = Deno.env.get("SEARXNG_URL");

  const directory = await requestJson(
    DIRECTORY_URL,
    TIMEOUT_MS,
  );

  const discovered: string[] = [];

  const instanceData = directory.data?.instances;

  if (
    instanceData &&
    typeof instanceData === "object" &&
    !Array.isArray(instanceData)
  ) {
    for (const [address, details] of Object.entries(instanceData)) {
      try {
        const url = new URL(address);

        if (
          url.protocol !== "https:" ||
          url.hostname.endsWith(".onion") ||
          (details as any)?.error
        ) {
          continue;
        }

        discovered.push(url.origin);
      } catch {
        continue;
      }
    }
  }

  const candidates = [
    ...(configured ? [configured] : []),
    ...discovered,
  ];

  const unique = [
    ...new Set(
      candidates
        .map((item) => {
          try {
            const url = new URL(item);

            return url.protocol === "https:"
              ? url.origin
              : "";
          } catch {
            return "";
          }
        })
        .filter(Boolean),
    ),
  ];

  return {
    instances: unique.slice(0, 30),
    error: directory.error,
  };
}

async function searchSearXNG(query: string): Promise<{
  results: any[];
  diagnostics: any;
}> {
  const discovery = await discoverInstances();

  const diagnostics: any = {
    directory: discovery.instances.length > 0
      ? "Instance list loaded"
      : discovery.error || "No instances discovered",
    instancesDiscovered: discovery.instances.length,
    attempts: [],
    status: "unavailable",
  };

  // Keep a configured server first, if one exists.
  const configured = Deno.env.get("SEARXNG_URL");

  const configuredOrigin = configured
    ? (() => {
        try {
          return new URL(configured).origin;
        } catch {
          return "";
        }
      })()
    : "";

  // Randomize the remaining public servers on each request.
  const discoveredCandidates = discovery.instances.filter(
    (instance) => instance !== configuredOrigin,
  );

  const candidates = [
    ...(configuredOrigin ? [configuredOrigin] : []),
    ...shuffle(discoveredCandidates),
  ].slice(0, MAX_INSTANCE_ATTEMPTS);

  for (const instance of candidates) {
    try {
      const url = new URL("/search", instance);

      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", "en");
      url.searchParams.set("safesearch", "1");
      url.searchParams.set("pageno", "1");

      const response = await requestJson(url.toString());

      diagnostics.attempts.push({
        server: instance,
        status: response.data
          ? "Success"
          : response.error,
      });

      if (
        !response.data ||
        !Array.isArray(response.data.results)
      ) {
        continue;
      }

      const results = response.data.results
        .filter((item: any) => item && typeof item === "object")
        .map((item: any) => {
          const pageUrl = normalizeUrl(item.url);
          const type = sourceType(pageUrl);

          return {
            title: cleanText(item.title, 250),
            url: pageUrl,
            snippet: cleanText(
              item.content || item.snippet || "",
              1000,
            ),
            source: sourceName(type),
            sourceType: type,
            engine: "SearXNG",
          };
        })
        .filter((item: any) => item.title && item.url);

      if (results.length > 0) {
        diagnostics.status = "success";
        diagnostics.workingServer = instance;

        return {
          results,
          diagnostics,
        };
      }

      diagnostics.attempts.push({
        server: instance,
        status: "No search results",
      });
    } catch {
      diagnostics.attempts.push({
        server: instance,
        status: "Unexpected error",
      });
    }
  }

  return {
    results: [],
    diagnostics,
  };
}

async function searchWikipedia(query: string): Promise<{
  results: any[];
  status: string;
}> {
  const url = new URL("https://en.wikipedia.org/w/api.php");

  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("utf8", "1");
  url.searchParams.set("srlimit", "3");

  const response = await requestJson(url.toString());

  const pages = response.data?.query?.search;

  if (!Array.isArray(pages)) {
    return {
      results: [],
      status: response.error || "No Wikipedia results",
    };
  }

  const results = pages.map((page: any) => {
    const title = cleanText(page.title, 250);

    return {
      title,
      url:
        "https://en.wikipedia.org/wiki/" +
        encodeURIComponent(title.replace(/ /g, "_")),
      snippet: cleanText(page.snippet, 1000),
      source: "Wikipedia",
      sourceType: "wikipedia",
      engine: "Wikipedia",
    };
  }).filter((item: any) => item.title && item.url);

  return {
    results,
    status: results.length > 0 ? "success" : "No results",
  };
}

function getSearchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((word) => word.length > 1),
    ),
  ].slice(0, 15);
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({
      success: false,
      error: "Only POST requests are supported.",
    }, 405);
  }

  try {
    const body = await req.json();

    const query = cleanText(
      body?.query ||
      body?.searchQuery ||
      body?.description ||
      body?.text ||
      "",
      500,
    );

    if (query.length < 2) {
      return jsonResponse({
        success: false,
        error: "A valid search query is required.",
      }, 400);
    }

    // Search the wider internet and Wikipedia.
    const [webSearch, wikipedia] = await Promise.all([
      searchSearXNG(query),
      searchWikipedia(query),
    ]);

    const combined = [
      ...webSearch.results,
      ...wikipedia.results,
    ];

    const unique = new Map<string, any>();

    for (const item of combined) {
      if (!unique.has(item.url)) {
        unique.set(item.url, item);
      }
    }

    const results = [...unique.values()]
      .sort((a, b) => score(b) - score(a))
      .slice(0, MAX_RESULTS);

    const sources = [
      ...new Set(results.map((item) => item.source)),
    ];

    const searxWorked =
      webSearch.diagnostics.status === "success";

    const wikipediaWorked =
      wikipedia.status === "success";

    const success = searxWorked || wikipediaWorked;

    return jsonResponse({
      success,
      engine: "CODE EASIER AI",
      component: "web_search",
      source: sources.join(" and ") || "No source available",
      sources,
      externalAIUsed: false,
      query,
      searchedQuery: query.toLowerCase(),
      searchTerms: getSearchTerms(query),
      resultCount: results.length,
      results,

      searchDiagnostics: {
        overallStatus:
          searxWorked && wikipediaWorked
            ? "complete"
            : success
              ? "partial"
              : "failed",

        searxng: webSearch.diagnostics,

        wikipedia: {
          status: wikipedia.status,
        },
      },

      message: success
        ? "Search completed. Results are ready for webpage reading and AI analysis."
        : "All search sources failed or returned no results.",
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      engine: "CODE EASIER AI",
      component: "web_search",
      error: "The search request could not be completed.",
      details: cleanText(
        error instanceof Error
          ? error.message
          : String(error),
        300,
      ),
      resultCount: 0,
      results: [],
    }, 500);
  }
});
