import { llmHeaders, type LlmConfig } from "./llmConfig";

export type TierResult = { ok: true; ms: number } | { ok: false; error: string };

export interface GraphNode {
  id: string;
  name: string;
  sense: string;
  aliases: string[];
  topics: { id: string; name: string; direct: boolean }[];
  state: { mastery: Mastery; confidence: number; source: string } | null;
}
export type Mastery = "unknown" | "familiar" | "functional" | "solid";
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  strength: "hard" | "soft";
  failureMode: string | null;
  confidence: number;
  provisional: boolean;
}
export interface GraphPayload {
  topics: { id: string; name: string; kind: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly remedy: string | null = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
  get isMissing(): boolean { return this.status === 404; }
}

const BY_STATUS: Record<number, string> = {
  400: "The server did not accept that request.",
  401: "You are not signed in for that.",
  403: "That is not allowed here.",
  404: "That was not found.",
  408: "The server took too long to answer.",
  429: "Too many requests. Wait a moment and try again.",
  504: "The server took too long to answer.",
};

const messageFor = (status: number): string =>
  BY_STATUS[status] ??
  (status >= 500 ? "The server had a problem. Try again in a minute." : `The request failed (${status}).`);

/** Zod flatten() shape, turned into a sentence */
function fieldMessage(e: unknown): string | null {
  const { formErrors = [], fieldErrors = {} } = (e ?? {}) as {
    formErrors?: string[];
    fieldErrors?: Record<string, string[]>;
  };
  const parts = [
    ...formErrors,
    ...Object.entries(fieldErrors).map(([f, m]) => `${f}: ${m.join(", ")}`),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Only JSON from our API is shown; HTML or plain bodies get a sentence by status */
export async function failure(res: Response): Promise<HttpError> {
  const text = await res.text();
  let body: { error?: unknown; remedy?: unknown; detail?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch { /* not JSON */ }
  const error = typeof body.error === "string" ? body.error : fieldMessage(body.error);
  const note = typeof body.remedy === "string" ? body.remedy : typeof body.detail === "string" ? body.detail : null;
  if (res.status === 503 && error?.startsWith("no model configured")) {
    return new HttpError(503, "Add your API key in Settings.");
  }
  return new HttpError(res.status, error || messageFor(res.status), error ? note : null);
}

/** "message. remedy" for places that show one string */
export const joinMessage = (message: string, remedy?: string | null): string =>
  remedy ? `${message}${/[.!?]$/.test(message) ? "" : "."} ${remedy}` : message;

/** Empty in dev, where Vite proxies /api; the Render URL in a Vercel build */
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export const apiUrl = (path: string): string => `${API_BASE}${path}`;

/** A fetch that cannot connect throws TypeError; aborts pass through untouched */
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(apiUrl(url), init);
  } catch (e) {
    if (e instanceof TypeError) throw new HttpError(0, "The server is not answering. Try again in a minute.");
    throw e;
  }
}

async function get<T>(url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<T> {
  const res = await request(url, { headers, ...(signal ? { signal } : {}) });
  if (!res.ok) throw await failure(res);
  return res.json() as Promise<T>;
}
async function send<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  // Fastify rejects a JSON content-type sent with no body
  const res = await request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...llmHeaders(),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await failure(res);
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export const ADMIN_TOKEN_KEY = "kg-admin-token";

/** Sends the admin token saved in Settings, if any; a 403 points the user there */
async function adminSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch { /* blocked storage: send without a token */ }
  try {
    return await send<T>(method, url, body, token ? { authorization: `Bearer ${token}` } : {});
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      throw new HttpError(
        403,
        "Admin only in the public demo.",
        "If you are the admin, enter the token in Settings, under Server default (admin).",
      );
    }
    throw e;
  }
}

const post = <T>(url: string, body?: unknown) => send<T>("POST", url, body);

export interface AskStreamHandlers {
  onOpen?: (d: any) => void;
  onRouted?: (info: any) => void;
  onDelta?: (text: string) => void;
  onDone?: (answer: string | null) => void;
  onFailed?: (error: string) => void;
}

/** SSE read by hand: EventSource is GET-only and the question belongs in a body */
export async function askStream(
  learnerId: string,
  conceptId: string,
  question: string,
  handlers: AskStreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await request("/api/lesson/ask/stream", {
      method: "POST",
      headers: { "content-type": "application/json", ...llmHeaders() },
      body: JSON.stringify({ learnerId, conceptId, question }),
    });
  } catch (e) {
    handlers.onFailed?.(e instanceof Error ? e.message : String(e));
    return;
  }
  if (!res.ok || !res.body) {
    const f = await failure(res);
    handlers.onFailed?.(joinMessage(f.message, f.remedy));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = /^event: (.+)$/m.exec(part)?.[1];
      const raw = /^data: (.+)$/m.exec(part)?.[1];
      if (!event || !raw) continue;
      let data: any;
      try { data = JSON.parse(raw); } catch { continue; }
      if (event === "open") handlers.onOpen?.(data);
      else if (event === "routed") handlers.onRouted?.(data);
      else if (event === "delta") handlers.onDelta?.(data.text ?? "");
      else if (event === "done") handlers.onDone?.(data.answer ?? null);
      else if (event === "failed") {
        handlers.onFailed?.(joinMessage(String(data.error ?? ""), data.remedy));
      }
    }
  }
}

export const DUE_LIMIT = 25;

export const api = {
  graph: (params: { topicId?: string; learnerId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.topicId) q.set("topicId", params.topicId);
    if (params.learnerId) q.set("learnerId", params.learnerId);
    const s = q.toString();
    return get<GraphPayload>(`/api/graph${s ? `?${s}` : ""}`);
  },
  concept: (id: string) => get<any>(`/api/concepts/${id}`),
  topics: () => get<any[]>("/api/topics"),
  learners: () => get<any[]>("/api/learners"),
  learnerState: (id: string) => get<any>(`/api/learners/${id}/state`),
  /** null when the learner has no plan yet */
  plan: async (id: string) => {
    const p = await get<any>(`/api/learners/${id}/plan`);
    return p?.plan === null ? null : p;
  },
  updateLearner: (id: string, patch: Record<string, unknown>) =>
    send<any>("PATCH", `/api/learners/${id}`, patch),
  due: (id: string, limit = DUE_LIMIT) => get<any>(`/api/learners/${id}/due?limit=${limit}`),
  deepen: (conceptId: string) => adminSend<any>("POST", `/api/concepts/${conceptId}/deepen`, {}),
  setGoal: (id: string, topicId: string, depth: string) =>
    post<any>(`/api/learners/${id}/goals`, { topicId, depth }),
  rebuildPlan: (id: string) => post<any>(`/api/learners/${id}/plan/rebuild`),
  metrics: () => get<any>("/api/metrics"),
  reviewQueue: () => get<any[]>("/api/review/queue"),
  proposals: () => get<any[]>("/api/review/proposals"),
  negative: () => get<any>("/api/review/negative"),
  scan: () => adminSend<any>("POST", "/api/review/scan"),
  explain: (learnerId: string, conceptId: string) =>
    post<any>("/api/lesson/explain", { learnerId, conceptId }),
  /** `kind` picks which transcript this is written into; a review pass must say "review" */
  check: (learnerId: string, conceptId: string, level = "functional", kind: "lesson" | "review" = "lesson") =>
    post<any>("/api/lesson/check", { learnerId, conceptId, level, kind }),
  ask: (learnerId: string, conceptId: string, question: string) =>
    post<any>("/api/lesson/ask", { learnerId, conceptId, question }),
  attempt: (learnerId: string, payload: Record<string, unknown>) =>
    post<any>(`/api/learners/${learnerId}/attempt`, payload),
  transcript: (learnerId: string) => get<any>(`/api/lesson/${learnerId}/transcript`),
  resetLesson: (learnerId: string) => post<any>(`/api/lesson/${learnerId}/reset`),
  completeStep: (learnerId: string, conceptId: string) =>
    post<any>(`/api/learners/${learnerId}/steps/${conceptId}/complete`),
  startExpansion: (topicName: string, description?: string) =>
    adminSend<any>("POST", "/api/expansions", { topicName, description }),
  expansion: (id: string) => get<any>(`/api/expansions/${id}`),
  expansions: () => get<any[]>("/api/expansions"),
  openIntake: (learnerId: string) => get<any>(`/api/intake/open/${learnerId}`),
  resumeIntake: (learnerId: string) =>
    get<any>(`/api/intake/open/${learnerId}?withQuestion=1`, undefined, llmHeaders()),
  abandonIntake: (id: string) => post<any>(`/api/intake/${id}/abandon`),
  retryExpansion: (id: string) => adminSend<any>("POST", `/api/expansions/${id}/retry`),
  startIntake: (payload: Record<string, unknown>) => post<any>("/api/intake/start", payload),
  answerIntake: (id: string, answer: string) => post<any>(`/api/intake/${id}/answer`, { answer }),
  sessions: (learnerId: string) => get<any[]>(`/api/learners/${learnerId}/sessions`),
  sessionTranscript: (id: string) => get<any>(`/api/sessions/${id}/transcript`),
  resumeSession: (id: string) => post<any>(`/api/sessions/${id}/resume`),
  llmModels: (cfg: Pick<LlmConfig, "provider" | "baseUrl" | "apiKey">) =>
    send<{ models: string[] }>("POST", "/api/llm/models", cfg),
  llmTest: (cfg: LlmConfig) =>
    send<{ small: TierResult; strong: TierResult }>("POST", "/api/llm/test", cfg),
  modelSettings: () => get<any>("/api/settings/model"),
  setModel: (payload: Record<string, unknown>) => adminSend<any>("PUT", "/api/settings/model", payload),
  deleteSession: (id: string) => adminSend<any>("DELETE", `/api/sessions/${id}`),
  deleteAllSessions: (learnerId: string) =>
    adminSend<any>("DELETE", `/api/learners/${learnerId}/sessions`),
  widget: (learnerId: string, conceptId: string, focus?: string) =>
    post<any>("/api/lesson/widget", { learnerId, conceptId, focus }),
  resolveGoal: (goal: string) => post<any>("/api/roadmap/resolve", { goal }),
  createOutcome: (payload: Record<string, unknown>) => adminSend<any>("POST", "/api/roadmap/outcome", payload),
  roadmap: (learnerId: string) => get<any>(`/api/roadmap/${learnerId}`),
  acceptProposal: (id: string, failureMode: string) =>
    adminSend<any>("POST", `/api/review/proposals/${id}/accept`, { failureMode, reviewedBy: "reviewer" }),
  rejectProposal: (id: string) =>
    adminSend<any>("POST", `/api/review/proposals/${id}/reject`, { reviewedBy: "reviewer" }),
  reverseProposal: (id: string, reason: string) =>
    adminSend<{ retired: number }>("POST", `/api/review/proposals/${id}/reverse`, { reason }),
};

export const MASTERY_ORDER: Mastery[] = ["unknown", "familiar", "functional", "solid"];
