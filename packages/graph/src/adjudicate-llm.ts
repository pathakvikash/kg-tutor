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

/** Rubric-bound, so it runs on the small tier at temperature 0 to stay reproducible. (17) */
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
      // A false "same" merges two concepts irreversibly, so keep a small real budget.
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
