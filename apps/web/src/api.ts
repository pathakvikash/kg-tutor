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

async function failure(res: Response): Promise<HttpError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: unknown; remedy?: string; detail?: string };
    const message =
      typeof body.error === "string"
        ? body.error
        : body.error
          ? JSON.stringify(body.error)
          : body.detail ?? text;
    return new HttpError(res.status, message || `HTTP ${res.status}`, body.remedy ?? null);
  } catch {
    return new HttpError(res.status, text || `HTTP ${res.status}`);
  }
}

/** Empty in dev, where Vite proxies /api; the Render URL in a Vercel build */
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
export const apiUrl = (path: string): string => `${API_BASE}${path}`;

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(url), signal ? { signal } : {});
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
  const res = await fetch(apiUrl(url), {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await failure(res);
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

/** Retries once with a prompted admin token; refuses plainly when none works */
async function adminSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const attempt = (token: string | null) =>
    send<T>(method, url, body, token ? { authorization: `Bearer ${token}` } : {});
  const refused = new HttpError(403, "Admin only in the public demo");
  try {
    return await attempt(sessionStorage.getItem("kg-admin-token"));
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 403) throw e;
    const entered = window.prompt("Admin token");
    if (!entered) throw refused;
    sessionStorage.setItem("kg-admin-token", entered);
    try {
      return await attempt(entered);
    } catch (e2) {
      if (e2 instanceof HttpError && e2.status === 403) throw refused;
      throw e2;
    }
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
  const res = await fetch(apiUrl("/api/lesson/ask/stream"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ learnerId, conceptId, question }),
  });
  if (!res.ok || !res.body) {
    let detail = await res.text();
    try {
      const b = JSON.parse(detail);
      detail = [b.error, b.remedy].filter(Boolean).join(" — ") || detail;
    } catch { /* keep raw */ }
    handlers.onFailed?.(detail || `HTTP ${res.status}`);
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
        handlers.onFailed?.([data.error, data.remedy].filter(Boolean).join(" — "));
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
  plan: (id: string) => get<any>(`/api/learners/${id}/plan`),
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
    get<any>(`/api/intake/open/${learnerId}?withQuestion=1`),
  abandonIntake: (id: string) => post<any>(`/api/intake/${id}/abandon`),
  retryExpansion: (id: string) => adminSend<any>("POST", `/api/expansions/${id}/retry`),
  startIntake: (payload: Record<string, unknown>) => post<any>("/api/intake/start", payload),
  answerIntake: (id: string, answer: string) => post<any>(`/api/intake/${id}/answer`, { answer }),
  sessions: (learnerId: string) => get<any[]>(`/api/learners/${learnerId}/sessions`),
  sessionTranscript: (id: string) => get<any>(`/api/sessions/${id}/transcript`),
  resumeSession: (id: string) => post<any>(`/api/sessions/${id}/resume`),
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
