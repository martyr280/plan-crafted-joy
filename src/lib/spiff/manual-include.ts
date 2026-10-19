// Only explicit user inclusion creates this marker. Preserve all P21 flags.
type IncludeState = { included: boolean; exclusion_reason: string | null; flags: Record<string, unknown> };
export function manualIncludePatch(
  line: IncludeState, patch: Partial<IncludeState>,
): Partial<IncludeState> {
  if (patch.included === undefined) return patch;
  const flags = { ...line.flags, ...patch.flags };
  if (patch.included && !line.included) flags.manual_include = true;
  if (!patch.included) {
    delete flags.manual_include;
    return { ...patch, exclusion_reason: "manual", flags };
  }
  return { ...patch, flags };
}