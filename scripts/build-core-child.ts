#!/usr/bin/env bun
// Bundles src/bun/core-child.ts — the entry of the app's core child process
// (see src/bun/core-host.ts) — into out/core-child/core-child.js. Electrobun
// only bundles one bun entrypoint (src/bun/index.ts → Resources/app/bun/
// index.js), so electrobun.config.ts runs this as its preBuild hook and
// build.copy places the result next to it at Resources/app/bun/core-child.js,
// where src/bun/core-host.ts:resolveCoreChildEntry() looks for it. Same
// options electrobun uses for the main bundle (target bun, unminified).
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [path.join(root, "src/bun/core-child.ts")],
  outdir: path.join(root, "out/core-child"),
  target: "bun",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build-core-child] wrote ${path.relative(root, result.outputs[0]!.path)}`);
