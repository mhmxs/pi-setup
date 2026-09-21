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