// Single source of the per-line SPIFF amount rule. Client-safe (no server
// imports): used by Generate (spiff.server.ts), carry-over recompute, and the
// screen's include/exclude toggle (via manualIncludePatch).
//
// Rules:
// - Excluded lines are 0. This matches Generate, which writes 0 for every
//   excluded line, so excluding then re-including restores the exact amount.
// - Credit lines are always 0, even when included (show-only: no netting, no
//   negative payouts). Credit = flags.return_credit === true OR extended_price < 0.
// - Otherwise: +(extended_price * Number(rate)).toFixed(6).

export interface LineSpiffInput {
  included: boolean;
  extended_price: number | string | null | undefined;
  isCredit: boolean;
}

export function isCreditLine(line: { flags?: unknown; extended_price?: number | string | null }): boolean {
  const flags = (line.flags ?? {}) as Record<string, unknown>;
  return flags.return_credit === true || Number(line.extended_price ?? 0) < 0;
}

export function computeLineSpiff(input: LineSpiffInput, rate: number | string): number {
  if (!input.included || input.isCredit) return 0;
  return +(Number(input.extended_price ?? 0) * Number(rate)).toFixed(6);
}
