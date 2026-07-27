#!/usr/bin/env node
/**
 * Copies the studio's front end into dist. tsc only emits TypeScript, so the
 * HTML / CSS / browser JS under src/studio/assets has to be carried across by
 * hand. The layout is kept identical on both sides, which is what lets
 * server.ts resolve the directory with `new URL("./assets/", import.meta.url)`
 * whether it is running from src (tests) or from dist (the published package).
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(REPO, "src/studio/assets");
const TARGET = join(REPO, "dist/studio/assets");

if (!existsSync(SOURCE)) {
  console.error(`❌ the studio assets are missing: ${SOURCE}`);
  process.exit(1);
}

cpSync(SOURCE, TARGET, { recursive: true });
console.log("✅ studio assets copied to dist/studio/assets");
