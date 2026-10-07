/** Majority vote across K independent samples */

export interface ConsensusItem<T> {
  value: T;
  votes: number;
  variants: T[];
}

export interface ConsensusOptions<T> {
  key: (item: T) => string;
  /** Defaults to a strict majority of samples */
  threshold?: number;
}

/** Vote matching only; looser than the resolver's `normalizeName` */
export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|a|an) +/, "");
}

export function consensus<T>(
  samples: T[][],
  opts: ConsensusOptions<T>,
): { survived: ConsensusItem<T>[]; dropped: ConsensusItem<T>[] } {
  const threshold = opts.threshold ?? Math.ceil(samples.length / 2);
  const tally = new Map<string, ConsensusItem<T>>();

  for (const sample of samples) {
    // A sample listing an item twice is still one vote
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
