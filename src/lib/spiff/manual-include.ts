import { amountForIncludeChange } from "./amount";

// Only explicit user inclusion creates this marker. Preserve all P21 flags.
// spiff_amount comes from amountForIncludeChange (flags.gen_amount); legacy
// lines without gen_amount get no spiff_amount in the patch at all.
type IncludeState = {
  included: boolean;
  exclusion_reason: string | null;
  flags: Record<string, unknown>;
  extended_price?: number | string | null;
  spiff_amount?: number;
};
export function manualIncludePatch(
  line: IncludeState, patch: Partial<IncludeState>,
): Partial<Omit<IncludeState, "extended_price">> {
  if (patch.included === undefined) return patch;
  const flags = { ...line.flags, ...patch.flags };
  if (patch.included && !line.included) flags.manual_include = true;
  if (!patch.included) delete flags.manual_include;
  const value = amountForIncludeChange({ flags, extended_price: line.extended_price }, patch.included);
  const amount = value === undefined ? {} : { spiff_amount: value };
  if (!patch.included) return { ...patch, exclusion_reason: "manual", flags, ...amount };
  return { ...patch, flags, ...amount };
}
