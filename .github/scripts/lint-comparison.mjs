import { ESLint } from "eslint";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { log } from "node:console";

const root = process.cwd();
const baseSha = process.env.LINT_BASE_SHA;
const headSha = process.env.LINT_HEAD_SHA;
if (![baseSha, headSha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? "")))
  throw new Error("Exact commit SHAs required");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const temp = path.resolve(process.env.RUNNER_TEMP);
const baseRoot = path.join(temp, `lint-base-${baseSha}`);
const output = path.join(temp, "lint-comparison");
if (fs.existsSync(baseRoot)) throw new Error("Unexpected existing baseline directory");
for (const file of ["bun.lockb", "eslint.config.js", ".prettierrc", ".prettierignore"]) {
  const base = execFileSync("git", ["show", `${baseSha}:${file}`], { cwd: root });
  const head = execFileSync("git", ["show", `${headSha}:${file}`], { cwd: root });
  if (!base.equals(head)) throw new Error(`Comparison input changed: ${file}`);
}
const baseManifest = JSON.parse(git("show", `${baseSha}:package.json`));
const headManifest = JSON.parse(git("show", `${headSha}:package.json`));
for (const field of ["dependencies", "devDependencies"]) {
  if (JSON.stringify(baseManifest[field]) !== JSON.stringify(headManifest[field]))
    throw new Error(`Manifest ${field} changed`);
}
git("worktree", "add", "--detach", baseRoot, baseSha);
fs.symlinkSync(path.join(root, "node_modules"), path.join(baseRoot, "node_modules"), "dir");
fs.mkdirSync(output, { recursive: true });

const changed = new Set(
  git("diff", "--no-renames", "--name-only", baseSha, headSha).trim().split("\n").filter(Boolean),
);
const hunks = new Map();
for (const file of changed) {
  const diff = git(
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--unified=0",
    baseSha,
    headSha,
    "--",
    file,
  );
  hunks.set(
    file,
    [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({
      oldStart: Number(m[1]),
      oldCount: Number(m[2] ?? 1),
      newStart: Number(m[3]),
      newCount: Number(m[4] ?? 1),
    })),
  );
}
function originalLine(file, line) {
  let delta = 0;
  for (const hunk of hunks.get(file) ?? []) {
    if (hunk.newCount && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return null;
    const boundary = hunk.newCount ? hunk.newStart + hunk.newCount : hunk.newStart + 1;
    if (line >= boundary) delta += hunk.oldCount - hunk.newCount;
  }
  return line + delta;
}
function flatten(results, cwd, suppressed = false) {
  return results.flatMap((result) =>
    (suppressed ? result.suppressedMessages : result.messages).map((m) => ({
      file: path.relative(cwd, result.filePath).split(path.sep).join("/"),
      rule: m.ruleId ?? "fatal/parse",
      severity: m.severity,
      line: m.line,
      column: m.column,
      message: m.message,
      ...(suppressed ? { suppressions: m.suppressions } : {}),
    })),
  );
}
const baseResults = await new ESLint({ cwd: baseRoot }).lintFiles(["."]);
const headResults = await new ESLint({ cwd: root }).lintFiles(["."]);
const base = flatten(baseResults, baseRoot);
const head = flatten(headResults, root);
const key = (m, line = m.line) =>
  JSON.stringify([m.file, m.rule, m.severity, line, m.column, m.message]);
const available = new Map();
base.forEach((m, index) => {
  const k = key(m);
  available.set(k, [...(available.get(k) ?? []), index]);
});
const inherited = [];
const introduced = [];
const matched = new Set();
for (const m of head) {
  const oldLine = originalLine(m.file, m.line);
  const candidates = oldLine == null ? [] : (available.get(key(m, oldLine)) ?? []);
  const index = candidates.find((i) => !matched.has(i));
  if (index != null) {
    matched.add(index);
    inherited.push(m);
  } else
    introduced.push({
      ...m,
      classification:
        oldLine == null
          ? "added_or_modified_line"
          : changed.has(m.file)
            ? "changed_context"
            : "unexplained_unchanged_file",
    });
}
const removed = base.filter((_, index) => !matched.has(index));
if (
  inherited.length + introduced.length !== head.length ||
  matched.size + removed.length !== base.length
)
  throw new Error("Unaccounted lint diagnostics");
const totals = (items) => ({
  errors: items.filter((m) => m.severity === 2).length,
  warnings: items.filter((m) => m.severity === 1).length,
  files: new Set(items.map((m) => m.file)).size,
});
function byRule(items) {
  return Object.fromEntries(
    [...new Set(items.map((m) => m.rule))]
      .sort()
      .map((rule) => [rule, totals(items.filter((m) => m.rule === rule))]),
  );
}
const linted = new Set(
  [
    ...baseResults.map((r) => path.relative(baseRoot, r.filePath)),
    ...headResults.map((r) => path.relative(root, r.filePath)),
  ].map((f) => f.split(path.sep).join("/")),
);
const changedFiles = [...changed]
  .filter((file) => linted.has(file))
  .sort()
  .map((file) => ({
    file,
    base: totals(base.filter((m) => m.file === file)),
    head: totals(head.filter((m) => m.file === file)),
    inherited: totals(inherited.filter((m) => m.file === file)),
    prAssociated: totals(introduced.filter((m) => m.file === file)),
    removedOrChanged: totals(removed.filter((m) => m.file === file)),
  }));
const baseSuppressed = flatten(baseResults, baseRoot, true);
const headSuppressed = flatten(headResults, root, true);
const summary = {
  baseSha,
  headSha,
  platform: process.platform,
  node: process.version,
  lintVersions: Object.fromEntries(
    [
      "eslint",
      "prettier",
      "typescript-eslint",
      "eslint-plugin-prettier",
      "eslint-plugin-react-hooks",
      "eslint-plugin-react-refresh",
    ].map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"))
        .version,
    ]),
  ),
  inputsIdentical: [
    "bun.lockb",
    "dependency manifests",
    "eslint.config.js",
    ".prettierrc",
    ".prettierignore",
  ],
  method:
    "Same installed frozen dependencies, Linux runner and unchanged configuration. Existing diagnostics match by rule, severity, exact message, column and diff-mapped unchanged source line. Unmatched added/modified-line or changed-context findings are PR-associated; these can replace baseline violations, so totals alone are not a regression test.",
  noComparisonSuppressions: true,
  base: totals(base),
  head: totals(head),
  inherited: totals(inherited),
  prAssociated: totals(introduced),
  removedOrChanged: totals(removed),
  rules: { base: byRule(base), head: byRule(head), prAssociated: byRule(introduced) },
  changedFiles,
  changedLintedFiles: changedFiles.length,
  changedFilesWithFindings: changedFiles.filter((f) => f.head.errors || f.head.warnings).length,
  unexplainedUnchangedFileFindings: introduced.filter(
    (m) => m.classification === "unexplained_unchanged_file",
  ).length,
  sourceSuppressions: {
    base: totals(baseSuppressed),
    head: totals(headSuppressed),
    headRules: byRule(headSuppressed),
    changedFiles: [...changed]
      .filter(
        (file) =>
          baseSuppressed.some((m) => m.file === file) ||
          headSuppressed.some((m) => m.file === file),
      )
      .map((file) => ({
        file,
        base: totals(baseSuppressed.filter((m) => m.file === file)),
        head: totals(headSuppressed.filter((m) => m.file === file)),
      })),
  },
};
for (const [name, data] of Object.entries({
  summary,
  "base-findings": base,
  "head-findings": head,
  "pr-associated-findings": introduced,
  "removed-or-changed-findings": removed,
  "base-suppressed": baseSuppressed,
  "head-suppressed": headSuppressed,
}))
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
log(JSON.stringify(summary, null, 2));
log(`Detailed machine-readable evidence: ${output}`);
