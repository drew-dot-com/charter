/** The error as one short line with every URL removed: an RPC URL may carry an API key. */
export function errorReason(e: unknown): string {
  const raw = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return raw.replace(/https?:\/\/\S+/gi, '<url>').replace(/\s+/g, ' ').slice(0, 200);
}
