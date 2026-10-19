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

export type IncludeAmountContext = {
  rate: number | string;
  programUpdatedAt: string | null;
  runGeneratedAt: string | null;
};
export type IncludeAmountResult =
  | { kind: "set"; amount: number; flags?: { gen_rate: number; gen_amount: number } }
  | { kind: "leave" }
  | { kind: "block"; reason: string };

export const LEGACY_AMOUNT_BLOCK_REASON = "This run predates a change to its SPIFF program, so the amount can't be recovered safely. Nothing was changed. Ask the Builder.";

// Stored generation amounts win. Recover only zero-valued, positive, non-credit
// legacy inclusions whose program was unchanged since totals.generated_at.
// Other legacy amounts are left untouched rather than restored from edit history:
// history can be incomplete (SQL batches, pre-trigger edits). Checks sum only
// included lines, so excluded stored amounts do not affect payouts, and a
// non-zero legacy round-trip preserves the original amount exactly.
export function amountForIncludeChange(
  line: { flags?: unknown; extended_price?: number | string | null; spiff_amount?: number | string | null },
  included: boolean,
  ctx?: IncludeAmountContext,
): IncludeAmountResult {
  const gen = ((line.flags ?? {}) as Record<string, unknown>).gen_amount;
  if (typeof gen === "number" && Number.isFinite(gen)) {
    return { kind: "set", amount: !included || isCreditLine(line) ? 0 : gen };
  }
  if (!included || isCreditLine(line) || !(Number(line.extended_price) > 0) || Number(line.spiff_amount) !== 0) return { kind: "leave" };
  const updated = ctx?.programUpdatedAt ? Date.parse(ctx.programUpdatedAt) : NaN;
  const generated = ctx?.runGeneratedAt ? Date.parse(ctx.runGeneratedAt) : NaN;
  if (!ctx || !Number.isFinite(updated) || !Number.isFinite(generated) || updated > generated || !Number.isFinite(Number(ctx.rate))) {
    return { kind: "block", reason: LEGACY_AMOUNT_BLOCK_REASON };
  }
  const amount = computeLineSpiff({ included: true, extended_price: line.extended_price, isCredit: false }, ctx.rate);
  return { kind: "set", amount, flags: { gen_rate: Number(ctx.rate), gen_amount: amount } };
}
