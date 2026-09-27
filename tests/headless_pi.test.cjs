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

test("headless prefix parsing extracts and strips leading provider/model/cwd tokens from raw strings and respects explicit args", () => {
  // Expect a regex or replace that recognizes leading provider=, model=, and cwd= tokens in a raw string prompt
  assert.match(source, /(?:^|\s)(?:provider|model|cwd)=/, "expected parsing of leading metadata tokens from raw string prompts");

  // Expect the code to strip those tokens from the prompt before composing the worker prompt
  assert.match(source, /cleanPrompt\s*=\s*cleanPrompt\.replace\(/, "expected metadata tokens to be removed from the worker prompt string");

  // Ensure structured args take precedence when present (toolParams.cwd / toolParams.provider / toolParams.model)
  assert.match(source, /toolParams\s*&&\s*typeof\s+toolParams\.cwd\s*===\s*\"string\"\s*\?\s*path\.resolve\(toolParams\.cwd\)/, "expected structured cwd to be preferred when provided");
  assert.match(source, /toolParams\s*&&\s*typeof\s+toolParams\.provider\s*===\s*\"string\"\s*\?\s*String\(toolParams\.provider\)/, "expected structured provider to be preferred when provided");
  assert.match(source, /toolParams\s*&&\s*typeof\s+toolParams\.model\s*===\s*\"string\"\s*\?\s*String\(toolParams\.model\)/, "expected structured model to be preferred when provided");
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

test("clarification-only runs are detected as needs_input instead of success", () => {
  assert.match(source, /status:\s*"needs_input"/, "expected a dedicated needs_input status for incomplete runs");
  assert.match(source, /taskCompleted:\s*false/, "expected incomplete clarification runs to mark taskCompleted false");
  assert.match(source, /Worker requested additional input before completing the task\./, "expected a stable machine-detectable clarification failure message");
});

test("needs_input detection uses both tool execution evidence and clarification heuristics", () => {
  assert.match(source, /toolExecutionCount\s*=\s*0;/, "expected worker parsing to track whether any tool execution occurred");
  assert.match(source, /event\.type\s*===\s*"tool_execution_end"/, "expected explicit tool execution events to count toward task completion evidence");
  assert.match(source, /const\s+looksLikeClarificationRequest\s*=\s*\(text: string\): boolean =>/, "expected a dedicated clarification classifier");
  assert.match(source, /but i\[’'\]ll need/i, "expected clarification heuristics to catch answers that say but I'll need more information");
  assert.match(source, /toolExecutionCount\s*===\s*0[\s\S]*looksLikeClarificationRequest\(finalAnswer\)/, "expected needs_input to require both no tool execution and a clarification-style answer");
});
