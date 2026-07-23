export interface RankedCandidate<T> {
  item: T;
  key: string;
}

export function reciprocalRankFusion<T>(channels: readonly RankedCandidate<T>[][], limit: number, k = 60): Array<T & { score: number }> {
  const merged = new Map<string, { item: T; score: number }>();
  for (const channel of channels) {
    channel.forEach(({ item, key }, index) => {
      const current = merged.get(key);
      const score = 1 / (k + index + 1);
      if (current) current.score += score;
      else merged.set(key, { item, score });
    });
  }
  return [...merged.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item, score }) => Object.assign({}, item, { score }));
}
