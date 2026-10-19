import { computeLineSpiff, isCreditLine } from "./amount";

// Only explicit user inclusion creates this marker. Preserve all P21 flags.
// When `rate` is given (the line's program rate), spiff_amount is recomputed
// with the same rule Generate uses so it is written in the SAME update.
type IncludeState = {
  included: boolean;
  exclusion_reason: string | null;
  flags: Record<string, unknown>;
  extended_price?: number | string | null;
  spiff_amount?: number;
};
export function manualIncludePatch(
  line: IncludeState, patch: Partial<IncludeState>, rate?: number | string,
): Partial<IncludeState> {
  if (patch.included === undefined) return patch;
  const flags = { ...line.flags, ...patch.flags };
  if (patch.included && !line.included) flags.manual_include = true;
  const amount = (included: boolean) =>
    rate === undefined ? {} : {
      spiff_amount: computeLineSpiff(
        { included, extended_price: line.extended_price, isCredit: isCreditLine({ flags, extended_price: line.extended_price }) },
        rate,
      ),
    };
  if (!patch.included) {
    delete flags.manual_include;
    return { ...patch, exclusion_reason: "manual", flags, ...amount(false) };
  }
  return { ...patch, flags, ...amount(true) };
}
