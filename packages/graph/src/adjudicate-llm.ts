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
      /**
       * Enough thinking to be careful, not enough to dominate the bill.
       *
       * Its errors are not symmetric — a false "same" merges two distinct concepts into
       * a node every learner shares, and nothing downstream can tell it happened — so
       * this is the one small-tier call worth paying to think about. But it was set to
       * `medium` on that argument alone, and the spend report then showed it emitting
       * ~1,400 output tokens per verdict across 80 calls: 13.6% of everything spent, for
       * a choice between five words. `low` caps thinking at 1,024, which is still more
       * than the run that scored 11/12 on the labelled pairs with thinking off entirely.
       */
      effort: "low",
        temperature: 0,
      },
      schema,
    );

    const { decision, downgraded } = validateDecision(raw, input.candidates);
    if (downgraded) this.opts.onDowngrade?.(input, decision);
    return decision;
  }
}
