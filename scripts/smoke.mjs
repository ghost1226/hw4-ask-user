/**
 * Model-free smoke test: load the extension through Pi's REAL extension
 * loader (jiti) and assert the `ask_user` tool registers correctly.
 *
 * This does not open any picker and needs no model/credentials — it only
 * proves the file loads inside Pi's runtime.
 *
 * Run: npm run smoke
 */
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await discoverAndLoadExtensions(["./src/index.ts"], root);

if (result.errors.length > 0) {
  console.error("extension load errors:", JSON.stringify(result.errors, null, 2));
  process.exit(1);
}

const ext = result.extensions.find((e) => (e.sourceInfo?.path ?? "").includes("src/index.ts"));
if (!ext) {
  console.error("FAIL: extension at ./src/index.ts was not loaded");
  process.exit(1);
}

const tool = ext.tools.get("ask_user");
if (!tool) {
  console.error(`FAIL: ask_user not registered (found: ${[...ext.tools.keys()].join(", ") || "none"})`);
  process.exit(1);
}

const d = tool.definition;
const checks = {
  "name is ask_user": d.name === "ask_user",
  'exposure is "model-only"': d.exposure === "model-only",
  "has parameters schema": Boolean(d.parameters),
  "has outputSchema": Boolean(d.outputSchema),
  "has execute()": typeof d.execute === "function",
  "has renderCall/renderResult": typeof d.renderCall === "function" && typeof d.renderResult === "function",
  "registers /ask_user command": ext.commands instanceof Map && ext.commands.has("ask_user"),
};

console.log("loaded:", d.name, `(label: ${d.label}, mode: ${d.executionMode}, exposure: ${d.exposure})`);
let failed = false;
for (const [label, ok] of Object.entries(checks)) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failed = true;
}

if (failed) process.exit(1);
console.log("smoke: OK");
