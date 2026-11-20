import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

// CODE EASIER Modular Checkpoint Construction Worker
// Gemini-only provider adapter. Other providers can be added later.

const MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];
const MODEL_TIMEOUT = 40_000;
const MAX_OUTPUT_TOKENS = 12_000;
const MAX_COMPONENTS = 12;
const MAX_REPAIRS = 5;
const MAX_HTML_LENGTH = 500_000;
const MAX_FILE_LENGTH = 500_000;
const MAX_REVIEW_INPUT = 28_000;
const MAX_RECENT_ERRORS = 20;
const LEASE_MS = 180_000;

const STAGES = ["planning", "components", "integrating", "reviewing", "repairing", "finalizing"] as const;
type Stage = typeof STAGES[number];
type ComponentKind = "ui" | "logic" | "backend" | "config";

interface GeneratedFile { path: string; content: string; }
interface ComponentPlan {
  id: string;
  name: string;
  type: ComponentKind;
  description: string;
  htmlRequirements?: string;
  cssRequirements?: string;
  javascriptRequirements?: string;
  filesRequirements?: string;
}
interface ComponentOutput {
  html: string;
  css: string;
  javascript: string;
  files: GeneratedFile[];
  notes: string;
}
interface ComponentRecord {
  plan: ComponentPlan;
  status: "pending" | "completed";
  output?: ComponentOutput;
}
interface ReviewIssue { componentId: string; problem: string; suggestedFix?: string; }
interface Progress {
  stage?: Stage;
  modelIndex?: number;
  retryCycles?: number;
  nextRetryAt?: string | null;
  projectType?: string;
  summary?: string;
  requiresBackend?: boolean;
  backendNotes?: string;
  components?: ComponentRecord[];
  componentIndex?: number;
  testChecklist?: string[];
  repairCount?: number;
  repairTargetId?: string;
  repairProblem?: string;
  reviewStatus?: "passed" | "warnings" | "pending";
  reviewWarnings?: string[];
  recentErrors?: Array<{ stage: string; componentId?: string; model: string; type: string; message: string; at: string }>;
}
interface StageFailure { type: string; message: string; stop: boolean; retryAfterMs?: number; }
class StageError extends Error {
  failure: StageFailure;
  constructor(failure: StageFailure) { super(failure.message); this.failure = failure; }
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
function clip(value: unknown, max = 1500): string {
  return String(value ?? "").slice(0, max);
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function cleanGeneratedText(value: string): string {
  return value.trim().replace(/^```(?:html|css|javascript|js|json|typescript|ts)?\s*/i, "").replace(/\s*```$/, "").trim();
}
function extractJson(value: string): any {
  const cleaned = cleanGeneratedText(value);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Gemini did not return valid JSON for this construction task.");
  return JSON.parse(cleaned.slice(first, last + 1));
}
function validRelativePath(path: string): boolean {
  if (!path || path.length > 180 || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part && part !== "." && part !== "..") && /^[a-zA-Z0-9._/-]+$/.test(path);
}
function normalizeComponentId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

async function callGemini(projectName: string, description: string, model: string, prompt: string, jsonMode = false): Promise<string> {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) throw new StageError({ type: "MISSING_API_KEY", message: "GEMINI_API_KEY is missing from Supabase Secrets.", stop: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: "You are CODE EASIER, a careful software construction engine. Complete only the requested task. Return the exact requested format. Do not claim that an external backend, database, deployment, or service is connected unless the supplied project actually connects to it. Prefer secure, maintainable, accessible code." }] },
          contents: [{ role: "user", parts: [{ text: `PROJECT NAME:\n${projectName}\n\nORIGINAL PROJECT REQUEST:\n${description}\n\nCURRENT TASK:\n${prompt}` }] }],
          generationConfig: { temperature: 0.2, responseMimeType: jsonMode ? "application/json" : "text/plain", maxOutputTokens: MAX_OUTPUT_TOKENS }
        })
      }
    );
    const responseText = await response.text();
    let data: any;
    try { data = JSON.parse(responseText); } catch { data = null; }

    if (!response.ok) {
      const message = String(data?.error?.message || responseText || "Gemini API error.");
      const lower = message.toLowerCase();
      const dailyQuota = response.status === 429 && (lower.includes("daily quota") || lower.includes("per_day") || lower.includes("per day") || lower.includes("generate_requests_per_day"));
      const permanent = [400, 401, 403].includes(response.status) && !dailyQuota;
      throw new StageError({
        type: dailyQuota ? "DAILY_QUOTA_EXHAUSTED" : response.status === 429 ? "RATE_LIMIT" : response.status === 503 ? "SERVICE_OVERLOAD" : response.status === 404 ? "MODEL_NOT_FOUND" : "API_ERROR",
        message: clip(message), stop: permanent, retryAfterMs: dailyQuota ? 6 * 60 * 60 * 1000 : undefined
      });
    }
    if (!data) throw new StageError({ type: "INVALID_RESPONSE", message: "Gemini returned unreadable response JSON.", stop: false });
    const candidate = data?.candidates?.[0];
    if (!candidate) throw new StageError({ type: "EMPTY_CANDIDATE", message: "Gemini returned no construction content.", stop: false });
    if (candidate.finishReason === "MAX_TOKENS") throw new StageError({ type: "OUTPUT_LIMIT", message: "Gemini reached the output limit for this task.", stop: false });
    if (candidate.finishReason === "SAFETY" || candidate.finishReason === "RECITATION") {
      throw new StageError({ type: "GENERATION_BLOCKED", message: "Gemini blocked this construction task.", stop: true });
    }
    const output = candidate.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!output) throw new StageError({ type: "EMPTY_CONTENT", message: "Gemini returned empty construction content.", stop: false });
    return output;
  } catch (error) {
    if (error instanceof StageError) throw error;
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new StageError({ type: timedOut ? "TIMEOUT" : "NETWORK_ERROR", message: timedOut ? `Gemini did not respond within ${MODEL_TIMEOUT / 1000} seconds.` : clip(error instanceof Error ? error.message : error), stop: false });
  } finally { clearTimeout(timeout); }
}

function makePreviewHtml(projectName: string, progress: Progress, final = false): string {
  const title = escapeHtml(projectName || "CODE EASIER project");
  const records = progress.components || [];
  const completed = records.filter((item) => item.status === "completed");
  const pending = records.filter((item) => item.status !== "completed");
  const htmlBody = completed.map((item) => item.output?.html || "").filter(Boolean).join("\n\n");
  const css = completed.map((item) => item.output?.css || "").filter(Boolean).join("\n\n").replace(/<\/style/gi, "<\\/style");
  const js = completed.map((item) => item.output?.javascript || "").filter(Boolean).join("\n\n").replace(/<\/script/gi, "<\\/script");
  const notice = final ? "" : `<aside style="position:sticky;top:0;z-index:99999;padding:10px 14px;background:#fff4ce;color:#5b4300;border-bottom:1px solid #e7ca72;font:14px system-ui"><strong>Intermediate preview — construction is still running.</strong><br>${completed.length} of ${records.length} components completed. ${pending.length} remain. Some controls or connected services may not work until construction finishes.</aside>`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body>${notice}<main>${htmlBody || "<p style='font:16px system-ui;padding:24px'>CODE EASIER is preparing the first preview components.</p>"}</main><script>${js}</script></body></html>`;
  if (page.length > MAX_HTML_LENGTH) throw new Error("The current preview is larger than the permitted size.");
  return page;
}

function collectFiles(projectName: string, progress: Progress, final = false): GeneratedFile[] {
  const records = (progress.components || []).filter((item) => item.status === "completed");
  const previewHtml = makePreviewHtml(projectName, progress, final);
  const files = new Map<string, string>();
  files.set("index.html", previewHtml);
  for (const record of records) {
    for (const file of record.output?.files || []) {
      if (!validRelativePath(file.path)) continue;
      if (file.content.length > MAX_FILE_LENGTH) continue;
      files.set(file.path, file.content);
    }
  }
  return Array.from(files.entries()).map(([path, content]) => ({ path, content }));
}

function makeProgressSummary(progress: Progress) {
  const records = progress.components || [];
  return {
    stage: progress.stage || "planning",
    completedComponents: records.filter((item) => item.status === "completed").length,
    totalComponents: records.length,
    remainingComponents: records.filter((item) => item.status !== "completed").length,
    retryCycles: progress.retryCycles || 0,
    nextRetryAt: progress.nextRetryAt || null,
    reviewStatus: progress.reviewStatus || "pending"
  };
}

function makeIntermediateResult(projectName: string, progress: Progress) {
  const files = collectFiles(projectName, progress, false);
  const backendComponents = (progress.components || []).filter((item) => item.status === "completed" && (item.plan.type === "backend" || item.plan.type === "config"));
  return {
    success: true,
    projectName,
    projectType: progress.projectType || "custom_project",
    summary: progress.summary || "CODE EASIER is constructing this project.",
    constructionStatus: "in_progress",
    testStatus: "intermediate_preview",
    previewHtml: files.find((file) => file.path === "index.html")?.content || "",
    files,
    progress: makeProgressSummary(progress),
    testChecklist: progress.testChecklist || [],
    backendStatus: progress.requiresBackend
      ? `${backendComponents.length} backend/configuration component(s) generated so far. They are source files only; no server backend has been provisioned or connected.`
      : "The project plan does not currently require a separate server backend."
  };
}

function validatePlan(raw: any): Progress {
  if (!raw || !Array.isArray(raw.components)) throw new Error("Gemini's project plan did not contain a components list.");
  const components: ComponentRecord[] = raw.components.slice(0, MAX_COMPONENTS).map((item: any, index: number) => {
    const id = normalizeComponentId(String(item?.id || `component-${index + 1}`)) || `component-${index + 1}`;
    const type = ["ui", "logic", "backend", "config"].includes(item?.type) ? item.type as ComponentKind : "ui";
    const plan: ComponentPlan = {
      id, name: clip(item?.name || `Component ${index + 1}`, 100), type,
      description: clip(item?.description || "Implement this project component.", 1800),
      htmlRequirements: clip(item?.htmlRequirements || "", 2500),
      cssRequirements: clip(item?.cssRequirements || "", 2500),
      javascriptRequirements: clip(item?.javascriptRequirements || "", 2500),
      filesRequirements: clip(item?.filesRequirements || "", 2500)
    };
    return { plan, status: "pending" as const };
  });
  if (components.length === 0) throw new Error("Gemini's project plan contained no usable components.");
  const ids = new Set<string>();
  for (const record of components) {
    if (ids.has(record.plan.id)) throw new Error(`The project plan contains duplicate component ID: ${record.plan.id}`);
    ids.add(record.plan.id);
  }
  return {
    stage: "components", modelIndex: 0, retryCycles: 0, nextRetryAt: null,
    projectType: clip(raw.projectType || "custom_project", 100),
    summary: clip(raw.summary || "Project constructed by CODE EASIER.", 1200),
    requiresBackend: Boolean(raw.requiresBackend), backendNotes: clip(raw.backendNotes || "", 1800),
    components, componentIndex: 0,
    testChecklist: Array.isArray(raw.testChecklist) ? raw.testChecklist.filter((x: unknown) => typeof x === "string").slice(0, 20).map((x: string) => clip(x, 300)) : [],
    repairCount: 0, reviewStatus: "pending", reviewWarnings: []
  };
}

async function planProject(projectName: string, description: string, model: string): Promise<Progress> {
  const prompt = `Plan this project as a set of small, independently constructible components. Return ONLY JSON with this schema:
{
 "projectType":"short category",
 "summary":"project summary",
 "requiresBackend":false,
 "backendNotes":"explain backend needs, if any",
 "testChecklist":["observable test"],
 "components":[
  {"id":"short-unique-id","name":"Component name","type":"ui|logic|backend|config","description":"specific work for this component","htmlRequirements":"markup needed","cssRequirements":"styles needed","javascriptRequirements":"behaviour needed","filesRequirements":"files and responsibilities needed"}
 ]
}
Rules: create 3 to 12 components; keep each component small enough for one AI generation request; use type ui for visible interface parts, logic for client-side behaviour, backend for server/API/database source, and config for configuration or supporting files. For a web application, split the page into meaningful sections and split complex behaviour into separate logic components. Include backend components only when the user's request genuinely requires backend functionality. Do not claim backend services are already deployed. Use unique IDs containing only lowercase letters, numbers, hyphens or underscores. Include requirements for every relevant field. Keep the plan specific to the original request.`;
  const output = await callGemini(projectName, description, model, prompt, true);
  return validatePlan(extractJson(output));
}

async function generateComponent(projectName: string, description: string, progress: Progress, record: ComponentRecord, model: string, repairProblem?: string): Promise<ComponentOutput> {
  const plan = record.plan;
  const old = record.output;
  const prompt = `Generate or repair exactly ONE project component. Return ONLY JSON:
{
 "html":"HTML fragment only, no html/head/body wrapper",
 "css":"CSS rules only, no style tags",
 "javascript":"JavaScript only, no script tags",
 "files":[{"path":"relative/path.ext","content":"complete file contents"}],
 "notes":"short implementation note"
}
COMPONENT ID: ${plan.id}
NAME: ${plan.name}
TYPE: ${plan.type}
DESCRIPTION: ${plan.description}
HTML REQUIREMENTS: ${plan.htmlRequirements || "Not applicable"}
CSS REQUIREMENTS: ${plan.cssRequirements || "Not applicable"}
JAVASCRIPT REQUIREMENTS: ${plan.javascriptRequirements || "Not applicable"}
FILE REQUIREMENTS: ${plan.filesRequirements || "Not applicable"}
PROJECT SUMMARY: ${progress.summary || ""}
${repairProblem ? `REPAIR THIS PROBLEM: ${repairProblem}\nCURRENT COMPONENT OUTPUT:\n${JSON.stringify(old || {})}\nCorrect the problem while preserving working behaviour.` : "Create the component completely. Do not use placeholders for requested functionality."}
Rules: for ui and logic components, put browser markup/styles/behaviour in html/css/javascript fields as appropriate. For backend and config components, put complete source/config files in files and leave unused browser fields empty. Never include secrets, fake credentials, or claims that generated backend files are deployed. Every file path must be relative and must not contain '..'. Use accessible controls and mobile-responsive design where relevant. Keep this component self-contained and avoid changing unrelated components.`;
  const output = await callGemini(projectName, description, model, prompt, true);
  const raw = extractJson(output);
  const files: GeneratedFile[] = Array.isArray(raw.files) ? raw.files.slice(0, 20).filter((file: any) => file && typeof file.path === "string" && typeof file.content === "string" && validRelativePath(file.path) && file.content.length <= MAX_FILE_LENGTH).map((file: any) => ({ path: file.path, content: file.content })) : [];
  const result: ComponentOutput = {
    html: typeof raw.html === "string" ? cleanGeneratedText(raw.html) : "",
    css: typeof raw.css === "string" ? cleanGeneratedText(raw.css) : "",
    javascript: typeof raw.javascript === "string" ? cleanGeneratedText(raw.javascript) : "",
    files,
    notes: clip(raw.notes || "", 1000)
  };
  if (plan.type === "backend" || plan.type === "config") {
    if (files.length === 0) throw new Error(`Gemini did not generate any valid files for ${plan.name}.`);
  } else if (!result.html && !result.css && !result.javascript && files.length === 0) {
    throw new Error(`Gemini returned an empty component for ${plan.name}.`);
  }
  return result;
}

function collectReviewInput(projectName: string, progress: Progress): string {
  const parts: string[] = [`PROJECT: ${projectName}`, `SUMMARY: ${progress.summary || ""}`];
  for (const record of progress.components || []) {
    if (record.status !== "completed" || !record.output) continue;
    parts.push(`COMPONENT ${record.plan.id} (${record.plan.type}) ${record.plan.name}`);
    parts.push(`HTML: ${record.output.html}`);
    parts.push(`CSS: ${record.output.css}`);
    parts.push(`JAVASCRIPT: ${record.output.javascript}`);
    for (const file of record.output.files) parts.push(`FILE ${file.path}: ${file.content.slice(0, 3500)}`);
  }
  return parts.join("\n\n").slice(0, MAX_REVIEW_INPUT);
}

async function reviewProject(projectName: string, description: string, progress: Progress, model: string): Promise<{ status: string; issues: ReviewIssue[]; warnings: string[] }> {
  const prompt = `Review the supplied generated project for clear functional contradictions, missing required features, broken references between components, obvious security problems, and incomplete implementation. This is a code review, not a claim that you executed the project. Return ONLY JSON: {"status":"pass|needs_repair","issues":[{"componentId":"an existing component ID","problem":"specific defect","suggestedFix":"specific correction"}],"warnings":["remaining limitation"]}. Return no more than 5 issues. Only identify defects supported by the supplied code. If no definite defect is found, return pass.\n\nPROJECT REQUEST:\n${description}\n\nGENERATED PROJECT:\n${collectReviewInput(projectName, progress)}`;
  const raw = extractJson(await callGemini(projectName, description, model, prompt, true));
  const validIds = new Set((progress.components || []).map((item) => item.plan.id));
  const issues: ReviewIssue[] = Array.isArray(raw.issues) ? raw.issues.slice(0, 5).filter((issue: any) => issue && validIds.has(issue.componentId) && typeof issue.problem === "string").map((issue: any) => ({ componentId: issue.componentId, problem: clip(issue.problem, 1200), suggestedFix: clip(issue.suggestedFix || "", 1200) })) : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((x: unknown) => typeof x === "string").slice(0, 10).map((x: string) => clip(x, 400)) : [];
  return { status: raw.status === "needs_repair" && issues.length ? "needs_repair" : "pass", issues, warnings };
}

function retryDelayMs(cycles: number): number {
  const minutes = Math.min(60, 2 * Math.pow(2, Math.max(0, Math.min(cycles - 1, 5))));
  return minutes * 60_000;
}

function addFailure(progress: Progress, stage: string, componentId: string | undefined, model: string, failure: StageFailure): Progress {
  const history = [...(progress.recentErrors || []), { stage, componentId, model, type: failure.type, message: clip(failure.message, 700), at: new Date().toISOString() }];
  return { ...progress, recentErrors: history.slice(-MAX_RECENT_ERRORS) };
}

async function archiveMessage(db: any, msgId: number) {
  const { error } = await db.rpc("archive_code_easier_construction", { p_msg_id: msgId });
  if (error) throw error;
}
async function enqueueJob(db: any, jobId: string) {
  const { error } = await db.rpc("enqueue_code_easier_construction", { p_job_id: jobId });
  if (error) throw error;
}
async function deferMessage(db: any, msgId: number, delaySeconds: number) {
  const { error } = await db.rpc("defer_code_easier_construction_message", { p_msg_id: msgId, p_delay_seconds: delaySeconds });
  if (error) throw error;
}

Deno.serve(withSupabase({ auth: "secret" }, async (req, ctx) => {
  if (req.method !== "POST") return jsonResponse({ success: false, error: "Please use POST." }, 405);
  const workerSecret = Deno.env.get("CODE_EASIER_WORKER_SECRET");
  if (!workerSecret || req.headers.get("x-code-easier-worker-secret") !== workerSecret) return jsonResponse({ success: false, error: "Worker authentication failed." }, 401);

  const db = ctx.supabaseAdmin;
  let msgId: number | null = null;
  try {
    const { data: messages, error: claimError } = await db.rpc("claim_code_easier_construction_job");
    if (claimError) throw claimError;
    if (!messages || messages.length === 0) return jsonResponse({ success: true, processed: false, message: "No construction jobs are waiting." });

    const message = messages[0];
    msgId = Number(message.msg_id);
    const jobId = message.job_id;
    if (!jobId || !Number.isFinite(msgId)) throw new Error("The queue message is invalid.");

    const { data: job, error: jobError } = await db.from("code_easier_construction_jobs").select("*").eq("id", jobId).maybeSingle();
    if (jobError) throw jobError;
    if (!job) { await archiveMessage(db, msgId); return jsonResponse({ success: false, processed: true, message: "Construction job does not exist." }); }
    if (job.status === "completed" || job.status === "failed") { await archiveMessage(db, msgId); return jsonResponse({ success: true, processed: false, message: "Job is already finished." }); }

    let progress: Progress = job.progress && typeof job.progress === "object" ? { ...job.progress } : {};
    const now = Date.now();
    if (progress.nextRetryAt && Date.parse(progress.nextRetryAt) > now) {
      const waitSeconds = Math.max(30, Math.ceil((Date.parse(progress.nextRetryAt) - now) / 1000));
      await deferMessage(db, msgId, Math.min(waitSeconds, 86_400));
      return jsonResponse({ success: true, processed: false, status: "queued", nextRetryAt: progress.nextRetryAt, message: "The job is safely waiting for its scheduled retry." });
    }

    // Recover abandoned processing jobs; defer duplicate messages while a live worker owns the job.
    if (job.status === "processing") {
      const age = now - Date.parse(job.updated_at || job.created_at || new Date().toISOString());
      if (age < LEASE_MS) {
        await deferMessage(db, msgId, Math.max(30, Math.ceil((LEASE_MS - age) / 1000)));
        return jsonResponse({ success: true, processed: false, message: "Another worker currently owns this job; this queue message has been deferred." });
      }
      const cutoff = new Date(now - LEASE_MS).toISOString();
      const { data: recovered, error: recoverError } = await db.from("code_easier_construction_jobs").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "processing").lt("updated_at", cutoff).select("id").maybeSingle();
      if (recoverError) throw recoverError;
      if (!recovered) { await deferMessage(db, msgId, 60); return jsonResponse({ success: true, processed: false, message: "Job ownership changed; queue message deferred." }); }
    }

    const { data: claimed, error: startError } = await db.from("code_easier_construction_jobs").update({ status: "processing", attempts: Number(job.attempts || 0) + 1, updated_at: new Date().toISOString() }).eq("id", jobId).eq("status", "queued").select("id").maybeSingle();
    if (startError) throw startError;
    if (!claimed) { await deferMessage(db, msgId, 60); return jsonResponse({ success: true, processed: false, message: "Could not acquire the job; queue message deferred." }); }

    const stage: Stage = progress.stage || "planning";
    if (!STAGES.includes(stage)) throw new Error(`Saved construction stage is invalid: ${stage}`);
    const modelIndex = Number(progress.modelIndex || 0);
    const model = MODELS[modelIndex];
    if (!model) throw new Error("Saved Gemini model position is invalid.");
    let next: Progress = { ...progress };
    let componentId: string | undefined;

    try {
      if (stage === "planning") {
        next = await planProject(job.project_name, job.description, model);
      } else if (stage === "components") {
        const records = [...(progress.components || [])];
        const index = records.findIndex((item) => item.status !== "completed");
        if (index < 0) { next = { ...progress, stage: "integrating", modelIndex: 0, retryCycles: 0, nextRetryAt: null }; }
        else {
          componentId = records[index].plan.id;
          const output = await generateComponent(job.project_name, job.description, progress, records[index], model);
          records[index] = { ...records[index], status: "completed", output };
          next = { ...progress, components: records, componentIndex: index + 1, modelIndex: 0, retryCycles: 0, nextRetryAt: null };
          if (records.every((item) => item.status === "completed")) next.stage = "integrating";
        }
      } else if (stage === "integrating") {
        // Local assembly is deterministic and does not consume another AI request.
        const files = collectFiles(job.project_name, progress, false);
        if (!files.some((file) => file.path === "index.html")) throw new Error("Integration could not produce an index.html preview.");
        next = { ...progress, stage: "reviewing", modelIndex: 0, retryCycles: 0, nextRetryAt: null };
      } else if (stage === "reviewing") {
        const review = await reviewProject(job.project_name, job.description, progress, model);
        if (review.status === "needs_repair" && (progress.repairCount || 0) < MAX_REPAIRS) {
          const issue = review.issues[0];
          next = { ...progress, stage: "repairing", repairTargetId: issue.componentId, repairProblem: `${issue.problem} ${issue.suggestedFix || ""}`.trim(), reviewWarnings: review.warnings, modelIndex: 0, retryCycles: 0, nextRetryAt: null };
        } else {
          next = { ...progress, stage: "finalizing", reviewStatus: review.status === "pass" ? "passed" : "warnings", reviewWarnings: [...review.warnings, ...(review.issues.map((issue) => `${issue.componentId}: ${issue.problem}`))], modelIndex: 0, retryCycles: 0, nextRetryAt: null };
        }
      } else if (stage === "repairing") {
        const records = [...(progress.components || [])];
        const index = records.findIndex((item) => item.plan.id === progress.repairTargetId);
        if (index < 0) throw new Error("The component selected for repair no longer exists.");
        componentId = records[index].plan.id;
        const output = await generateComponent(job.project_name, job.description, progress, records[index], model, progress.repairProblem || "Repair the component while preserving its intended functionality.");
        records[index] = { ...records[index], status: "completed", output };
        next = { ...progress, components: records, stage: "reviewing", repairCount: (progress.repairCount || 0) + 1, repairTargetId: undefined, repairProblem: undefined, modelIndex: 0, retryCycles: 0, nextRetryAt: null };
      } else if (stage === "finalizing") {
        const files = collectFiles(job.project_name, progress, true);
        const previewHtml = files.find((file) => file.path === "index.html")?.content || "";
        if (!previewHtml || !/<html[\s>]/i.test(previewHtml) || !/<\/html>/i.test(previewHtml)) throw new Error("Final project integration did not produce valid HTML.");
        const backendFileCount = files.filter((file) => file.path !== "index.html").length;
        const result = {
          success: true, message: "CODE EASIER has completed project generation.", projectName: job.project_name,
          projectType: progress.projectType || "custom_project", summary: progress.summary || "Project generated by CODE EASIER.",
          constructionStatus: "generated", testStatus: progress.reviewStatus === "passed" ? "ai_review_passed" : "completed_with_review_warnings",
          previewHtml, files, testChecklist: progress.testChecklist || [], reviewWarnings: progress.reviewWarnings || [],
          reviewNote: "The AI review is a source-code review, not an automated browser execution test. Test the preview before relying on it.",
          backendStatus: progress.requiresBackend
            ? `${backendFileCount} supporting/backend source file(s) generated. These files have not been deployed as a live server backend or connected to a database.`
            : "No separate server backend was specified by the project plan.",
          publishingOptions: { website: { available: false, status: "publishing_integration_not_yet_implemented" }, phoneApp: { available: false, status: "app_packaging_integration_not_yet_implemented" } }
        };
        const { error: finishError } = await db.from("code_easier_construction_jobs").update({ status: "completed", result, progress: { ...progress, stage: "completed", nextRetryAt: null }, error_message: null, updated_at: new Date().toISOString() }).eq("id", jobId);
        if (finishError) throw finishError;
        await archiveMessage(db, msgId);
        return jsonResponse({ success: true, processed: true, jobId, status: "completed", fileCount: files.length });
      }
    } catch (error) {
      const failure = error instanceof StageError ? error.failure : { type: "STAGE_ERROR", message: clip(error instanceof Error ? error.message : error), stop: false };
      next = addFailure(progress, stage, componentId, model, failure);
      if (failure.stop) {
        const { error: failError } = await db.from("code_easier_construction_jobs").update({ status: "failed", progress: next, error_message: `${stage}${componentId ? `/${componentId}` : ""} using ${model}: ${failure.type}: ${failure.message}`, updated_at: new Date().toISOString() }).eq("id", jobId);
        if (failError) throw failError;
        await archiveMessage(db, msgId);
        return jsonResponse({ success: false, processed: true, jobId, status: "failed", failureType: failure.type, error: failure.message });
      }

      // A daily quota is provider-wide: preserve the same task and wait six hours.
      if (failure.type === "DAILY_QUOTA_EXHAUSTED") {
        const delay = failure.retryAfterMs || 6 * 60 * 60 * 1000;
        const retryAt = new Date(Date.now() + delay).toISOString();
        next = { ...next, nextRetryAt: retryAt };
        const { error: pauseError } = await db.from("code_easier_construction_jobs").update({ status: "queued", progress: next, error_message: `${stage}: daily Gemini quota reached. Next attempt scheduled for ${retryAt}.`, updated_at: new Date().toISOString() }).eq("id", jobId);
        if (pauseError) throw pauseError;
        await deferMessage(db, msgId, Math.ceil(delay / 1000));
        return jsonResponse({ success: true, processed: true, jobId, status: "queued", nextRetryAt: retryAt, message: "Daily quota reached; construction is paused and scheduled to resume." });
      }

      const nextModelIndex = (modelIndex + 1) % MODELS.length;
      const wrapped = nextModelIndex === 0;
      const retryCycles = Number(progress.retryCycles || 0) + (wrapped ? 1 : 0);
      next = { ...next, modelIndex: nextModelIndex, retryCycles };
      if (wrapped) {
        const delay = retryDelayMs(retryCycles);
        const retryAt = new Date(Date.now() + delay).toISOString();
        next.nextRetryAt = retryAt;
        const { error: retryError } = await db.from("code_easier_construction_jobs").update({ status: "queued", progress: next, error_message: `${stage}${componentId ? `/${componentId}` : ""} using ${model}: ${failure.type}: ${failure.message}. All Gemini models were tried; retry cycle ${retryCycles} is scheduled for ${retryAt}.`, updated_at: new Date().toISOString() }).eq("id", jobId);
        if (retryError) throw retryError;
        await deferMessage(db, msgId, Math.ceil(delay / 1000));
        return jsonResponse({ success: true, processed: true, jobId, status: "queued", stage, retryCycles, nextRetryAt: retryAt, message: "All configured Gemini models failed temporarily. The same queue message is scheduled for a later retry." });
      }
      next.nextRetryAt = null;
      const { error: retryError } = await db.from("code_easier_construction_jobs").update({ status: "queued", progress: next, error_message: `${stage}${componentId ? `/${componentId}` : ""} using ${model}: ${failure.type}: ${failure.message}. Next model: ${MODELS[nextModelIndex]}.`, updated_at: new Date().toISOString() }).eq("id", jobId);
      if (retryError) throw retryError;
      await enqueueJob(db, jobId);
      await archiveMessage(db, msgId);
      return jsonResponse({ success: true, processed: true, jobId, status: "queued", stage, failedModel: model, nextModel: MODELS[nextModelIndex], retryCycles, message: "Temporary failure recorded; the same task will be attempted with the next Gemini model." });
    }

    // Save every successful checkpoint. Update the intermediate preview after every component.
    const previewResult = makeIntermediateResult(job.project_name, next);
    const { error: saveError } = await db.from("code_easier_construction_jobs").update({ status: "queued", progress: next, result: previewResult, error_message: null, updated_at: new Date().toISOString() }).eq("id", jobId);
    if (saveError) throw saveError;
    await enqueueJob(db, jobId);
    await archiveMessage(db, msgId);
    return jsonResponse({ success: true, processed: true, jobId, status: "queued", completedStage: stage, nextStage: next.stage, progress: makeProgressSummary(next), message: "Construction checkpoint saved; the next task has been queued." });
  } catch (error) {
    console.error("CODE EASIER modular worker error:", error);
    return jsonResponse({ success: false, processed: false, error: clip(error instanceof Error ? error.message : error) }, 500);
  }
}));
