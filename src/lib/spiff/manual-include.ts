import { amountForIncludeChange, type IncludeAmountContext } from "./amount";

// Only explicit user inclusion creates this marker. Preserve all P21 flags.
// A blocked recovery throws before any caller can persist an inclusion patch.
type IncludeState = {
  included: boolean;
  exclusion_reason: string | null;
  flags: Record<string, unknown>;
  extended_price?: number | string | null;
  spiff_amount?: number;
};
export function manualIncludePatch(
  line: IncludeState, patch: Partial<IncludeState>, ctx?: IncludeAmountContext,
): Partial<Omit<IncludeState, "extended_price">> {
  if (patch.included === undefined) return patch;
  const flags = { ...line.flags, ...patch.flags };
  if (patch.included && !line.included) flags.manual_include = true;
  if (!patch.included) delete flags.manual_include;
  const value = amountForIncludeChange({ ...line, flags }, patch.included, ctx);
  if (value.kind === "block") throw new Error(value.reason);
  if (value.kind === "set" && value.flags) Object.assign(flags, value.flags);
  const amount = value.kind === "set" ? { spiff_amount: value.amount } : {};
  if (!patch.included) return { ...patch, exclusion_reason: "manual", flags, ...amount };
  return { ...patch, flags, ...amount };
}
