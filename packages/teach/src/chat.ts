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
  reasoning: z.string(),
});

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

If the intent is "prerequisite_gap", set prerequisiteIndex to the matching entry in the
prerequisite list, or null if the learner named something not on it. Set namedConcept to
what they actually asked about, in their words.

Respond with JSON: {"intent","prerequisiteIndex","namedConcept","reasoning"}`;

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
    prerequisiteConceptId: matched?.conceptId ?? null,
    namedConcept: raw.namedConcept,
    reasoning: raw.reasoning,
  };
}

/** Only one of the four intents may change what the system believes. (19) */
export function touchesLearnerModel(intent: ChatIntent): boolean {
  return intent === "prerequisite_gap" || intent === "clarifies_current";
}
