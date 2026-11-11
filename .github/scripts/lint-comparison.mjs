// Actual-base ESLint comparison for a pull request.
//
// Lints two immutable commits (the PR base tip and the PR head) with ONE common
// toolchain: the base commit's installed dependencies and the base commit's lint
// configuration, applied to fresh detached worktrees of both commits. Head-side
// tooling changes are reported separately and linted natively, never mixed into
// the source comparison.
//
// Scopes, kept separate in the output:
//   fullRepo    every diagnostic in each tree (the inherited backlog stays visible)
//   touched     files the PR changed, from the merge-base diff (rename-aware)
//   addedLines  head lines the PR added, from the merge-base diff
// Diagnostics are matched against the base tip through the rename-aware
// base-tip→head diff. An unmatched head diagnostic in a PR-touched file is a
// regression. One in a file only main changed (head is behind the base tip) is
// "base_drift" and is reported, not gated.
//
// Environment:
//   LINT_BASE_SHA        full 40-hex base commit (github.event.pull_request.base.sha)
//   LINT_HEAD_SHA        full 40-hex head commit (github.event.pull_request.head.sha)
//   LINT_REPO            git repository containing both commits (default: cwd)
//   LINT_TOOLCHAIN       directory whose node_modules is the common toolchain
//   LINT_HEAD_TOOLCHAIN  directory whose node_modules is the head's own install
//                        (required only when tooling files differ)
//   LINT_HEAD_INSTALL    outcome of the head install step, recorded verbatim
//   LINT_OUTPUT          artifact directory (default: $RUNNER_TEMP/lint-comparison)
//   LINT_ESLINT_BIN      eslint CLI inside the toolchain (default: its eslint/bin/eslint.js)
//
// Exit status: 0 no new diagnostics; 1 new diagnostics in PR-touched files;
// 2 infrastructure failure (bad input, tool crash/config error, incomplete artifact).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const SHA_RE = /^[0-9a-f]{40}$/;
export const LOCKFILES = ["bun.lockb", "bun.lock", "package-lock.json"];
export const MANIFESTS = ["package.json"];
export const LINT_CONFIG = ["eslint.config.js", ".prettierrc", ".prettierignore", ".editorconfig"];
export const OTHER_TOOLING = ["tsconfig.json"];
const TOOLING = [...LOCKFILES, ...MANIFESTS, ...LINT_CONFIG, ...OTHER_TOOLING];
const VERSIONED_PACKAGES = [
  "eslint",
  "prettier",
  "typescript",
  "typescript-eslint",
  "eslint-plugin-prettier",
  "eslint-config-prettier",
  "eslint-plugin-react-hooks",
  "eslint-plugin-react-refresh",
  "@eslint/js",
  "globals",
];
export const LOCKFILE_POLICY =
  "A lockfile or manifest difference is tooling information, not a source lint result. " +
  "The source comparison always uses the base commit's frozen install and lint configuration. " +
  "When any tooling file differs, the head is also linted natively with its own frozen install " +
  "and configuration; a failed head install or native run stays a visible failure. " +
  "Neither lockfile is regenerated or deleted.";

export class InfrastructureError extends Error {}

export function unquoteGitPath(p) {
  if (!p.startsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push({ n: 10, t: 9, '"': 34, "\\": 92 }[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Parse `git diff -M --unified=0` output. Returns one entry per file with its
 * status, old/new paths, hunks and the set of added new-side line numbers.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  const stripPrefix = (p, prefix) => {
    const u = unquoteGitPath(p);
    return u === "/dev/null" ? null : u.startsWith(prefix) ? u.slice(prefix.length) : u;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { status: "M", oldPath: null, newPath: null, hunks: [], added: new Set() };
      files.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("new file mode")) {
      cur.status = "A";
    } else if (line.startsWith("deleted file mode")) {
      cur.status = "D";
    } else if (line.startsWith("rename from ")) {
      cur.status = "R";
      cur.oldPath = unquoteGitPath(line.slice(12));
    } else if (line.startsWith("rename to ")) {
      cur.newPath = unquoteGitPath(line.slice(10));
    } else if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4), "a/");
      if (p != null) cur.oldPath = p;
    } else if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4), "b/");
      if (p != null) cur.newPath = p;
    } else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] == null ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] == null ? 1 : Number(m[4]),
      };
      cur.hunks.push(hunk);
      for (let n = 0; n < hunk.newCount; n++) cur.added.add(hunk.newStart + n);
    }
  }
  for (const f of files) {
    if (f.status === "A") f.oldPath = null;
    if (f.status === "D") f.newPath = null;
  }
  return files;
}

/** Map a head line to its base line through one file's hunks; null when the line is new. */
export function mapLine(hunks, line) {
  let delta = 0;
  for (const h of hunks) {
    if (h.newCount && line >= h.newStart && line < h.newStart + h.newCount) return null;
    const boundary = h.newCount ? h.newStart + h.newCount : h.newStart + 1;
    if (line >= boundary) delta += h.oldCount - h.newCount;
  }
  return line + delta;
}

// Some messages cite another line ("at line 216"); reformatting moves it.
const messageShape = (message) => message.replace(/\bline \d+/g, "line N");

/**
 * Gives each diagnostic the anchors a rewrapped copy of it must share.
 *
 * Code is compared as a layout-insensitive structure: a pre-order walk of the
 * syntax tree that records every node kind with explicit nesting plus every
 * leaf token. Only what Prettier may add, drop or move is skipped: whitespace,
 * comments, parentheses, commas, semicolons, union bars, empty statements and
 * `{" "}` JSX spacers. Quotes and number spellings are normalized. Because
 * node kinds and nesting stay in the stream, skipping that punctuation never
 * makes two different programs equal.
 *
 * - statement: the enclosing top-level statement's whole structure and the
 *   diagnostic's token offset in it. Every diagnostic gets this anchor.
 * - named: the innermost enclosing function whose path from the file root is
 *   all stable unique names (function, variable declarator, property key,
 *   class + member, export default), with that function's structure and the
 *   token offset in it. Each name must be unique in its parent. Any other step
 *   (a block, callback argument, JSX attribute, anonymous class...) gives no
 *   named anchor. Sibling order is never part of an identity.
 *
 * Uses the toolchain's own TypeScript parser; without it there are no anchors.
 */
export function anchorAnalyzer(ts) {
  const K = ts.SyntaxKind;
  const FUNCTION_KINDS = new Set([
    K.FunctionDeclaration,
    K.FunctionExpression,
    K.ArrowFunction,
    K.MethodDeclaration,
    K.Constructor,
    K.GetAccessor,
    K.SetAccessor,
  ]);
  // Tokens Prettier adds, drops or moves when it rewraps code.
  const LAYOUT_TOKENS = new Set([
    K.CommaToken,
    K.SemicolonToken,
    K.OpenParenToken,
    K.CloseParenToken,
    K.BarToken,
    K.AmpersandToken,
  ]);
  const isJsDoc = (n) => n.kind >= K.FirstJSDocNode && n.kind <= K.LastJSDocNode;
  const kindFor = (file) => {
    if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
    if (/\.[cm]?ts$/i.test(file)) return ts.ScriptKind.TS;
    if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
  };
  // Nodes whose presence is layout only; their children still count.
  const transparent = (n) =>
    n.kind === K.SyntaxList ||
    n.kind === K.ParenthesizedExpression ||
    n.kind === K.ParenthesizedType ||
    ((n.kind === K.UnionType || n.kind === K.IntersectionType) && n.types.length === 1);
  const skipped = (n) =>
    isJsDoc(n) ||
    n.kind === K.EmptyStatement ||
    n.kind === K.EndOfFileToken ||
    (n.kind === K.JsxExpression &&
      n.expression &&
      ts.isStringLiteral(n.expression) &&
      !n.expression.text.trim());

  function structure(node, sf, out) {
    if (skipped(node)) return;
    const kids = node.getChildren(sf);
    if (kids.length) {
      const marked = !transparent(node);
      if (marked) out.push({ text: `<${K[node.kind]}` });
      for (const k of kids) structure(k, sf, out);
      if (marked) out.push({ text: ">" });
      return;
    }
    // A leading `|`/`&` is layout; a binary one is an operator. A `for (;;)`
    // header's semicolons say which clause is present.
    if (
      LAYOUT_TOKENS.has(node.kind) &&
      node.parent?.kind !== K.BinaryExpression &&
      !(node.kind === K.SemicolonToken && node.parent?.kind === K.ForStatement)
    ) {
      return;
    }
    let text;
    if (ts.isStringLiteral(node) || node.kind === K.NoSubstitutionTemplateLiteral) {
      text = `s:${JSON.stringify(node.text)}`;
    } else if (node.kind === K.NumericLiteral) {
      text = `n:${Number(node.text.replace(/_/g, ""))}`;
    } else if (node.kind === K.JsxText) {
      text = node.text.replace(/\s+/g, "");
      if (!text) return;
      text = `j:${text}`;
    } else {
      text = node.getText(sf);
    }
    out.push({ end: node.getEnd(), text });
  }

  const unwrap = (n) => {
    let child = n;
    let p = n.parent;
    while (p && p.kind === K.ParenthesizedExpression) {
      child = p;
      p = p.parent;
    }
    return { child, p };
  };
  const plainName = (name) =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      ? name.text
      : null;

  return function analyze(file, source) {
    if (typeof source !== "string") return null;
    let sf;
    try {
      sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kindFor(file));
    } catch {
      return null;
    }

    // Names bound directly in a container, for the uniqueness check.
    const nameCounts = new Map();
    const countsFor = (container) => {
      let counts = nameCounts.get(container);
      if (counts) return counts;
      counts = new Map();
      const add = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
      const members =
        ts.isSourceFile(container) || ts.isBlock(container)
          ? container.statements
          : ts.isClassLike(container)
            ? container.members
            : container.properties;
      for (const s of members) {
        if (ts.isVariableStatement(s)) {
          for (const d of s.declarationList.declarations) add(plainName(d.name) ?? "\0");
        } else if (ts.isExportAssignment(s)) {
          add("\0export-default");
        } else if (s.name) {
          add(plainName(s.name) ?? "\0");
        } else if (s.kind === K.Constructor) {
          add("constructor");
        }
      }
      nameCounts.set(container, counts);
      return counts;
    };
    const unique = (container, name) => name != null && countsFor(container).get(name) === 1;
    // A container's own path: the file root, or a named scope.
    const isFunctionBody = (n) => ts.isBlock(n) && n.parent && FUNCTION_KINDS.has(n.parent.kind);
    function statementHost(statement) {
      const host = statement.parent;
      if (ts.isSourceFile(host)) return { host, path: [] };
      if (isFunctionBody(host)) {
        const path = namedPath(host.parent);
        return path ? { host, path } : null;
      }
      return null;
    }
    // The step a function, class or object literal takes from its binding.
    function bindingStep(n) {
      const { p } = unwrap(n);
      if (!p) return null;
      if (ts.isVariableDeclaration(p) && ts.isVariableDeclarationList(p.parent)) {
        const statement = p.parent.parent;
        const name = plainName(p.name);
        if (!statement || !ts.isVariableStatement(statement)) return null;
        const at = statementHost(statement);
        return at && unique(at.host, name) ? [...at.path, `var:${name}`] : null;
      }
      if (ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) {
        const name = plainName(p.name);
        const path = bindingStep(p.parent);
        return path && unique(p.parent, name) ? [...path, `prop:${name}`] : null;
      }
      if (ts.isPropertyDeclaration(p) && ts.isClassLike(p.parent)) {
        const name = plainName(p.name);
        const path = classPath(p.parent);
        return path && unique(p.parent, name) ? [...path, `field:${name}`] : null;
      }
      if (ts.isExportAssignment(p) && !p.isExportEquals && ts.isSourceFile(p.parent)) {
        return unique(p.parent, "\0export-default") ? ["export-default"] : null;
      }
      return null;
    }
    function classPath(c) {
      if (ts.isClassDeclaration(c)) {
        const name = plainName(c.name);
        const at = statementHost(c);
        return at && unique(at.host, name) ? [...at.path, `class:${name}`] : null;
      }
      return bindingStep(c);
    }
    const namedPaths = new Map();
    function namedPath(fn) {
      if (namedPaths.has(fn)) return namedPaths.get(fn);
      let path = null;
      const p = fn.parent;
      if (ts.isFunctionDeclaration(fn)) {
        const name = plainName(fn.name);
        const at = statementHost(fn);
        if (at && unique(at.host, name)) path = [...at.path, `function:${name}`];
      } else if (fn.kind === K.Constructor || ts.isMethodDeclaration(fn) || ts.isAccessor(fn)) {
        const name = fn.kind === K.Constructor ? "constructor" : plainName(fn.name);
        const prefix = K[fn.kind];
        if (ts.isClassLike(p)) {
          const at = classPath(p);
          if (at && unique(p, name)) path = [...at, `${prefix}:${name}`];
        } else if (ts.isObjectLiteralExpression(p)) {
          const at = bindingStep(p);
          if (at && unique(p, name)) path = [...at, `${prefix}:${name}`];
        }
      } else if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        path = bindingStep(fn);
      }
      namedPaths.set(fn, path);
      return path;
    }

    const cache = new Map();
    const shape = (node) => {
      let data = cache.get(node);
      if (!data) {
        const list = [];
        structure(node, sf, list);
        const hash = crypto
          .createHash("sha256")
          .update(JSON.stringify(list.map((t) => t.text)))
          .digest("hex");
        data = { list, hash };
        cache.set(node, data);
      }
      return data;
    };
    const anchor = (kind, node, pos, path = null) => {
      const { list, hash } = shape(node);
      const token = list.findIndex((t) => t.end != null && t.end > pos);
      if (token < 0) return null;
      const id = crypto
        .createHash("sha256")
        .update(JSON.stringify([kind, path, hash]))
        .digest("hex");
      return { kind, id, token, ...(path ? { path: path.join(" > ") } : {}) };
    };

    return function locate(line, column) {
      if (!line) return null;
      let pos;
      try {
        pos = sf.getPositionOfLineAndCharacter(line - 1, Math.max(0, column - 1));
      } catch {
        return null;
      }
      let node = sf;
      for (;;) {
        const next = node
          .getChildren(sf)
          .find((c) => !isJsDoc(c) && c.getStart(sf) <= pos && pos < c.getEnd());
        if (!next) break;
        node = next;
      }
      let statement = null;
      let named = null;
      for (let n = node; n && n !== sf; n = n.parent) {
        if (!named && FUNCTION_KINDS.has(n.kind)) {
          const path = namedPath(n);
          if (path) named = anchor("named", n, pos, path);
        }
        if (n.parent === sf) statement = anchor("statement", n, pos);
      }
      const anchors = [statement, named].filter(Boolean);
      return anchors.length ? { anchors } : null;
    };
  };
}

/** The toolchain's TypeScript, as the anchor analyzer; null when unavailable. */
export function loadAnchorAnalyzer(toolchain) {
  try {
    return anchorAnalyzer(createRequire(path.join(toolchain, "package.json"))("typescript"));
  } catch {
    return null;
  }
}

export function normalize(results, cwd, analyzer = null) {
  return results.flatMap((r) => {
    const file = path.relative(cwd, r.filePath).split(path.sep).join("/");
    const locate = analyzer && r.messages.length ? analyzer(file, r.source) : null;
    return r.messages.map((m) => ({
      file,
      rule: m.ruleId ?? (m.fatal ? "fatal/parse" : "eslint/unknown"),
      severity: m.severity,
      line: m.line ?? 0,
      column: m.column ?? 0,
      message: m.message,
      anchors: locate?.(m.line, m.column)?.anchors ?? [],
    }));
  });
}

export const totals = (items) => ({
  errors: items.filter((m) => m.severity === 2).length,
  warnings: items.filter((m) => m.severity === 1).length,
  files: new Set(items.map((m) => m.file)).size,
});

/**
 * Pure comparison. `comparison` is the parsed base-tip→head diff, `scope` the
 * parsed merge-base→head diff.
 */
export function compareDiagnostics({ base, head, comparison, scope }) {
  const byNew = new Map(comparison.filter((f) => f.newPath).map((f) => [f.newPath, f]));
  const touched = new Set(scope.filter((f) => f.newPath).map((f) => f.newPath));
  const added = new Map(scope.filter((f) => f.newPath).map((f) => [f.newPath, f.added]));

  const key = (file, rule, severity, line, column, message) =>
    JSON.stringify([file, rule, severity, line, column, message]);
  const available = new Map();
  base.forEach((m, i) => {
    const k = key(m.file, m.rule, m.severity, m.line, m.column, m.message);
    available.set(k, [...(available.get(k) ?? []), i]);
  });
  const used = new Set();
  const inherited = [];
  const reformatted = [];
  const introduced = [];
  const unmatched = [];
  for (const m of head) {
    const diff = byNew.get(m.file);
    let baseFile = m.file;
    let baseLine = m.line;
    if (diff) {
      baseFile = diff.status === "A" ? null : diff.oldPath;
      baseLine = baseFile == null ? null : mapLine(diff.hunks, m.line);
    }
    let index;
    if (baseFile != null && baseLine != null) {
      const k = key(baseFile, m.rule, m.severity, baseLine, m.column, m.message);
      index = (available.get(k) ?? []).find((i) => !used.has(i));
      // Prettier reports whole-file diff groups; an edit elsewhere can change the
      // wording/column of a violation on an unchanged line. Same rule on the same
      // mapped line already failed at base.
      if (index == null && m.rule === "prettier/prettier") {
        const i = base.findIndex(
          (b, j) =>
            !used.has(j) &&
            b.file === baseFile &&
            b.line === baseLine &&
            b.rule === m.rule &&
            b.severity === m.severity,
        );
        if (i >= 0) index = i;
      }
    }
    if (index != null) {
      used.add(index);
      inherited.push(m);
    } else {
      unmatched.push({ m, diff, baseFile });
    }
  }

  // Second pass, after every exact match is taken: a diagnostic whose line was
  // rewrapped or moved still matches one unused base diagnostic in the same
  // (rename-mapped) file with the same rule, severity and message (cited line
  // numbers aside) and a shared anchor: an identical whole top-level statement,
  // or an identical function at the same all-named path, with the diagnostic at
  // the same token offset in it. Anything less is introduced.
  const anchorKey = (file, m, a) =>
    JSON.stringify([file, m.rule, m.severity, messageShape(m.message), a.id, a.token]);
  const byAnchor = new Map();
  base.forEach((b, i) => {
    if (used.has(i)) return;
    for (const a of b.anchors ?? []) {
      const k = anchorKey(b.file, b, a);
      byAnchor.set(k, [...(byAnchor.get(k) ?? []), i]);
    }
  });
  for (const { m, diff, baseFile } of unmatched) {
    if (baseFile != null) {
      let index;
      for (const a of m.anchors ?? []) {
        index = (byAnchor.get(anchorKey(baseFile, m, a)) ?? []).find((i) => !used.has(i));
        if (index != null) break;
      }
      if (index != null) {
        used.add(index);
        inherited.push(m);
        reformatted.push(m);
        continue;
      }
    }
    let classification;
    if (touched.has(m.file)) {
      classification = added.get(m.file)?.has(m.line) ? "added_line" : "changed_context";
    } else if (diff) {
      classification = "base_drift";
    } else {
      classification = "unexplained_unchanged_file";
    }
    introduced.push({ ...m, classification });
  }
  const resolved = base.filter((_, i) => !used.has(i));
  if (
    inherited.length + introduced.length !== head.length ||
    used.size + resolved.length !== base.length
  ) {
    throw new InfrastructureError("Unaccounted lint diagnostics");
  }
  const onAddedLines = head.filter((m) => added.get(m.file)?.has(m.line));
  return { inherited, reformatted, introduced, resolved, onAddedLines, touched };
}

function git(repo, args, opts = {}) {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: repo,
    encoding: opts.encoding ?? "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function blobHash(repo, sha, file) {
  try {
    return git(repo, ["rev-parse", `${sha}:${file}`]).trim();
  } catch {
    return null;
  }
}

const sha256 = (p) =>
  fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null;

function packageVersions(toolchain) {
  return Object.fromEntries(
    VERSIONED_PACKAGES.map((name) => {
      const p = path.join(toolchain, "node_modules", name, "package.json");
      return [name, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).version : null];
    }),
  );
}

function addWorktree(repo, dir, sha) {
  git(repo, ["worktree", "add", "--detach", "--force", dir, sha]);
}

function linkToolchain(tree, toolchain) {
  const target = path.join(toolchain, "node_modules");
  if (!fs.existsSync(target)) throw new InfrastructureError(`No node_modules in ${toolchain}`);
  fs.symlinkSync(target, path.join(tree, "node_modules"), "dir");
}

async function expectedLintedFiles(tree, toolchain) {
  const api = path.join(toolchain, "node_modules", "eslint", "lib", "api.js");
  if (!fs.existsSync(api)) throw new InfrastructureError(`No ESLint API in ${toolchain}`);
  const { ESLint } = await import(pathToFileURL(api).href);
  const eslint = new ESLint({ cwd: tree });
  const files = git(tree, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const expected = [];
  for (const file of files) {
    if (!fs.existsSync(path.join(tree, file))) continue;
    if (await eslint.isPathIgnored(file)) continue;
    if ((await eslint.calculateConfigForFile(file)) === undefined) continue;
    expected.push(file);
  }
  return expected;
}

/** Run the full-lint invocation (`eslint . --format json`) and validate the artifact. */
export async function runEslint(tree, toolchain, eslintBin, label, output) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [eslintBin, ".", "--format", "json"], {
    cwd: tree,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const record = {
    label,
    command: ["node", path.relative(tree, eslintBin) || eslintBin, ".", "--format", "json"],
    exitStatus: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    stderrTail: (result.stderr ?? "").slice(-4000),
  };
  fs.writeFileSync(path.join(output, `${label}-eslint.stdout.json`), result.stdout ?? "");
  if (result.error)
    throw new InfrastructureError(`${label}: ESLint did not start: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new InfrastructureError(
      `${label}: ESLint exit ${result.status ?? result.signal} is a configuration/crash/usage failure: ${record.stderrTail}`,
    );
  }
  let results;
  try {
    results = JSON.parse(result.stdout);
  } catch (e) {
    throw new InfrastructureError(`${label}: ESLint JSON output is unreadable: ${e.message}`);
  }
  if (!Array.isArray(results))
    throw new InfrastructureError(`${label}: ESLint output is not a result list`);
  const linted = new Set(
    results.map((r) => path.relative(tree, r.filePath).split(path.sep).join("/")),
  );
  const expected = await expectedLintedFiles(tree, toolchain);
  const missing = expected.filter((f) => !linted.has(f));
  if (missing.length) {
    throw new InfrastructureError(
      `${label}: incomplete ESLint artifact, ${missing.length} expected file(s) missing, e.g. ${missing.slice(0, 5).join(", ")}`,
    );
  }
  // ESLint exits 1 exactly when an error diagnostic exists; warnings alone exit 0.
  if ((result.status === 1) !== results.some((r) => r.errorCount > 0)) {
    throw new InfrastructureError(
      `${label}: exit ${result.status} disagrees with the reported error count`,
    );
  }
  record.lintedFiles = linted.size;
  record.expectedFiles = expected.length;
  return { results, record };
}

function writeJson(output, name, data) {
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

function perFile(files, sets) {
  return [...files].sort().map((file) => ({
    file,
    ...Object.fromEntries(
      Object.entries(sets).map(([name, items]) => [
        name,
        totals(items.filter((m) => m.file === file)),
      ]),
    ),
  }));
}

export async function main(env = process.env) {
  const repo = path.resolve(env.LINT_REPO ?? process.cwd());
  const output = path.resolve(
    env.LINT_OUTPUT ?? path.join(env.RUNNER_TEMP ?? os.tmpdir(), "lint-comparison"),
  );
  fs.mkdirSync(output, { recursive: true });
  const summary = { status: "infrastructure_failure", startedAt: new Date().toISOString() };
  const work = fs.mkdtempSync(path.join(env.RUNNER_TEMP ?? os.tmpdir(), "lint-trees-"));
  const trees = [];
  try {
    const baseSha = env.LINT_BASE_SHA ?? "";
    const headSha = env.LINT_HEAD_SHA ?? "";
    if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
      throw new InfrastructureError(
        "LINT_BASE_SHA and LINT_HEAD_SHA must be full lowercase 40-hex SHAs",
      );
    }
    for (const sha of [baseSha, headSha]) {
      try {
        git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
      } catch {
        throw new InfrastructureError(`Commit ${sha} is not present in ${repo}; fetch it first`);
      }
    }
    if (!env.LINT_TOOLCHAIN) throw new InfrastructureError("LINT_TOOLCHAIN is required");
    const toolchain = path.resolve(env.LINT_TOOLCHAIN);
    const eslintBin = path.resolve(
      env.LINT_ESLINT_BIN ?? path.join(toolchain, "node_modules", "eslint", "bin", "eslint.js"),
    );
    if (!fs.existsSync(eslintBin)) throw new InfrastructureError(`No ESLint CLI at ${eslintBin}`);
    let mergeBase;
    try {
      mergeBase = git(repo, ["merge-base", baseSha, headSha]).trim();
    } catch {
      throw new InfrastructureError("Base and head share no merge base");
    }

    const tooling = TOOLING.map((file) => {
      const base = blobHash(repo, baseSha, file);
      const head = blobHash(repo, headSha, file);
      const kind = LOCKFILES.includes(file)
        ? "lockfile"
        : MANIFESTS.includes(file)
          ? "manifest"
          : LINT_CONFIG.includes(file)
            ? "lint-config"
            : "other";
      return { file, kind, baseBlob: base, headBlob: head, changed: base !== head };
    });
    const toolingChanged = tooling.filter((t) => t.changed);
    Object.assign(summary, {
      baseSha,
      headSha,
      mergeBase,
      comparison: {
        diagnosticsBaseline: "base tip (pull_request.base.sha)",
        changedLineScope: "merge-base(base tip, head) → head",
        baseTipIsMergeBase: mergeBase === baseSha,
      },
      toolchain: {
        commonToolchain: "base commit frozen install + base commit lint configuration",
        node: process.version,
        bun: env.LINT_BUN_VERSION ?? null,
        packages: packageVersions(toolchain),
        toolchainLockfileSha256: Object.fromEntries(
          LOCKFILES.map((f) => [f, sha256(path.join(toolchain, f))]),
        ),
        invocation: "eslint . --format json",
      },
      tooling: {
        files: tooling,
        changed: toolingChanged.map((t) => t.file),
        policy: LOCKFILE_POLICY,
      },
      headInstall: env.LINT_HEAD_INSTALL ?? null,
    });

    const baseTree = path.join(work, "base");
    const headTree = path.join(work, "head");
    addWorktree(repo, baseTree, baseSha);
    trees.push(baseTree);
    addWorktree(repo, headTree, headSha);
    trees.push(headTree);
    const overlay = [];
    for (const file of LINT_CONFIG) {
      const from = path.join(baseTree, file);
      const to = path.join(headTree, file);
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, to);
        overlay.push({ file, action: "base copy" });
      } else if (fs.existsSync(to)) {
        fs.rmSync(to);
        overlay.push({ file, action: "removed head-only file" });
      }
    }
    summary.toolchain.headTreeConfigOverlay = overlay;
    summary.toolchain.lintConfigSha256 = Object.fromEntries(
      LINT_CONFIG.map((f) => [
        f,
        { base: sha256(path.join(baseTree, f)), headCommon: sha256(path.join(headTree, f)) },
      ]),
    );
    linkToolchain(baseTree, toolchain);
    linkToolchain(headTree, toolchain);

    const baseRun = await runEslint(baseTree, toolchain, eslintBin, "base", output);
    const headRun = await runEslint(headTree, toolchain, eslintBin, "head", output);
    summary.runs = [baseRun.record, headRun.record];
    const analyzer = loadAnchorAnalyzer(toolchain);
    summary.toolchain.rewrapMatching = analyzer
      ? "identical top-level statement or all-named function structure (toolchain typescript)"
      : "disabled: typescript not in toolchain; every unmatched diagnostic is introduced";
    const base = normalize(baseRun.results, baseTree, analyzer);
    const head = normalize(headRun.results, headTree, analyzer);

    const comparison = parseUnifiedDiff(
      git(repo, ["diff", "-M", "--unified=0", "--no-ext-diff", "--no-color", baseSha, headSha]),
    );
    const scope = parseUnifiedDiff(
      git(repo, ["diff", "-M", "--unified=0", "--no-ext-diff", "--no-color", mergeBase, headSha]),
    );
    const result = compareDiagnostics({ base, head, comparison, scope });
    const lintedHead = new Set(
      headRun.results.map((r) => path.relative(headTree, r.filePath).split(path.sep).join("/")),
    );
    const touchedLinted = [...result.touched].filter((f) => lintedHead.has(f));
    const gating = result.introduced.filter(
      (m) => m.classification === "added_line" || m.classification === "changed_context",
    );
    const unexplained = result.introduced.filter(
      (m) => m.classification === "unexplained_unchanged_file",
    );

    Object.assign(summary, {
      fullRepo: {
        base: totals(base),
        head: totals(head),
        headClean: head.length === 0,
        note: "Full-repository lint is reported as-is; an inherited backlog keeps it red.",
      },
      touchedFiles: {
        count: touchedLinted.length,
        base: totals(base.filter((m) => result.touched.has(m.file))),
        head: totals(head.filter((m) => result.touched.has(m.file))),
        renamed: scope
          .filter((f) => f.status === "R")
          .map((f) => ({ from: f.oldPath, to: f.newPath })),
        deleted: scope.filter((f) => f.status === "D").map((f) => f.oldPath),
      },
      addedLines: {
        count: scope.reduce((s, f) => s + (f.newPath ? f.added.size : 0), 0),
        diagnostics: totals(result.onAddedLines),
      },
      inherited: totals(result.inherited),
      inheritedAfterReformat: totals(result.reformatted),
      resolvedOrMoved: totals(result.resolved),
      introduced: {
        all: totals(result.introduced),
        addedLine: totals(result.introduced.filter((m) => m.classification === "added_line")),
        changedContext: totals(
          result.introduced.filter((m) => m.classification === "changed_context"),
        ),
        baseDrift: totals(result.introduced.filter((m) => m.classification === "base_drift")),
        unexplainedUnchangedFile: totals(unexplained),
      },
    });
    writeJson(output, "base-findings", base);
    writeJson(output, "head-findings", head);
    writeJson(output, "introduced-findings", result.introduced);
    writeJson(output, "resolved-or-moved-findings", result.resolved);
    writeJson(output, "added-line-findings", result.onAddedLines);
    writeJson(
      output,
      "touched-files",
      perFile(touchedLinted, {
        base: base,
        head,
        inherited: result.inherited,
        introduced: result.introduced,
      }),
    );

    let nativeFailures = [];
    if (toolingChanged.length) {
      if (!env.LINT_HEAD_TOOLCHAIN) {
        throw new InfrastructureError(
          `Tooling differs (${toolingChanged.map((t) => t.file).join(", ")}); LINT_HEAD_TOOLCHAIN is required for the native head run`,
        );
      }
      const headToolchain = path.resolve(env.LINT_HEAD_TOOLCHAIN);
      const nativeTree = path.join(work, "head-native");
      addWorktree(repo, nativeTree, headSha);
      trees.push(nativeTree);
      linkToolchain(nativeTree, headToolchain);
      const nativeRun = await runEslint(
        nativeTree,
        headToolchain,
        path.join(headToolchain, "node_modules", "eslint", "bin", "eslint.js"),
        "head-native",
        output,
      );
      const native = normalize(nativeRun.results, nativeTree);
      const added = new Map(scope.filter((f) => f.newPath).map((f) => [f.newPath, f.added]));
      nativeFailures = native.filter((m) => added.get(m.file)?.has(m.line));
      summary.native = {
        reason: "tooling differs; head linted with its own install and configuration",
        packages: packageVersions(headToolchain),
        run: nativeRun.record,
        fullRepo: totals(native),
        addedLines: totals(nativeFailures),
      };
      writeJson(output, "head-native-findings", native);
    }

    if (unexplained.length) {
      throw new InfrastructureError(
        `${unexplained.length} new diagnostic(s) in files identical at base and head: the toolchain is not deterministic`,
      );
    }
    const regression = gating.length > 0 || nativeFailures.length > 0;
    summary.status = regression ? "regression" : "pass";
    summary.gate = {
      rule: "Fail on diagnostics introduced in PR-touched files (added lines or changed context), and on native head diagnostics on PR-added lines when tooling differs.",
      failingDiagnostics: totals([...gating, ...nativeFailures]),
    };
    return regression ? 1 : 0;
  } catch (e) {
    summary.status = "infrastructure_failure";
    summary.error = e instanceof InfrastructureError ? e.message : `${e?.stack ?? e}`;
    return 2;
  } finally {
    summary.finishedAt = new Date().toISOString();
    writeJson(output, "summary", summary);
    for (const tree of trees.reverse()) {
      try {
        git(repo, ["worktree", "remove", "--force", tree]);
      } catch {
        // Leave the tree; its absence is not part of the result.
      }
    }
    fs.rmSync(work, { recursive: true, force: true });
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `### Lint comparison: ${summary.status}\n\n\`\`\`json\n${JSON.stringify(
          {
            baseSha: summary.baseSha,
            headSha: summary.headSha,
            mergeBase: summary.mergeBase,
            fullRepo: summary.fullRepo,
            touchedFiles: summary.touchedFiles && {
              count: summary.touchedFiles.count,
              head: summary.touchedFiles.head,
            },
            addedLines: summary.addedLines,
            introduced: summary.introduced,
            toolingChanged: summary.tooling?.changed,
            error: summary.error,
          },
          null,
          2,
        )}\n\`\`\`\n`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const code = await main();
  const summary = JSON.parse(
    fs.readFileSync(
      path.join(
        path.resolve(
          process.env.LINT_OUTPUT ??
            path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "lint-comparison"),
        ),
        "summary.json",
      ),
      "utf8",
    ),
  );
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = code;
}
