// Gives the in-browser proof worker up to 10 minutes instead of 30 seconds.
// Without this, a slow proof times out and the SDK redoes it on the main thread,
// which freezes the page ("Page unresponsive").
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const files = ["node_modules/@cofhe/sdk/dist/web.js", "node_modules/@cofhe/sdk/dist/web.cjs"];
const from = /reject\(new Error\("Worker request timeout \(30s\)"\)\);\s*\}, 3e4\)/;
const to = 'reject(new Error("Worker request timeout (10min)"));\n      }, 6e5)';

for (const f of files) {
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  if (src.includes("Worker request timeout (10min)")) { console.log("[patch-cofhe] already patched:", f); continue; }
  if (!from.test(src)) { console.warn("[patch-cofhe] pattern not found, skipped:", f); continue; }
  writeFileSync(f, src.replace(from, to));
  console.log("[patch-cofhe] patched:", f);
}
