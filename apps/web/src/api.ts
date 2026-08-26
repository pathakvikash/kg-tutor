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
async function send<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
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
  openIntake: (learnerId: string) => get<any>(`/api/intake/open/${learnerId}`),
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
