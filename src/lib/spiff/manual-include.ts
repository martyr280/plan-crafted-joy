// Only explicit user inclusion creates this marker. Preserve all P21 flags.
export function manualIncludePatch<T extends { included: boolean; exclusion_reason: string | null; flags: Record<string, unknown> }>(
  line: T, patch: Partial<T>,
): Partial<T> {
  if (patch.included === undefined) return patch;
  const flags = { ...line.flags, ...patch.flags };
  if (patch.included && !line.included) flags.manual_include = true;
  if (!patch.included) {
    delete flags.manual_include;
    return { ...patch, exclusion_reason: "manual", flags };
  }
  return { ...patch, flags };
}