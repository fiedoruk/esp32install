/**
 * Seconds left, from throughput so far: the same estimate for writing and for the backup reads.
 * Undefined until a second has passed, because the first chunk says nothing about the rate.
 */
export function etaSeconds(startedAt, done, total, now = Date.now) {
  const elapsed = (now() - startedAt) / 1000;
  return done > 0 && elapsed > 1 ? Math.round(((total - done) * elapsed) / done) : undefined;
}
