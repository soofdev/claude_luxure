import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { log } from "./logger";

// Resolve the absolute path to the `codex` CLI binary — the Codex counterpart
// of resolveClaudePath(). Same problem, same shape: a GUI editor process often
// doesn't inherit the shell PATH that has `codex` on it, and `codex` is a node
// shim, so a bare spawn fails with ENOENT (or "env: node: No such file").
//
// Resolution order:
//   1. The `claude-luxure.codexPath` setting (explicit override).
//   2. Common standalone-install locations.
//   3. The binary bundled with the official Codex editor extension.
//   4. Bare "codex" — PATH lookup as a last resort.

let cached: string | undefined;

export function resolveCodexPath(): string {
  if (cached) {
    return cached;
  }
  cached = computeCodexPath();
  log("INFO", `Resolved codex binary: ${cached}`);
  return cached;
}

/** Drop the cached resolution — call when the `codexPath` setting changes. */
export function clearCodexPathCache(): void {
  cached = undefined;
}

/** Whether a usable `codex` binary exists — gates the "Add Codex account" flow
 * so the user gets an install hint instead of a spawn ENOENT much later. */
export function hasCodexBinary(): boolean {
  return resolveCodexPath() !== "codex";
}

function computeCodexPath(): string {
  const configured = vscode.workspace
    .getConfiguration("claude-luxure")
    .get<string>("codexPath")
    ?.trim();
  if (configured) {
    const expanded = expandHome(configured);
    if (isExecutable(expanded)) {
      return expanded;
    }
    log(
      "WARN",
      `claude-luxure.codexPath is set to "${configured}" but it was not found or is not executable; auto-detecting instead.`
    );
  }

  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".local", "node", "bin", "codex"),
    path.join(home, ".codex", "bin", "codex"),
    path.join(home, ".bun", "bin", "codex"),
    "/usr/bin/codex",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      return c;
    }
  }

  const bundled = findBundledBinary(home);
  if (bundled) {
    return bundled;
  }

  log(
    "WARN",
    "Could not locate a `codex` binary; falling back to PATH lookup. If Codex sends fail with ENOENT, set claude-luxure.codexPath."
  );
  return "codex";
}

/** Find a `codex` shipped inside the official Codex editor extension. */
function findBundledBinary(home: string): string | undefined {
  const extRoots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".cursor-server", "extensions"),
    path.join(home, ".windsurf", "extensions"),
  ];

  let best: { version: number[]; binPath: string } | undefined;
  for (const root of extRoots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith("openai.chatgpt") && !name.startsWith("openai.codex")) {
        continue;
      }
      for (const rel of [
        ["binaries", "codex"],
        ["bin", "codex"],
        ["resources", "codex"],
      ]) {
        const binPath = path.join(root, name, ...rel);
        if (!isExecutable(binPath)) {
          continue;
        }
        const version = parseVersion(name);
        if (!best || compareVersion(version, best.version) > 0) {
          best = { version, binPath };
        }
      }
    }
  }
  return best?.binPath;
}

function parseVersion(dirName: string): number[] {
  const m = dirName.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) - (b[i] ?? 0);
    }
  }
  return 0;
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function isExecutable(p: string): boolean {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
