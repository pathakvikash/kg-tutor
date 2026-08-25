/**
 * Self-consistency: sample the same question K times independently and keep only what
 * a majority of samples agree on. (15)
 *
 * This is the cheapest quality intervention available against an over-generating model.
 * Asked once for "the prerequisites of X" a model returns eight things, most of them
 * merely adjacent; asked three times, the merely-adjacent tail mostly fails to recur.
 * It costs 3x on the one operation that is cached forever after the first learner.
 */

export interface ConsensusItem<T> {
  value: T;
  /** How many independent samples contained it. */
  votes: number;
  /** Every variant seen, so the surviving item can keep the best-phrased version. */
  variants: T[];
}

export interface ConsensusOptions<T> {
  /** Identity for voting — normalized name, typically. Case- and space-insensitive. */
  key: (item: T) => string;
  /** Minimum votes to survive. Defaults to a strict majority of samples. */
  threshold?: number;
}

/**
 * Vote-matching identity. Deliberately NOT the same as the resolver's `normalizeName`,
 * which keys the alias uniqueness index and must stay conservative.
 *
 * Two normalizations that matter here:
 *   - punctuation becomes a separator, not nothing, so `event-loop` keys the same as
 *     `event loop`. Deleting it yields `eventloop`, which matches neither.
 *   - a leading article is dropped, so `the event loop` and `event loop` vote together.
 *     Without it, samples that agree on a concept but not on its article split their
 *     votes and can drop *both* variants below threshold — losing a concept every
 *     sample actually named.
 */
export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|a|an) +/, "");
}

/**
 * Items are matched across samples by `key`. Anything below the threshold is dropped
 * and reported separately — a dropped item is not noise to hide, it is the measurable
 * output of the filter.
 */
export function consensus<T>(
  samples: T[][],
  opts: ConsensusOptions<T>,
): { survived: ConsensusItem<T>[]; dropped: ConsensusItem<T>[] } {
  const threshold = opts.threshold ?? Math.ceil(samples.length / 2);
  const tally = new Map<string, ConsensusItem<T>>();

  for (const sample of samples) {
    // One sample listing the same item twice must not count as two votes.
    const seenInSample = new Set<string>();
    for (const item of sample) {
      const k = opts.key(item);
      if (!k) continue;
      const entry = tally.get(k);
      if (!entry) {
        tally.set(k, { value: item, votes: 1, variants: [item] });
        seenInSample.add(k);
        continue;
      }
      entry.variants.push(item);
      if (!seenInSample.has(k)) {
        entry.votes++;
        seenInSample.add(k);
      }
    }
  }

  const survived: ConsensusItem<T>[] = [];
  const dropped: ConsensusItem<T>[] = [];
  for (const entry of tally.values()) {
    (entry.votes >= threshold ? survived : dropped).push(entry);
  }
  survived.sort((a, b) => b.votes - a.votes);
  dropped.sort((a, b) => b.votes - a.votes);
  return { survived, dropped };
}
