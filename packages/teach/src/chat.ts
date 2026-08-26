import { z } from "zod";
import { completeJson, type LLMProvider } from "@kg/llm";
import { chatIntent, type ChatIntent } from "@kg/shared";

export interface ChatRouteInput {
  question: string;
  currentConceptName: string;
  /** Names of the current concept's prerequisites, so a gap can be pinned to one. */
  prerequisiteNames: { conceptId: string; name: string }[];
}

export interface ChatRoute {
  intent: ChatIntent;
  /** The question deserves a diagram or a simulation, not only a paragraph. */
  wantsVisual: boolean;
  /** For `prerequisite_gap`: which prerequisite, when it matched a known one. */
  prerequisiteConceptId: string | null;
  /** The concept the learner named, even when it is not a known prerequisite. */
  namedConcept: string | null;
  reasoning: string;
}

const schema = z.object({
  intent: chatIntent,
  prerequisiteIndex: z.number().int().nullable(),
  namedConcept: z.string().nullable(),
  /**
   * The question is about structure, mechanism or life cycle — "what is the
   * architecture of X", "what moves where", "walk me through what happens".
   * Answering that in prose is a worse answer than showing it.
   */
  wantsVisual: z.boolean().default(false),
  reasoning: z.string(),
});

/**
 * This call gates the whole chat response: nothing can be shown to the learner until it
 * returns, because an actionable intent means the answer is discarded rather than sent.
 * So its output length is felt directly as blank screen.
 *
 * It was writing more tokens than the answer it was gating — an unbounded `reasoning`
 * essay that the API returns and the UI has never rendered. With effort-based thinking
 * doing the actual reasoning, a written rationale after it is duplication. Kept, because
 * it is worth having when something routes strangely, but capped.
 */

export const CHAT_ROUTE_SYSTEM_PROMPT = `You classify a learner's question asked during a lesson. You do not answer it.

Choose exactly one intent:
- "clarifies_current": asks about the concept currently being taught. Answering
  continues the current explanation; no new concept is involved.
- "prerequisite_gap": the learner does not know something the current concept builds
  on, and has named it ("wait, what's a callback?"). Answering would teach a DIFFERENT
  concept.
- "tangential": asks about something connected but off the current path — a later
  topic, an application, a curiosity.
- "meta": about the session, plan, progress or pacing. Not about subject matter.
- "new_goal": the learner wants to learn a different subject, or is asking for a
  roadmap, a study plan, or where to start with something. "teach me React", "how do I
  learn backend", "create a roadmap for JavaScript". This is NOT a question about the
  current concept — it is a request to go somewhere else.

If the intent is "prerequisite_gap", set prerequisiteIndex to the matching entry in the
prerequisite list, or null if the learner named something not on it. Set namedConcept to
what they actually asked about, in their words.

If the intent is "new_goal", set namedConcept to the subject they want to learn, as a
topic name — "create me a roadmap to master JS" becomes "JavaScript".

Set wantsVisual true when the question is about STRUCTURE, MECHANISM or LIFE CYCLE —
"what is the architecture of X", "what are the parts", "what moves where", "walk me
through what happens when". Those have a better answer than a paragraph.

reasoning: at most one short clause. Not a paragraph, not a restatement of the rules
above — just the deciding factor, e.g. "asks for a study plan, not about the lesson".

Respond with JSON: {"intent","prerequisiteIndex","namedConcept","wantsVisual","reasoning"}`;

/**
 * Chat never teaches — it routes into paths that already exist. (19)
 *
 * Only `prerequisite_gap` touches the learner model, and it does so through the same
 * detour machinery a failed check uses. That is what keeps the "never teach off-graph"
 * invariant true while still letting a learner ask questions.
 */
export async function routeChatQuestion(
  llm: LLMProvider,
  input: ChatRouteInput,
): Promise<ChatRoute> {
  const list = input.prerequisiteNames.map((p, i) => `${i}. ${p.name}`).join("\n");
  const raw = await completeJson(
    llm,
    {
      system: CHAT_ROUTE_SYSTEM_PROMPT,
      user: [
        `Currently teaching: ${input.currentConceptName}`,
        `Its prerequisites:\n${list || "(none)"}`,
        "",
        `Learner asked: ${input.question}`,
      ].join("\n"),
      tier: "small",
      temperature: 0,
    },
    schema,
  );

  const idx = raw.prerequisiteIndex;
  const matched =
    raw.intent === "prerequisite_gap" &&
    idx !== null &&
    idx >= 0 &&
    idx < input.prerequisiteNames.length
      ? input.prerequisiteNames[idx]!
      : null;

  return {
    intent: raw.intent,
    wantsVisual: raw.wantsVisual ?? false,
    prerequisiteConceptId: matched?.conceptId ?? null,
    namedConcept: raw.namedConcept,
    reasoning: raw.reasoning,
  };
}

/** Only these may change what the system believes about the current concept. (19) */
export function touchesLearnerModel(intent: ChatIntent): boolean {
  return intent === "prerequisite_gap" || intent === "clarifies_current";
}

/**
 * Intents the system should act on rather than answer.
 *
 * A request for a roadmap has a real answer — a plan, assessed and ordered — and
 * describing one in prose instead is the worst of both: it costs a model call and
 * leaves the learner exactly where they started.
 */
export function isActionable(intent: ChatIntent): boolean {
  return intent === "new_goal";
}
