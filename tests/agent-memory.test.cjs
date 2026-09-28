const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'agent-memory.ts'), 'utf8');

test('agent-memory should route decisions via decision_maker and not rely on env/HTTP helpers', () => {
  // Disallow direct environment-driven routing or dedicated HTTP helper
  assert.doesNotMatch(source, /MEMORY_DECISION_URL/, 'source must not depend on MEMORY_DECISION_URL-style routing');
  assert.doesNotMatch(source, /MEMORY_DECISION_TOKEN/, 'source must not depend on MEMORY_DECISION_TOKEN-style routing');
  assert.doesNotMatch(source, /MEMORY_NAMESPACE/, 'source must not depend on MEMORY_NAMESPACE-style routing');
  assert.doesNotMatch(source, /callDecisionEndpoint\(/, 'source must not call a callDecisionEndpoint helper');

  // Ensure both save_memory and query_memory route through decision_maker-based logic
  assert.match(source, /name\s*:\s*['"]save_memory['"][\s\S]*?decision_maker/, 'save_memory must route decision choices via decision_maker');
  assert.match(source, /name\s*:\s*['"]query_memory['"][\s\S]*?decision_maker/, 'query_memory must route decision choices via decision_maker');

  // General presence check that the decision_maker tool is referenced somewhere in the file
  assert.match(source, /decision_maker/, 'agent-memory must reference decision_maker as the routing mechanism for decisions');
});
