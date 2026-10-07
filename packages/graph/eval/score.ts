import type { ResolverCandidate, ResolverVerdict } from "@kg/shared";
import type { Adjudicator } from "../src/adjudicate.js";
import { PAIRS, type LabelledPair } from "./pairs.js";

export interface PairResult {
  pair: LabelledPair;
  actual: ResolverVerdict;
  correct: boolean;
  falseSame: boolean;
  falseDistinct: boolean;
}

export interface EvalReport {
  total: number;
  correct: number;
  accuracy: number;
  falseSames: PairResult[];
  falseDistincts: PairResult[];
  /** A false `same` is permanent, a false `distinct` is repairable */
  weightedError: number;
  byPair: PairResult[];
}

const FALSE_SAME_WEIGHT = 10;

export async function scoreAdjudicator(
  adjudicator: Adjudicator,
  pairs: LabelledPair[] = PAIRS,
): Promise<EvalReport> {
  const byPair: PairResult[] = [];

  for (const pair of pairs) {
    const candidate: ResolverCandidate = {
      conceptId: pair.id,
      canonicalName: pair.existing.name,
      sense: pair.existing.sense,
      vectorScore: 0.8,
      lexicalScore: 0.5,
      neighborhoodOverlap: 0.3,
    };
    const decision = await adjudicator.adjudicate({
      proposedName: pair.proposed.name,
      proposedSense: pair.proposed.sense,
      candidates: [candidate],
    });

    const actual = decision.verdict;
    byPair.push({
      pair,
      actual,
      correct: actual === pair.expected,
      falseSame: actual === "same" && pair.expected !== "same",
      falseDistinct: actual === "distinct" && pair.expected === "same",
    });
  }

  const correct = byPair.filter((r) => r.correct).length;
  const falseSames = byPair.filter((r) => r.falseSame);
  const falseDistincts = byPair.filter((r) => r.falseDistinct);
  const wrong = byPair.length - correct;

  return {
    total: byPair.length,
    correct,
    accuracy: byPair.length === 0 ? 0 : correct / byPair.length,
    falseSames,
    falseDistincts,
    weightedError:
      byPair.length === 0
        ? 0
        : (wrong + falseSames.length * (FALSE_SAME_WEIGHT - 1)) / byPair.length,
    byPair,
  };
}

export function formatReport(r: EvalReport): string {
  const lines = [
    `adjudicator eval: ${r.correct}/${r.total} correct (${(r.accuracy * 100).toFixed(0)}%)`,
    `weighted error: ${r.weightedError.toFixed(2)}  (false-same counts ${FALSE_SAME_WEIGHT}x)`,
    "",
  ];
  if (r.falseSames.length > 0) {
    lines.push("FALSE SAME — these would merge distinct concepts permanently:");
    for (const f of r.falseSames) {
      lines.push(`  ${f.pair.id}: expected ${f.pair.expected}, got same`);
      lines.push(`    ${f.pair.tests}`);
    }
    lines.push("");
  }
  const other = r.byPair.filter((p) => !p.correct && !p.falseSame);
  if (other.length > 0) {
    lines.push("other misses:");
    for (const f of other) lines.push(`  ${f.pair.id}: expected ${f.pair.expected}, got ${f.actual}`);
  }
  return lines.join("\n");
}
