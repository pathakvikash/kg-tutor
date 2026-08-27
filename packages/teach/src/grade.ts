import { z } from "zod";
import { completeJson, type LLMProvider } from "@kg/llm";
import { failureDiagnosis, type FailureDiagnosis } from "@kg/shared";

export interface GradeInput {
  /** The item's prompt. NOT the explanation the learner just read. */
  prompt: string;
  /** The snippet the question is about; pass it or the grader sees a prompt with no code. */
  code?: string | null;
  codeLanguage?: string | null;
  response: string;
  /** Stored failure modes on this concept's hard prerequisite edges. (03, 07) */
  failureModes: { edgeId: string; prerequisiteName: string; failureMode: string }[];
  /** Named so the grader can tell "restated the definition" from "applied it". */
  conceptName: string;
  /** True when the item deliberately uses a context the explanation did not. (16) */
  requiresTransfer: boolean;
}

export interface GradeResult {
  correct: boolean;
  /** Only meaningful when `correct` is false. */
  diagnosis: FailureDiagnosis;
  /** Set when the response exhibited one of the stored failure modes. */
  matchedEdgeId: string | null;
  /** The learner's actual wrong belief, when one was visible. */
  belief: string | null;
  /** True when the answer only restates the concept rather than applying it. */
  restatementOnly: boolean;
  reasoning: string;
}

const schema = z.object({
  correct: z.boolean(),
  /** Nullable, because the prompt asks for a diagnosis only when the answer is incorrect. */
  diagnosis: failureDiagnosis.nullable().default(null),
  matchedFailureModeIndex: z.number().int().nullable(),
  belief: z.string().nullable(),
  restatementOnly: z.boolean(),
  reasoning: z.string(),
});

/** The grader stays blind to the preceding explanation; nothing here may carry it. (16) */
export const GRADE_SYSTEM_PROMPT = `You grade a learner's answer against a rubric. You have NOT seen any explanation the learner was given, and you must not assume one.

You are given the question, the learner's answer, and a numbered list of known failure
modes — specific wrong beliefs learners hold about this concept.

Decide:
- correct: does the answer demonstrate real understanding of what was asked?
- restatementOnly: does the answer merely restate a definition without applying it?
  An answer that repeats the concept back in different words is NOT an application.
- matchedFailureModeIndex: if the answer exhibits one of the listed failure modes,
  its index. Otherwise null. Only match when the answer really shows that belief.
- belief: if the answer reveals a specific wrong belief, state it in one sentence as
  the learner would hold it. Otherwise null.
- diagnosis: ONLY when incorrect. Use null when the answer is correct.
  - "misconception": exhibits a specific wrong belief
  - "missing_prerequisite": confused about something the concept builds on
  - "cannot_apply": understands the idea but cannot use it
  - "careless": essentially right, with a slip

reasoning: this is shown to the learner, so write it TO them in the second person —
"you traced the microtask queue correctly, but the timer fires after it drains", not
"the learner correctly traced". One or two sentences. Name the specific thing they got
right or wrong; do not summarise their answer back to them, and do not pad it.

Do not be generous. An answer that sounds fluent but does not answer the question is
incorrect.

Respond with JSON: {"correct","diagnosis","matchedFailureModeIndex","belief","restatementOnly","reasoning"}`;

export async function gradeResponse(
  llm: LLMProvider,
  input: GradeInput,
): Promise<GradeResult> {
  const modes = input.failureModes
    .map((f, i) => `${i}. (missing "${f.prerequisiteName}") ${f.failureMode}`)
    .join("\n");

  const user = [
    `Concept under test: ${input.conceptName}`,
    input.requiresTransfer
      ? `This question deliberately uses an unfamiliar context. Recall alone is not enough.`
      : "",
    "",
    `Question:\n${input.prompt}`,
    input.code ? `\nThe code the question refers to (${input.codeLanguage ?? "code"}):\n${input.code}` : "",
    "",
    `Learner's answer:\n${input.response}`,
    "",
    `Known failure modes:\n${modes || "(none recorded)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Small tier: a larger model reinterprets a bad answer charitably. (17)
  const raw = await completeJson(
    llm,
    { system: GRADE_SYSTEM_PROMPT, user, tier: "small", temperature: 0 },
    schema,
  );

  const idx = raw.matchedFailureModeIndex;
  const matched =
    idx !== null && idx >= 0 && idx < input.failureModes.length
      ? input.failureModes[idx]!
      : null;

  return {
    correct: raw.correct,
    // Placeholder: nothing downstream reads a diagnosis off a passing answer.
    diagnosis: raw.diagnosis ?? "careless",
    matchedEdgeId: matched?.edgeId ?? null,
    belief: raw.belief,
    restatementOnly: raw.restatementOnly,
    reasoning: raw.reasoning,
  };
}
