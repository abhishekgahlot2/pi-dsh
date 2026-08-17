// Sync the vendored Pi subset from upstream/pi-mono into vendor/pi.
// vendor/pi is machine-managed: edit this file list, never the files.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, "upstream", "pi-mono", "packages", "agent", "src");
const DST = path.join(ROOT, "vendor", "pi");

// Files: the loop trio + harness types/env/tools/session. No index barrels (telemetry),
// no AgentHarness facade, no reducer/records machinery, no compaction (we write our own).
const FILES = [
  "agent-loop.ts",
  "agent.ts",
  "types.ts",
  "stream-fn.ts",
  "harness/types.ts",
  "harness/messages.ts",
  "harness/env/nodejs.ts",
];
const DIRS = ["harness/tools", "harness/session", "harness/utils"];

function copyFile(rel) {
  const from = path.join(SRC, rel);
  const to = path.join(DST, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return rel;
}

function walk(dir) {
  return fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return walk(rel);
    return e.name.endsWith(".ts") ? [rel] : [];
  });
}

fs.rmSync(DST, { recursive: true, force: true });
const copied = [
  ...FILES.map(copyFile),
  ...DIRS.flatMap((d) => walk(d).map(copyFile)),
];
fs.copyFileSync(path.join(ROOT, "upstream", "pi-mono", "LICENSE"), path.join(DST, "LICENSE"));

const sha = execSync("git rev-parse HEAD", { cwd: path.join(ROOT, "upstream", "pi-mono") }).toString().trim();
fs.writeFileSync(
  path.join(DST, "UPSTREAM.json"),
  JSON.stringify({ repo: "badlogic/pi-mono", sha, syncedAt: new Date().toISOString(), files: copied }, null, 2) + "\n",
);
console.log(`synced ${copied.length} files from pi-mono@${sha.slice(0, 10)}`);
