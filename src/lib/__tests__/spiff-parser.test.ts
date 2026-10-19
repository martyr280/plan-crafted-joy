import { describe, it, expect } from "vitest";
import { parseWritingRep } from "../spiff/parser";

const cases: Array<[string, string]> = [
  ["Arielle Glath A38551-1", "Arielle Glath"],
  ["Arielle Glath A38773-4", "Arielle Glath"],
  ["BROOKE GABRIELSEN A12345", "Brooke Gabrielsen"],
  ["Lise Wagner L4471", "Lise Wagner"],
  ["Shaun Thompson C2209-2", "Shaun Thompson"],
  ["John Smith J", "John Smith J"],
  ["John Smith J / 6470", "John Smith J"],
  ["John Smith J 6470", "John Smith J"],
  ["DONNIE REILLY / 6470", "Donnie Reilly"],
  ["Donnie Reilly 1374105/ 6326", "Donnie Reilly"],
  ["Chris Godhsall 69049A-V1", "Chris Godhsall"],
  ["Steven Finckel 15863", "Steven Finckel"],
  ["ARIELLE GLATH / A38689-1", "Arielle Glath"],
];

describe("parseWritingRep", () => {
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      expect(parseWritingRep(input)).toEqual({ rep: expected, confidence: "parsed" });
    });
  }
});

describe("parseWritingRep — multi-letter glued PO prefixes", () => {
  const more: Array<[string, string, string]> = [
    ["ERIC WEAVER EEW12614", "Eric Weaver", "3-letter glued prefix dropped"],
    ["LAURA BORMAN CR726NDI", "Laura Borman", "2-letter glued prefix dropped"],
    ["Laura Borman CR726NDI", "Laura Borman", "mixed case, 2-letter glued prefix dropped"],
    ["LISA WAGNERL4471", "Lisa Wagnerl", "intentionally left unsplit (handled as data alias)"],
    ["Steven Finckel15863", "Steven Finckel", "glued surname >3 letters kept"],
    ["John Smith JR 6470", "John Smith Jr", "space before digits keeps suffix"],
    ["ERIC EEW12614", "Eric Eew", "unchanged pre-fix behaviour: only one word would remain"],
  ];
  for (const [input, expected, why] of more) {
    it(`${input} -> ${expected} (${why})`, () => {
      expect(parseWritingRep(input)).toEqual({ rep: expected, confidence: "parsed" });
    });
  }
});
