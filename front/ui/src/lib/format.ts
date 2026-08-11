/** Shared display formatting. Numbers only — no invented data, ever. */

/** 1234 → "1.2k", 1234567 → "1.2M". Token counts, not bytes. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * USD cost from pi's per-token pricing. Sub-cent costs are the norm for a
 * single message, so two significant decimals below a cent instead of
 * rounding everything to "$0.00". Zero (local models) renders as null so
 * callers can omit it — a $0.00 label on a local model implies metering that
 * is not happening.
 */
export function formatCost(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

/** Relative day, mirroring ResultList's scale ("today" … "2y ago"). */
export function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Context window: 200000 → "200k ctx". */
export function formatContext(tokens: number): string {
  return `${formatTokens(tokens)} ctx`;
}
