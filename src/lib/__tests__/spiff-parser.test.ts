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
