const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'extensions', 'agent-memory.ts'), 'utf8');

test('agent-memory should route decisions via configurable decision endpoint and document merge/sort/eventual-consistency expectations', () => {
  // Require environment/config-driven routing variables for the decision service
  assert.match(source, /MEMORY_DECISION_URL/, 'source must reference MEMORY_DECISION_URL for the decision endpoint');
  assert.match(source, /MEMORY_DECISION_TOKEN/, 'source must reference MEMORY_DECISION_TOKEN for decision auth');
  assert.match(source, /MEMORY_NAMESPACE/, 'source must reference MEMORY_NAMESPACE for namespaced routing');

  // Ensure both save_memory and query_memory use the decision endpoint path or a decision-calling helper
  assert.match(source, /save_memory[\s\S]*?(decision(?:[-_ ]?endpoint|Endpoint|Url|URL)|\/v1\/decisions|callDecisionEndpoint)/i, 'save_memory must call the decision endpoint or a decision helper');
  assert.match(source, /query_memory[\s\S]*?(decision(?:[-_ ]?endpoint|Endpoint|Url|URL)|\/v1\/decisions|callDecisionEndpoint)/i, 'query_memory must call the decision endpoint or a decision helper');

  // The source should document/reflect the expected merge/sort/eventual-consistency behaviour and the supported surface
  assert.match(source, /(merge|merge\s*strategy|sort|eventual[- ]consistency|supported[- ]surface|supported\s*surface)/i, 'source should reflect merge/sort/eventual-consistency and supported-surface expectations');
});
