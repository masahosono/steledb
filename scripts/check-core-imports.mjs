#!/usr/bin/env node
/**
 * Checks that no `node:` builtin import has crept into the core, meaning the
 * shipped code outside src/node and src/cli. The core is meant to be bundled
 * for environments without a filesystem, such as Cloudflare Workers, so any
 * dependency on Node is confined to src/node/ and src/cli/.
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
      const rel = relative(SRC, path);
      if (rel === "node" || rel === "cli" || name === "testing") continue;
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
  console.error(`❌ node: imports have crept into the core (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("✅ core imports OK (no node: builtins outside src/node)");
