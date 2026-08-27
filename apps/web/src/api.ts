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

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
async function send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  // Declaring a JSON content-type with no body makes Fastify reject the request
  // outright, so the header only goes on when there is something to send.
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    let detail = await res.text();
    try {
      const body = JSON.parse(detail);
      // The remedy is the whole point of an auth failure; dropping it leaves the user
      // with a problem statement and no next step.
      detail = [body.error, body.remedy].filter(Boolean).join(" — ") || detail;
    } catch { /* keep the raw text */ }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

const post = <T>(url: string, body?: unknown) => send<T>("POST", url, body);
const del = <T>(url: string) => send<T>("DELETE", url);

export interface AskStreamHandlers {
  /** The answer is starting. Fires before routing lands, so deltas have somewhere to go. */
  onOpen?: (d: any) => void;
  onRouted?: (info: any) => void;
  onDelta?: (text: string) => void;
  onDone?: (answer: string | null) => void;
  onFailed?: (error: string) => void;
}

/**
 * Server-sent events over POST, so the request can carry a body.
 *
 * EventSource would be simpler but is GET-only, which would mean putting the learner's
 * question in a query string. A fetch reader costs a few more lines and keeps it in the
 * body where it belongs.
 */
export async function askStream(
  learnerId: string,
  conceptId: string,
  question: string,
  handlers: AskStreamHandlers,
): Promise<void> {
  const res = await fetch("/api/lesson/ask/stream", {
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

    // Events are separated by a blank line; a partial trailing event stays buffered.
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
  /** The language every example and item should be written in. */
  updateLearner: (id: string, patch: Record<string, unknown>) =>
    send<any>("PATCH", `/api/learners/${id}`, patch),
  /** What has decayed, was never demonstrated, or has an unresolved misconception. */
  due: (id: string, limit = 20) => get<any>(`/api/learners/${id}/due?limit=${limit}`),
  /** One more level of prerequisites under a single concept. */
  deepen: (conceptId: string) => post<any>(`/api/concepts/${conceptId}/deepen`, {}),
  setGoal: (id: string, topicId: string, depth: string) =>
    post<any>(`/api/learners/${id}/goals`, { topicId, depth }),
  rebuildPlan: (id: string) => post<any>(`/api/learners/${id}/plan/rebuild`),
  metrics: () => get<any>("/api/metrics"),
  reviewQueue: () => get<any[]>("/api/review/queue"),
  proposals: () => get<any[]>("/api/review/proposals"),
  negative: () => get<any>("/api/review/negative"),
  scan: () => post<any>("/api/review/scan"),
  explain: (learnerId: string, conceptId: string) =>
    post<any>("/api/lesson/explain", { learnerId, conceptId }),
  check: (learnerId: string, conceptId: string, level = "functional") =>
    post<any>("/api/lesson/check", { learnerId, conceptId, level }),
  ask: (learnerId: string, conceptId: string, question: string) =>
    post<any>("/api/lesson/ask", { learnerId, conceptId, question }),
  attempt: (learnerId: string, payload: Record<string, unknown>) =>
    post<any>(`/api/learners/${learnerId}/attempt`, payload),
  transcript: (learnerId: string) => get<any>(`/api/lesson/${learnerId}/transcript`),
  resetLesson: (learnerId: string) => post<any>(`/api/lesson/${learnerId}/reset`),
  completeStep: (learnerId: string, conceptId: string) =>
    post<any>(`/api/learners/${learnerId}/steps/${conceptId}/complete`),
  startExpansion: (topicName: string, description?: string) =>
    post<any>("/api/expansions", { topicName, description }),
  expansion: (id: string) => get<any>(`/api/expansions/${id}`),
  expansions: () => get<any[]>("/api/expansions"),
  /** Cheap: does an assessment exist to resume? Does not derive the question. */
  openIntake: (learnerId: string) => get<any>(`/api/intake/open/${learnerId}`),
  /** The full form, including the question to render. */
  resumeIntake: (learnerId: string) =>
    get<any>(`/api/intake/open/${learnerId}?withQuestion=1`),
  abandonIntake: (id: string) => post<any>(`/api/intake/${id}/abandon`),
  retryExpansion: (id: string) => post<any>(`/api/expansions/${id}/retry`),
  startIntake: (payload: Record<string, unknown>) => post<any>("/api/intake/start", payload),
  answerIntake: (id: string, answer: string) => post<any>(`/api/intake/${id}/answer`, { answer }),
  sessions: (learnerId: string) => get<any[]>(`/api/learners/${learnerId}/sessions`),
  sessionTranscript: (id: string) => get<any>(`/api/sessions/${id}/transcript`),
  resumeSession: (id: string) => post<any>(`/api/sessions/${id}/resume`),
  modelSettings: () => get<any>("/api/settings/model"),
  setModel: (payload: Record<string, unknown>) => send<any>("PUT", "/api/settings/model", payload),
  deleteSession: (id: string) => del<any>(`/api/sessions/${id}`),
  deleteAllSessions: (learnerId: string) => del<any>(`/api/learners/${learnerId}/sessions`),
  widget: (learnerId: string, conceptId: string, focus?: string) =>
    post<any>("/api/lesson/widget", { learnerId, conceptId, focus }),
  resolveGoal: (goal: string) => post<any>("/api/roadmap/resolve", { goal }),
  createOutcome: (payload: Record<string, unknown>) => post<any>("/api/roadmap/outcome", payload),
  roadmap: (learnerId: string) => get<any>(`/api/roadmap/${learnerId}`),
  acceptProposal: (id: string, failureMode: string) =>
    post<any>(`/api/review/proposals/${id}/accept`, { failureMode, reviewedBy: "reviewer" }),
  rejectProposal: (id: string) => post<any>(`/api/review/proposals/${id}/reject`, { reviewedBy: "reviewer" }),
};

export const MASTERY_ORDER: Mastery[] = ["unknown", "familiar", "functional", "solid"];
