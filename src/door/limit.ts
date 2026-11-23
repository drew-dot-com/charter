/** At most `max` hits per key within `windowMs`. Counts the attempt it allows. */
export function slidingLimit(now: () => number, max: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key) => {
    const t = now();
    if (hits.size > 256) {
      for (const [k, v] of hits) if (v[v.length - 1]! <= t - windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((x) => x > t - windowMs);
    const ok = recent.length < max;
    if (ok) recent.push(t);
    hits.set(key, recent);
    return ok;
  };
}
