import { z } from "zod";
import { completeJson, type LLMProvider } from "@kg/llm";
import { resolverVerdict, type ResolverDecision } from "@kg/shared";
import {
  ADJUDICATION_SYSTEM_PROMPT,
  buildAdjudicationPrompt,
  trivialDecision,
  validateDecision,
  type AdjudicationInput,
  type Adjudicator,
} from "./adjudicate.js";

const schema = z.object({
  verdict: resolverVerdict,
  relatedConceptId: z.string().nullable(),
  reasoning: z.string(),
});

export interface LLMAdjudicatorOptions {
  /** Called when a returned id was never offered — worth alerting on, not just logging. */
  onDowngrade?: (input: AdjudicationInput, decision: ResolverDecision) => void;
}

/**
 * Adjudication is narrow and rubric-bound, so it runs on the small tier at
 * temperature 0 — this is a judgment that should be reproducible, not creative. (17)
 */
export class LLMAdjudicator implements Adjudicator {
  readonly name: string;

  constructor(
    private readonly llm: LLMProvider,
    private readonly opts: LLMAdjudicatorOptions = {},
  ) {
    this.name = `llm:${llm.name}`;
  }

  async adjudicate(input: AdjudicationInput): Promise<ResolverDecision> {
    const trivial = trivialDecision(input);
    if (trivial) return trivial;

    const raw = await completeJson(
      this.llm,
      {
        system: ADJUDICATION_SYSTEM_PROMPT,
        user: buildAdjudicationPrompt(input),
        tier: "small",
      // The one small-tier call worth paying to think about. Its errors are not
      // symmetric: a false "same" merges two distinct concepts into one node of a graph
      // every learner shares, and nothing downstream can tell it happened. On the
      // labelled pairs medium scored 11/12 against 10/12 for both low and high — one
      // pair, so weak evidence, but it costs a second on a call that runs rarely.
      effort: "medium",
        temperature: 0,
      },
      schema,
    );

    const { decision, downgraded } = validateDecision(raw, input.candidates);
    if (downgraded) this.opts.onDowngrade?.(input, decision);
    return decision;
  }
}
