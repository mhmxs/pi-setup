const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "headless_pi.ts"), "utf8");

test("headless error responses include a visible last-two-lines preview for callers", () => {
  assert.match(source, /Full response logged to:/, "expected the existing log-path message to remain present");
  assert.match(source, /Last output lines:/, "expected a human-readable tail preview label in the error response");
  assert.match(source, /slice\(-2\)[\s\S]*?join\("\\n"\)/, "expected the error path to include the last two output lines");
});

test("prompt extraction fails closed instead of inventing prompts from unrelated arguments", () => {
  assert.match(source, /Could not extract valid prompt from arguments:/, "expected invalid prompt extraction to remain an explicit error");
  assert.doesNotMatch(source, /Object\.values\(rawArgs\)/, "should not pull the prompt from arbitrary argument values");
});

test("finalizeLogAndResolve is guarded so timeout, close, and error cannot settle twice", () => {
  assert.match(source, /let\s+isSettled\s*=\s*false;/, "expected a one-shot settlement flag near the shared finalize path");
  assert.match(source, /if\s*\(isSettled\)\s*return;/, "expected finalize to bail out after the first resolution");
  assert.match(source, /isSettled\s*=\s*true;/, "expected finalize to mark the run as settled before resolving");
});

test("worker output falls back to marker-based final answer extraction when NDJSON parsing misses", () => {
  assert.match(source, /finalAnswer\s*=\s*headlessOutput\.extractHeadlessFinalAnswer\(cleanText\)/, "expected a fallback to marker-based final answer extraction");
  assert.match(source, /extractHeadlessFinalAnswer\(cleanText\)[\s\S]*?Worker completed, but no valid answer could be extracted from JSON output\./, "expected the no-answer error to happen only after the fallback extraction attempt");
});
