#!/usr/bin/env node
/**
 * コア（src/node 以外の出荷対象コード）に `node:` ビルトインへの import が
 * 混入していないことを検査する。コアは Cloudflare Workers 等の fs を持たない
 * 環境にバンドルされる前提のため、Node 依存は src/node/ に隔離する。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(REPO, "src");

const violations = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (relative(SRC, path) === "node" || name === "testing") continue;
      walk(path);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts") || name.endsWith(".test-d.ts")) continue;
    const content = readFileSync(path, "utf-8");
    for (const [index, line] of content.split("\n").entries()) {
      if (/from\s+["']node:|require\(\s*["']node:/.test(line)) {
        violations.push(`${relative(REPO, path)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
}

walk(SRC);

if (violations.length > 0) {
  console.error(`❌ コアに node: import が混入しています (${violations.length} 件):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("✅ core imports OK (no node: builtins outside src/node)");
