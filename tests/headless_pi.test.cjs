const assert = require('assert');
const path = require('path');
const os = require('os');

// Simulate the logic from extensions/headless_pi.ts
const targetCwd = process.cwd();
const headlessDir = path.join(targetCwd, '.headless');
const expectedDir = path.join(os.homedir(), '.pi', 'agent', '.headless');

// This test will fail with the current implementation, which uses targetCwd.
assert.strictEqual(headlessDir, expectedDir, `Headless log directory should be under home dir, but got ${headlessDir}`);

console.log('Test passed: headless log directory is correctly located.');