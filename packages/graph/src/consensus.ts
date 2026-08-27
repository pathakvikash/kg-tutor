/** Self-consistency: sample K times independently, keep what a majority agree on. (15) */

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

/** Vote-matching identity only, deliberately looser than the resolver's `normalizeName`. */
export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|a|an) +/, "");
}

/** Anything below the threshold is dropped and reported separately, not hidden. */
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
