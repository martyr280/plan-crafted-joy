// Browser-safe helpers shared by order-mail.server.ts and the Order Mail screens.
export const LIVE_MIN_AGENT_VERSION = "1.5.0";

export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  if (!m) return false;
  const a = [+m[1], +m[2], +m[3]],
    b = min.split(".").map(Number);
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return true;
}
