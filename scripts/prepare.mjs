#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const huskyBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "husky.cmd" : "husky");

if (!existsSync(huskyBin)) {
  console.log("husky not installed; skipping git hook setup");
  process.exit(0);
}

const result = spawnSync(huskyBin, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error != null) {
  console.warn(`husky setup skipped: ${result.error.message}`);
  process.exit(0);
}

process.exit(result.status ?? 0);
