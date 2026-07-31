// RMA Analytics :: reason-code bucketing.
//
// NDI has been entering free-ish reason codes on P21 RMAs for a while. The
// analytics only need three actionable buckets plus a catch-all:
//   damaged         -> blame lands on the driver / handling on the truck
//   wrong_pick      -> blame lands on the puller building the pallet
//   customer_change -> not our fault; dealer-behaviour signal
//   other           -> unclassified; kept visible so it can't hide a problem
//
// Pure + browser-safe: the UI imports this to relabel and recolour buckets.

export const REASON_BUCKETS = ["damaged", "wrong_pick", "customer_change", "other"] as const;
export type ReasonBucket = (typeof REASON_BUCKETS)[number];

export const REASON_BUCKET_LABELS: Record<ReasonBucket, string> = {
  damaged: "Damaged",
  wrong_pick: "Wrong pick",
  customer_change: "Customer changed mind",
  other: "Other / unclassified",
};

// Buckets attributable to NDI execution (used for the outlier rate).
export const FAULT_BUCKETS: ReasonBucket[] = ["damaged", "wrong_pick"];

const PATTERNS: Array<{ bucket: ReasonBucket; re: RegExp }> = [
  { bucket: "damaged", re: /\b(damag|dmg|broke|broken|crush|dent|scratch|marred|freight\s*claim|concealed)\b/i },
  { bucket: "wrong_pick", re: /\b(wrong|mis[-\s]?pick|mispick|mis[-\s]?ship|misship|incorrect|shipped\s*in\s*error|pick\s*error|wrong\s*item|wrong\s*part|short\s*ship)\b/i },
  { bucket: "customer_change", re: /\b(customer\s*(chang|cancel)|chang(ed)?\s*mind|no\s*longer\s*need|cancel|order(ed)?\s*in\s*error|duplicate\s*order|not\s*need|buyer\s*remorse|dealer\s*error)\b/i },
];

/**
 * Classify a P21 reason code + description into one of four buckets.
 * Code is checked first (short codes like "DMG", "WP", "CC" are common), then
 * the description text.
 */
export function bucketReason(reasonCode?: string | null, reasonDesc?: string | null): ReasonBucket {
  const code = String(reasonCode ?? "").trim();
  const desc = String(reasonDesc ?? "").trim();
  const codeUpper = code.toUpperCase();

  // Exact short-code shortcuts seen in P21 installs.
  if (/^(DMG|DAM|DAMAGE[D]?|FRTDMG|CONCEAL)$/.test(codeUpper)) return "damaged";
  if (/^(WP|WRONG|WRNG|MISPICK|MISPK|PICKERR|SHIPERR)$/.test(codeUpper)) return "wrong_pick";
  if (/^(CC|CXL|CANCEL|CHGMIND|CUSTCHG|NLN)$/.test(codeUpper)) return "customer_change";

  const haystack = `${code} ${desc}`;
  for (const { bucket, re } of PATTERNS) {
    if (re.test(haystack)) return bucket;
  }
  return "other";
}

export function emptyReasonMap(): Record<ReasonBucket, number> {
  return { damaged: 0, wrong_pick: 0, customer_change: 0, other: 0 };
}

export function normalizeReasonMap(v: unknown): Record<ReasonBucket, number> {
  const out = emptyReasonMap();
  if (v && typeof v === "object") {
    for (const b of REASON_BUCKETS) {
      const n = Number((v as Record<string, unknown>)[b]);
      if (Number.isFinite(n)) out[b] = n;
    }
  }
  return out;
}
