const test = require("node:test");
const assert = require("node:assert/strict");

const { extractHeadlessFinalAnswer } = require("../extensions/headless_output.cjs");

test("extracts the final summary from the last marker line and ignores later marker mentions in prose", () => {
  const output = `--------------------------------------------------------------------------------

► THINKING

Let's check the exact wording: write a clear one sentence summary of your action using the starting with 5UTR4 on its own line as your final answer.

[Output Generation]
Hi!

\u001b[32m5UTR4 I greeted the user as requested.\u001b[0m

Done.

Later commentary that mentions 5UTR4 again, but not at the start of a line.
5UTR4
Tokens: 842 sent, 408 received.`;

  assert.equal(extractHeadlessFinalAnswer(output), "I greeted the user as requested.");
});

test("supports a marker-only line followed by the summary on subsequent lines", () => {
  const output = `► ANSWER

5UTR4
I greeted the user as requested.
Warning: Input is not a terminal
Tokens: 10 sent, 5 received.`;

  assert.equal(extractHeadlessFinalAnswer(output), "I greeted the user as requested.");
});

test("returns an empty string when no marker line contains answer text", () => {
  const output = `Prompt instructions mention 5UTR4 here.

5UTR4
Warning: Input is not a terminal
Tokens: 10 sent, 5 received.`;

  assert.equal(extractHeadlessFinalAnswer(output), "");
});
