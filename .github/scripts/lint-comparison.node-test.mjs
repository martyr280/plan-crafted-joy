// Fixture tests for lint-comparison.mjs: real git repositories and the real
// ESLint CLI from this checkout, on tiny synthetic sources.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareDiagnostics,
  layoutContext,
  main,
  mapLine,
  parseUnifiedDiff,
  unquoteGitPath,
} from "./lint-comparison.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeModules = path.resolve(here, "..", "..", "node_modules");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lint-comparison-test-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "error", "no-var": "warn" } },
];
`;

function toolchain(name = "toolchain") {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    fs.symlinkSync(nodeModules, path.join(dir, "node_modules"), "dir");
  }
  return dir;
}

function repo(name, from) {
  const dir = path.join(scratch, name);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  if (from) {
    execFileSync("git", ["clone", "-q", from, dir]);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    git("init", "-q", "-b", "main");
  }
  const api = {
    dir,
    git,
    write(file, text) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      return api;
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
  };
  return api;
}

function baseRepo(name) {
  return repo(name)
    .write("package.json", '{ "type": "module" }\n')
    .write("eslint.config.js", CONFIG)
    .write("bun.lockb", "lock-v1\n");
}

let runs = 0;
async function compare(dir, baseSha, headSha, extra = {}) {
  const output = path.join(scratch, `out-${++runs}`);
  const code = await main({
    LINT_REPO: dir,
    LINT_BASE_SHA: baseSha,
    LINT_HEAD_SHA: headSha,
    LINT_TOOLCHAIN: toolchain(),
    LINT_OUTPUT: output,
    RUNNER_TEMP: scratch,
    ...extra,
  });
  const read = (name) => JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
  return { code, summary: read("summary"), read, output };
}

describe("diff parsing", () => {
  it("maps unchanged lines through hunks and rejects added lines", () => {
    const hunks = [{ oldStart: 2, oldCount: 0, newStart: 3, newCount: 2 }];
    assert.equal(mapLine(hunks, 1), 1);
    assert.equal(mapLine(hunks, 3), null);
    assert.equal(mapLine(hunks, 4), null);
    assert.equal(mapLine(hunks, 6), 4);
  });
  it("parses renames, deletions and quoted paths", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/a.js b/moved/a.js",
        "similarity index 90%",
        "rename from a.js",
        "rename to moved/a.js",
        "--- a/a.js",
        "+++ b/moved/a.js",
        "@@ -1 +1,2 @@",
        "diff --git a/b.js b/b.js",
        "deleted file mode 100644",
        "--- a/b.js",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        'diff --git "a/sp ace\\303\\251.js" "b/sp ace\\303\\251.js"',
        "new file mode 100644",
        "--- /dev/null",
        '+++ "b/sp ace\\303\\251.js"',
        "@@ -0,0 +1 @@",
      ].join("\n"),
    );
    assert.deepEqual(
      files.map((f) => [f.status, f.oldPath, f.newPath, [...f.added]]),
      [
        ["R", "a.js", "moved/a.js", [1, 2]],
        ["D", "b.js", null, []],
        ["A", null, "sp aceé.js", [1]],
      ],
    );
    assert.equal(unquoteGitPath('"tab\\there"'), "tab\there");
  });
});

describe("rewrap matching", () => {
  const baseSrc = "const cov = (q.data as any)?.coverage as { n: number };\n";
  const headSrc = "\nconst cov = (q.data as any)?.coverage as\n  | {\n      n: number;\n    };\n";
  const finding = (line, column, message, source) => ({
    file: "a.ts",
    rule: "r",
    severity: 2,
    line,
    column,
    message,
    context: layoutContext(source, line, column),
  });
  const diff = parseUnifiedDiff(
    ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,5 @@"].join("\n"),
  );

  it("ignores a leading union bar, quotes and a cited line number", () => {
    assert.equal(
      layoutContext(baseSrc, 1, 27),
      layoutContext(headSrc, 2, 27),
      "union bar and wrapping",
    );
    assert.equal(layoutContext("x = 'a';", 1, 5), layoutContext('x = "a"', 1, 5));
    const result = compareDiagnostics({
      base: [finding(1, 27, "Hook deps (at line 3) change", baseSrc)],
      head: [finding(2, 27, "Hook deps (at line 9) change", headSrc)],
      comparison: diff,
      scope: diff,
    });
    assert.equal(result.introduced.length, 0);
    assert.equal(result.reformatted.length, 1);
  });

  it("does not pair a diagnostic whose surrounding code changed", () => {
    const edited = headSrc.replace("coverage", "coverage2");
    const result = compareDiagnostics({
      base: [finding(1, 27, "m", baseSrc)],
      head: [finding(2, 27, "m", edited)],
      comparison: diff,
      scope: diff,
    });
    assert.equal(result.introduced.length, 1);
    assert.equal(result.resolved.length, 1);
  });
});

describe("comparator fixtures", () => {
  it("clean base and clean head pass with zero diagnostics", async () => {
    const r = baseRepo("clean");
    const base = r.write("src/a.js", "export const a = 1;\n").commit("base");
    const head = r.write("src/b.js", "export const b = 2;\n").commit("head");
    const { code, summary } = await compare(r.dir, base, head);
    assert.equal(code, 0);
    assert.equal(summary.status, "pass");
    assert.deepEqual(summary.fullRepo.head, { errors: 0, warnings: 0, files: 0 });
    assert.equal(summary.fullRepo.headClean, true);
    assert.equal(summary.addedLines.count, 1);
  });

  it("passes a baseline-only comparison while full lint stays honestly red", async () => {
    const r = baseRepo("baseline");
    const base = r
      .write("src/a.js", "export function a() {\n  debugger;\n  return 1;\n}\n")
      .write("src/old.js", "var legacy = 1;\nexport { legacy };\n")
      .commit("base");
    const head = r
      .write(
        "src/a.js",
        "// note\n// note\n// note\nexport function a() {\n  debugger;\n  return 2;\n}\n",
      )
      .commit("head");
    const { code, summary, read } = await compare(r.dir, base, head);
    assert.equal(code, 0);
    assert.equal(summary.status, "pass");
    assert.deepEqual(summary.fullRepo.head, { errors: 1, warnings: 1, files: 2 });
    assert.equal(summary.fullRepo.headClean, false);
    assert.deepEqual(summary.inherited, { errors: 1, warnings: 1, files: 2 });
    assert.deepEqual(summary.touchedFiles.head, { errors: 1, warnings: 0, files: 1 });
    assert.deepEqual(summary.addedLines.diagnostics, { errors: 0, warnings: 0, files: 0 });
    assert.equal(read("head-findings")[0].line, 5);
  });

  it("fails a genuine new error on an added line", async () => {
    const r = baseRepo("new-error");
    const base = r.write("src/a.js", "export function a() {\n  return 1;\n}\n").commit("base");
    const head = r
      .write("src/a.js", "export function a() {\n  debugger;\n  return 1;\n}\n")
      .commit("head");
    const { code, summary, read } = await compare(r.dir, base, head);
    assert.equal(code, 1);
    assert.equal(summary.status, "regression");
    assert.deepEqual(summary.introduced.addedLine, { errors: 1, warnings: 0, files: 1 });
    assert.deepEqual(
      read("introduced-findings").map((m) => [m.file, m.line, m.rule, m.classification]),
      [["src/a.js", 2, "no-debugger", "added_line"]],
    );
  });

  it("keeps a diagnostic inherited when Prettier-style rewrapping moves its line", async () => {
    const r = baseRepo("rewrap");
    const base = r
      .write("src/a.js", "export function a() { var total = sum(1, 2, 3); return total; }\n")
      .commit("base");
    const head = r
      .write(
        "src/a.js",
        "export function a() {\n  var total = sum(\n    1,\n    2,\n    3,\n  );\n  return total;\n}\n",
      )
      .commit("head");
    const { code, summary } = await compare(r.dir, base, head);
    assert.equal(code, 0);
    assert.equal(summary.status, "pass");
    assert.deepEqual(summary.inheritedAfterReformat, { errors: 0, warnings: 1, files: 1 });
    assert.deepEqual(summary.introduced.all, { errors: 0, warnings: 0, files: 0 });
    assert.deepEqual(summary.addedLines.diagnostics, { errors: 0, warnings: 1, files: 1 });
  });

  it("still fails a new diagnostic added alongside a rewrap of an old one", async () => {
    const r = baseRepo("rewrap-new");
    const base = r
      .write("src/a.js", "export function a() { var total = sum(1, 2, 3); return total; }\n")
      .commit("base");
    const head = r
      .write(
        "src/a.js",
        "export function a() {\n  var total = sum(\n    1,\n    2,\n    3,\n  );\n  return total;\n}\n",
      )
      .write("src/b.js", "export function b() {\n  var extra = 3;\n  return extra;\n}\n")
      .commit("head");
    const { code, summary, read } = await compare(r.dir, base, head);
    assert.equal(code, 1);
    assert.deepEqual(summary.inheritedAfterReformat, { errors: 0, warnings: 1, files: 1 });
    assert.deepEqual(
      read("introduced-findings").map((m) => [m.file, m.line, m.rule, m.classification]),
      [["src/b.js", 2, "no-var", "added_line"]],
    );
  });

  it("treats an edit beside an old diagnostic as new, not as a rewrap", async () => {
    const r = baseRepo("rewrap-edit");
    const base = r
      .write("src/a.js", "export function a() { var total = sum(1, 2, 3); return total; }\n")
      .commit("base");
    const head = r
      .write("src/a.js", "export function a() {\n  var total = sum(1, 2, 4);\n  return total;\n}\n")
      .commit("head");
    const { code, read } = await compare(r.dir, base, head);
    assert.equal(code, 1);
    assert.deepEqual(
      read("introduced-findings").map((m) => [m.line, m.rule]),
      [[2, "no-var"]],
    );
  });

  it("follows renames and counts deleted-file diagnostics as resolved", async () => {
    const r = baseRepo("rename");
    const body =
      "export function a() {\n  debugger;\n  return 1;\n}\n// padding so rename similarity stays high\n";
    const base = r
      .write("src/a.js", body)
      .write("src/b.js", "var b = 1;\nexport { b };\n")
      .commit("base");
    fs.mkdirSync(path.join(r.dir, "src", "moved"));
    r.git("mv", "src/a.js", "src/moved/a.js");
    r.git("rm", "-q", "src/b.js");
    const head = r.commit("head");
    const { code, summary } = await compare(r.dir, base, head);
    assert.equal(code, 0);
    assert.deepEqual(summary.touchedFiles.renamed, [{ from: "src/a.js", to: "src/moved/a.js" }]);
    assert.deepEqual(summary.touchedFiles.deleted, ["src/b.js"]);
    assert.deepEqual(summary.inherited, { errors: 1, warnings: 0, files: 1 });
    assert.deepEqual(summary.resolvedOrMoved, { errors: 0, warnings: 1, files: 1 });
    assert.deepEqual(summary.introduced.all, { errors: 0, warnings: 0, files: 0 });
  });

  it("treats an ESLint configuration error (exit 2) as an infrastructure failure", async () => {
    const r = baseRepo("bad-config");
    const base = r
      .write("eslint.config.js", 'export default [{ rules: { "no-debugger": "sometimes" } }];\n')
      .write("src/a.js", "export const a = 1;\n")
      .commit("base");
    const head = r.write("src/a.js", "export const a = 2;\n").commit("head");
    const { code, summary } = await compare(r.dir, base, head);
    assert.equal(code, 2);
    assert.equal(summary.status, "infrastructure_failure");
    assert.match(summary.error, /base: ESLint exit 2 is a configuration\/crash\/usage failure/);
  });

  it("treats empty, unreadable or missing lint output as an infrastructure failure", async () => {
    const r = baseRepo("bad-artifact");
    const base = r.write("src/a.js", "export const a = 1;\n").commit("base");
    const head = r.write("src/a.js", "export const a = 2;\n").commit("head");
    const fake = (name, body) => {
      const p = path.join(scratch, name);
      fs.writeFileSync(p, body);
      return p;
    };
    const empty = await compare(r.dir, base, head, {
      LINT_ESLINT_BIN: fake("empty.mjs", 'process.stdout.write("[]");\n'),
    });
    assert.equal(empty.code, 2);
    assert.match(empty.summary.error, /incomplete ESLint artifact, 2 expected file\(s\) missing/);
    const garbage = await compare(r.dir, base, head, {
      LINT_ESLINT_BIN: fake("garbage.mjs", 'process.stdout.write("not json");\n'),
    });
    assert.equal(garbage.code, 2);
    assert.match(garbage.summary.error, /unreadable/);
    const missing = await compare(r.dir, base, head, {
      LINT_TOOLCHAIN: path.join(scratch, "none"),
    });
    assert.equal(missing.code, 2);
  });

  it("reports a changed lockfile as tooling, runs the head natively, and does not call it a source failure", async () => {
    const r = baseRepo("lockfile");
    const base = r.write("src/a.js", "export const a = 1;\n").commit("base");
    const head = r
      .write("bun.lockb", "lock-v2\n")
      .write("src/a.js", "export const a = 2;\n")
      .commit("head");
    const without = await compare(r.dir, base, head);
    assert.equal(without.code, 2);
    assert.match(
      without.summary.error,
      /Tooling differs \(bun\.lockb\); LINT_HEAD_TOOLCHAIN is required/,
    );
    assert.deepEqual(without.summary.tooling.changed, ["bun.lockb"]);

    const native = await compare(r.dir, base, head, {
      LINT_HEAD_TOOLCHAIN: toolchain("head-toolchain"),
    });
    assert.equal(native.code, 0);
    assert.equal(native.summary.status, "pass");
    assert.equal(native.summary.tooling.files.find((t) => t.file === "bun.lockb").kind, "lockfile");
    assert.deepEqual(native.summary.native.addedLines, { errors: 0, warnings: 0, files: 0 });
    assert.match(native.summary.tooling.policy, /not a source lint result/);
  });

  it("lints head with the base configuration and reports a head config change separately", async () => {
    const r = baseRepo("config-drift");
    const base = r.write("src/a.js", "export const a = 1;\n").commit("base");
    const head = r
      .write("eslint.config.js", 'export default [{ files: ["**/*.js"], rules: {} }];\n')
      .write("src/a.js", "export const a = 1;\nvar fresh = 2;\nexport { fresh };\n")
      .commit("head");
    const { code, summary } = await compare(r.dir, base, head, {
      LINT_HEAD_TOOLCHAIN: toolchain("head-toolchain"),
    });
    // The common (base) rules still see the new `var`; turning rules off in the PR does not hide it.
    assert.equal(code, 1);
    assert.deepEqual(summary.introduced.addedLine, { errors: 0, warnings: 1, files: 1 });
    assert.deepEqual(summary.tooling.changed, ["eslint.config.js"]);
    assert.deepEqual(summary.native.fullRepo, { errors: 0, warnings: 0, files: 0 });
  });

  it("uses the actual base tip and merge-base scope for a fork head behind main", async () => {
    const up = baseRepo("upstream");
    const mergeBase = up
      .write("src/shared.js", "export function s() {\n  debugger;\n}\n")
      .write("src/main-only.js", "export const m = 1;\n")
      .commit("common");
    const fork = repo("fork", up.dir);
    const head = fork.write("src/feature.js", "export const f = 1;\n").commit("fork feature");
    // Main moves on after the fork branched: fixes shared.js, breaks main-only.js.
    const baseTip = up
      .write("src/shared.js", "export function s() {\n  return 1;\n}\n")
      .write("src/main-only.js", "export const m = 1;\nexport function g() {\n  debugger;\n}\n")
      .commit("main moves");
    up.git("fetch", "-q", fork.dir, `${head}:refs/pull/1/head`);

    const { code, summary, read } = await compare(up.dir, baseTip, head);
    assert.equal(summary.baseSha, baseTip);
    assert.equal(summary.headSha, head);
    assert.equal(summary.mergeBase, mergeBase);
    assert.equal(summary.comparison.baseTipIsMergeBase, false);
    assert.equal(summary.touchedFiles.count, 1);
    assert.equal(summary.addedLines.count, 1);
    // Head still has the debugger main removed: reported as base drift, not blamed on the PR.
    assert.deepEqual(
      read("introduced-findings").map((m) => [m.file, m.classification]),
      [["src/shared.js", "base_drift"]],
    );
    // Main's new error is absent from head: resolved or moved, not counted as inherited.
    assert.deepEqual(summary.resolvedOrMoved, { errors: 1, warnings: 0, files: 1 });
    assert.equal(code, 0);
  });

  it("rejects anything but full commit SHAs before touching git", async () => {
    const r = baseRepo("sha");
    const base = r.write("src/a.js", "export const a = 1;\n").commit("base");
    for (const bad of ["HEAD", base.slice(0, 12), `${base}; rm -rf /`, base.toUpperCase()]) {
      const { code, summary } = await compare(r.dir, base, bad);
      assert.equal(code, 2);
      assert.match(summary.error, /full lowercase 40-hex/);
    }
    const unknown = await compare(r.dir, base, "0".repeat(40));
    assert.equal(unknown.code, 2);
    assert.match(unknown.summary.error, /not present/);
  });
});
