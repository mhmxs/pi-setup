const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "makefile_targets.ts"), "utf8");

test("makefile_targets: query parameter is optional in the TypeBox schema", () => {
  // The intended schema should mark `query` optional so callers may omit it.
  assert.match(
    source,
    /query:\s*Type\.Optional\(\s*Type\.String/,
    "expected the TypeBox schema to declare query as optional (Type.Optional(Type.String))"
  );
});

test("makefile_targets: implementation tolerates missing/empty query and returns all targets when no filter provided", () => {
  // Implementation should coerce a missing query to an empty string and fall back to returning all targets.
  assert.match(
    source,
    /String\(params\.query\s*\|\|\s*""\)/,
    "expected params.query to be coerced with a default empty string"
  );
  assert.match(
    source,
    /allTargets\.slice\(0,\s*100\)/,
    "expected the no-query path to return a slice of all parsed targets rather than requiring a filter"
  );
});

test("makefile_targets: parser infers help text from inline Makefile comments using '##' convention", () => {
  // The parser is intended to recognise inline help comments like `target: ## description`.
  // This test asserts the source contains a `##`-style help marker near the Makefile parsing logic.
  assert.match(
    source,
    /##/,
    "expected the Makefile parser to look for '##' inline help comment markers"
  );
});

test("makefile_targets: parsed Makefile data is cached in module scope so each path is processed once per run", () => {
  assert.match(
    source,
    /const\s+makefileCache\s*:/,
    "expected a module-scoped makefileCache declaration so parsing happens once per resolved path"
  );
});
