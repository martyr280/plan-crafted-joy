/** Operator-facing text for a cap-skipped family relabel (activity feed + schedule last_error). */
export function familySkipMessage(changed: number, cap: number): string {
  return `Family relabel SKIPPED: ${changed.toLocaleString("en-US")} changes > cap ${cap.toLocaleString("en-US")}, needs approved forced run`;
}
