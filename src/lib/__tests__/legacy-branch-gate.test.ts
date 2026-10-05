// Every pre-existing authenticated server function must run the branch-role gate.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLegacyAccessWith } from "../branch-guard";

const dir = join(__dirname, "..");
const NEW_BRANCH_ENDPOINTS = ["branch-logistics.functions.ts"]; // scoped endpoint, resolves scope itself
const PUBLIC_UNAUTH = ["auth-emails.functions.ts"]; // pre-login magic link / reset

describe("legacy server functions reject branch managers", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".functions.ts"));
  it("found the legacy modules", () => expect(files.length).toBeGreaterThanOrEqual(22));
  for (const f of files) {
    if (NEW_BRANCH_ENDPOINTS.includes(f) || PUBLIC_UNAUTH.includes(f)) continue;
    it(`${f}: every createServerFn uses denyLegacyBranchAccess`, () => {
      const src = readFileSync(join(dir, f), "utf8");
      const fns = src.split("createServerFn(").slice(1);
      expect(fns.length).toBeGreaterThan(0);
      for (const chunk of fns) {
        const head = chunk.slice(
          0,
          chunk.indexOf(".handler(") >= 0 ? chunk.indexOf(".handler(") : chunk.length,
        );
        expect(head).toContain(".middleware([denyLegacyBranchAccess])");
      }
    });
  }
  const unbound = async () => false;
  it("gate denies branch roles, fails closed on lookup error, allows operators", async () => {
    await expect(
      checkLegacyAccessWith(async () => ["branch_manager"], "u", unbound),
    ).rejects.toThrow(/warehouse-scoped/);
    await expect(
      checkLegacyAccessWith(
        async () => {
          throw new Error("db");
        },
        "u",
        unbound,
      ),
    ).rejects.toThrow(/verify/);
    await expect(
      checkLegacyAccessWith(async () => ["ops_logistics"], "u", unbound),
    ).resolves.toBeUndefined();
    await expect(checkLegacyAccessWith(async () => [], "", unbound)).rejects.toThrow();
  });
  it("zero-role invite-bound identity is denied; binding lookup failure or non-boolean fails closed", async () => {
    const none = async () => [] as string[];
    await expect(checkLegacyAccessWith(none, "pending", async () => true)).rejects.toThrow(
      /warehouse-scoped/,
    );
    await expect(
      checkLegacyAccessWith(none, "u", async () => {
        throw new Error("rpc");
      }),
    ).rejects.toThrow(/verify/);
    await expect(
      checkLegacyAccessWith(none, "u", async () => null as unknown as boolean),
    ).rejects.toThrow();
    // Even an operator role row cannot unlock a bound identity.
    await expect(
      checkLegacyAccessWith(
        async () => ["admin"],
        "u",
        async () => true,
      ),
    ).rejects.toThrow(/warehouse-scoped/);
  });
});
