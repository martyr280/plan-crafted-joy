// Pure parser for the sequence-template paste importer.
//
// Joe has the remaining routes in a worksheet, one line per stop, in driver
// order. He pastes them; this turns the text into route_stop_sequences rows.
//
// Two rules that matter:
//  * Bad lines are REPORTED, never swallowed. A silently dropped line means a
//    city gets no template row and its stops land unslotted at the end of the
//    day — exactly the failure a paste importer is supposed to prevent.
//  * The day label is preserved VERBATIM ("WED (Thur)", "Thur/FRI"). Only the
//    day-group partitioner interprets it (first listed day wins).

import { normalizeCity, normalizeState } from "./address-match";

export type ParsedSequenceLine = {
  /** 1-based line number in the pasted text (blank lines counted). */
  lineNo: number;
  raw: string;
  /** Position in the template, assigned in paste order over VALID rows only. */
  position: number;
  cityRaw: string;
  cityNorm: string;
  state: string;
  deliveryDowLabel: string;
  isPickup: boolean;
};

export type SequenceLineError = {
  lineNo: number;
  raw: string;
  reason: string;
};

export type ParsedSequencePaste = {
  rows: ParsedSequenceLine[];
  errors: SequenceLineError[];
};

const PICKUP_FLAGS = new Set(["PICKUP", "PICK UP", "PU", "VENDOR PICKUP", "IS_PICKUP"]);

/**
 * Parse "City, ST, DAYLABEL" lines. A fourth field flags a pickup stop.
 * Blank lines and `#` comment lines are ignored without being errors.
 */
export function parseSequencePaste(text: string): ParsedSequencePaste {
  const rows: ParsedSequenceLine[] = [];
  const errors: SequenceLineError[] = [];
  const lines = String(text ?? "").split(/\r?\n/);

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const parts = trimmed.split(/\s*[,\t]\s*/).map((p) => p.trim());
    if (parts.length < 3) {
      errors.push({ lineNo, raw: trimmed, reason: "Expected 3 fields: City, ST, DAYLABEL" });
      return;
    }

    const [cityRaw, stateRaw, dayRaw, flagRaw] = parts;
    if (!cityRaw) {
      errors.push({ lineNo, raw: trimmed, reason: "Missing city" });
      return;
    }
    const state = normalizeState(stateRaw);
    if (state.length !== 2 || !/^[A-Z]{2}$/.test(state)) {
      errors.push({ lineNo, raw: trimmed, reason: `Invalid state "${stateRaw ?? ""}" (want a 2-letter code)` });
      return;
    }
    const deliveryDowLabel = String(dayRaw ?? "").trim();
    if (!deliveryDowLabel) {
      errors.push({ lineNo, raw: trimmed, reason: "Missing day label" });
      return;
    }
    const cityNorm = normalizeCity(cityRaw);
    if (!cityNorm) {
      errors.push({ lineNo, raw: trimmed, reason: "City normalized to empty" });
      return;
    }

    rows.push({
      lineNo,
      raw: trimmed,
      position: rows.length + 1,
      cityRaw,
      cityNorm,
      state,
      deliveryDowLabel,
      isPickup: PICKUP_FLAGS.has(String(flagRaw ?? "").trim().toUpperCase()),
    });
  });

  return { rows, errors };
}
