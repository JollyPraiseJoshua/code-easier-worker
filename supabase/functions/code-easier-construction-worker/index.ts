const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Data = Record<string, any>;

const STOP = new Set([
  "the", "and", "for", "with", "you", "your", "my", "our",
  "how", "what", "why", "can", "could", "would", "should",
  "does", "did", "are", "was", "is", "to", "of", "in", "on",
  "a", "an", "it", "this", "that", "me", "please", "help",
  "build", "create", "make", "using", "use", "from",
]);

function reply(data: Data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function termsOf(message: string): string[] {
  return [...new Set(
    (message.toLowerCase().match(/[a-z][a-z0-9+#.-]*/g) || [])
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )].slice(0, 8);
}

function resultsOf(data: Data): any[] {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  return [];
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

async function call(
  base: string,
  key: string,
  name: string,
  body: Data,
): Promise<Data> {
  try {
    const response = await fetch(
      `${base}/functions/v1/${name}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": key,
          "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      },
    );

    const data = await response.json();

    if (!response.ok || data?.success === false) {
      return {
        success: false,
        error: data?.error || `${name} failed.`,
      };
    }

    return data;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Request failed.",
    };
  }
}

function makeAnswer(
  intent: string,
  message: string,
  knowledge: any[],
  pages: any[],
  search: any[],
  plan: Data | null,
): string {
  const evidence: string[] = [];

  for (const item of knowledge.slice(0, 3)) {
    const content = clean(item?.content);
    if (content) {
      evidence.push(
        `INTERNAL KNOWLEDGE - ${clean(item?.title) || "Knowledge"}:\n${content.slice(0, 900)}`,
      );
    }
  }

  for (const page of pages.filter((p) => p.success).slice(0, 3)) {
    if (page.content) {
      evidence.push(
        `INTERNET SOURCE - ${page.title}:\n${page.content.slice(0, 1200)}\nSource: ${page.url}`,
      );
    }
  }

  if (evidence.length === 0) {
    for (const item of search.slice(0, 3)) {
      evidence.push(
        `${item.title}: ${item.snippet}\nSource: ${item.url}`,
      );
    }
  }

  const research = evidence.length
    ? evidence.join("\n\n")
    : "No useful knowledge or internet evidence was found.";

  if (intent === "create_project") {
    return plan
      ? "PROJECT PLANNING\n\nThe project reasoner has prepared a plan. Review the projectPlan data for its details.\n\nRESEARCH:\n" + research
      : "PROJECT PLANNING\n\nThe project planner could not prepare a plan. The request was not constructed.\n\n" + research;
  }

  if (intent === "programming_question" ||
      intent === "programming_explanation") {
    return "PROGRAMMING TUTOR\n\nYour request is being handled as a learning question, not a construction request.\n\nQuestion: " +
      message + "\n\nUse the following findings to understand the topic:\n" + research;
  }

  if (intent === "troubleshooting") {
    return "CODE ANALYZER\n\nYour request has been classified as a troubleshooting task.\n\n" +
      "The system has gathered relevant evidence, but this response does not claim that your code has been repaired. " +
      "A precise diagnosis requires the relevant code and the exact error message.\n\n" + research;
  }

  if (intent === "modify_project") {
    return "PROJECT EDITOR\n\nYour request has been classified as a project modification.\n\n" +
      "Requested change: " + message + "\n\n" +
      "The system can prepare a modification plan, but it has not yet changed your project files. " +
      "Actual editing requires the construction component.\n\n" + research;
  }

  return "GENERAL RESEARCH\n\n" + research;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  if (req.method !== "POST") {
    return reply({ success: false, error: "POST required." }, 405);
  }

  try {
    const body = await req.json();
    const message = typeof body?.message === "string"
      ? body.message.trim()
      : "";

    if (!message) {
      return reply({
        success: false,
        error: "Please provide a message.",
      }, 400);
    }

    if (message.length > 10000) {
      return reply({
        success: false,
        error: "Message is too long. Maximum is 10,000 characters.",
      }, 400);
    }

    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_ANON_KEY");

    if (!base || !key) {
      throw new Error("Supabase environment settings are missing.");
    }

    // 1. Understand the request.
    const brain = await call(
      base, key, "code-easier-brain", { message },
    );

    const understanding = brain?.understanding || {
      intent: "general_question",
      capability: "conversation",
      originalMessage: message,
      understood: false,
    };

    const intent = understanding.intent || "general_question";
    const topicTerms = termsOf(message);
    const searchQueries = [
      topicTerms.join(" "),
      topicTerms[0] || message.slice(0, 100),
      topicTerms.length > 1
        ? `${topicTerms[0]} ${topicTerms[topicTerms.length - 1]}`
        : message.slice(0, 100),
    ].filter((q, i, a) => q && a.indexOf(q) === i);

    // 2. Retrieve internal knowledge.
    const knowledgeResponses = await Promise.all(
      searchQueries.map((query) =>
        call(base, key, "code-easier-knowledge", { query })
      ),
    );

    const knowledgeErrors = knowledgeResponses
      .filter((r) => r.success === false)
      .map((r) => r.error);

    const knowledgeMap = new Map<string, any>();

    for (const response of knowledgeResponses) {
      for (const item of resultsOf(response)) {
        const id = String(item.id || item.title || JSON.stringify(item));
        knowledgeMap.set(id, item);
      }
    }

    const rankedKnowledge = [...knowledgeMap.values()]
      .sort((a, b) =>
        Number(b.relevance || 0) - Number(a.relevance || 0)
      ).slice(0, 5);

    // 3. Search the internet.
    const searchResponses = await Promise.all(
      searchQueries.map((query) =>
        call(base, key, "code-easier-web-search", { query })
      ),
    );

    const searchMap = new Map<string, any>();

    for (const response of searchResponses) {
      for (const item of resultsOf(response)) {
        if (typeof item.url === "string" &&
            item.url.startsWith("https://")) {
          searchMap.set(item.url, item);
        }
      }
    }

    const searchResults = [...searchMap.values()]
      .map((item) => ({
        title: clean(item.title),
        snippet: clean(item.snippet),
        url: item.url,
        source: clean(item.source) || "Internet",
      }))
      .filter((item) => item.title)
      .slice(0, 8);

    // 4. Read relevant webpages.
    const internetSources = await Promise.all(
      searchResults.slice(0, 3).map(async (item) => {
        const page = await call(
          base, key, "code-easier-web-reader", { url: item.url },
        );

        return {
          title: clean(page.title) || item.title,
          url: item.url,
          source: item.source,
          content: clean(page.content).slice(0, 7000),
          success: page.success !== false,
          error: page.error,
        };
      }),
    );

    // 5. Select the specialized reasoning path.
    let projectPlan: Data | null = null;
    let codeAnalysis: Data | null = null;
    let editPlan: Data | null = null;

    if (intent === "create_project") {
      const result = await call(
        base,
        key,
        "code-easier-reasoner",
        { description: message },
      );

      if (result.success !== false) projectPlan = result;
    }

    if (intent === "troubleshooting") {
      codeAnalysis = {
        capability: "code_analyzer",
        task: "troubleshoot",
        request: message,
        codeProvided: /\b(function|const|let|var|class|import|export)\b/.test(message),
        status: "evidence_gathered",
        nextStep: "Examine the supplied code and exact error before proposing a correction.",
      };
    }

    if (intent === "modify_project") {
      editPlan = {
        capability: "project_editor",
        task: "modify_project",
        requestedChange: message,
        status: "modification_plan_needed",
        nextStep: "Identify the affected project files and prepare the code changes.",
      };
    }

    if (intent === "programming_question" ||
        intent === "programming_explanation") {
      codeAnalysis = {
        capability: "programming_tutor",
        task: "explain_and_teach",
        topicTerms,
        status: "research_completed",
      };
    }

    // 6. Produce an intent-specific response.
    const answer = makeAnswer(
      intent,
      message,
      rankedKnowledge,
      internetSources,
      searchResults,
      projectPlan,
    );

    return reply({
      success: true,
      engine: "CODE EASIER AI",
      externalAIUsed: false,
      understanding,
      reasoning: {
        intent,
        topicTerms,
        searchQueries,
        knowledgeUsed: rankedKnowledge.length,
        projectPlanningUsed: projectPlan !== null,
        internetSearchUsed: searchResults.length > 0,
        internetPagesDiscovered: searchResults.length,
        internetPagesRead: internetSources.filter((p) => p.success).length,
        specializedPath: understanding.capability,
      },
      knowledge: rankedKnowledge,
      knowledgeErrors,
      webSearch: {
        success: searchResponses.some((r) => r.success !== false),
        results: searchResults,
        resultCount: searchResults.length,
      },
      internetSources,
      projectPlan,
      codeAnalysis,
      editPlan,
      answer,
      limitations: [
        "CODE EASIER uses internal deterministic reasoning and retrieved evidence.",
        "It does not use Gemini or another external AI provider.",
        "Code analysis and project editing are not yet connected to an actual file-construction worker.",
        "Internet findings may require verification.",
      ],
    });
  } catch (error) {
    return reply({
      success: false,
      engine: "CODE EASIER AI",
      externalAIUsed: false,
      error: error instanceof Error
        ? error.message
        : "An unexpected error occurred.",
    }, 500);
  }
});
