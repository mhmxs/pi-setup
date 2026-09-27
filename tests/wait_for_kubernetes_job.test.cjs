const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = path.join(__dirname, "..", "extensions", "wait_for_kubernetes_job.ts");
let source = "";
try {
  source = fs.readFileSync(sourcePath, "utf8");
} catch (err) {
  // Let tests run and fail with clear messages when the extension is missing.
  source = "";
}

test("registers a wait_for_kubernetes_job tool with the expected name", () => {
  assert.match(source, /name:\s*["']wait_for_kubernetes_job["']/, "expected the tool to be registered under the name wait_for_kubernetes_job");
});

test("parameters include jobName plus optional namespace and timeout-style options", () => {
  assert.match(source, /jobName/, "expected parameters to mention jobName");
  assert.match(source, /namespace/, "expected parameters to allow specifying a namespace");
  assert.match(source, /timeout|timeoutSeconds|maxWait|max_wait|pollInterval/i, "expected a timeout or polling-style parameter to be present");
  assert.match(source, /Type\.Optional\(/, "expected optional parameters to be declared with Type.Optional");
});

test("implementation waits/polls for job completion and inspects succeeded/failed status", () => {
  assert.match(source, /succeeded|failed|activeDeadlineSeconds|status\.succeeded|status\.failed|status\.conditions/i, "expected the implementation to check job success/failure conditions or statuses");
  assert.match(source, /poll|setInterval|setTimeout|while\s*\(|watch\(|await\s+new\s+Promise\(/i, "expected the implementation to poll or wait for job completion rather than returning immediately");
});

test("returns concise status and failure summaries and does not dump full logs", () => {
  assert.match(source, /status:\s*['\"][a-z_]+['\"]|summary:|failure:|taskCompleted|details:/i, "expected the tool to expose a concise status/summary field in its result");
  assert.doesNotMatch(source, /kubectl[^\n]*logs|\.logs\(|kubectl logs|dump logs|tail -n/i, "the waiter extension should not rely on dumping full kubectl logs in failure paths");
});
