---
name: decision-maker
description: Delegate ambiguous or trade-off-heavy choices to Laya System One via the decision_maker tool.
---

# Decision Maker

Use the `decision_maker` tool to query Laya System One whenever you face an ambiguous choice or trade-off.

## When
- Two or more valid approaches exist with distinct trade-offs (library choice, architecture, strategy).
- Requirements or paths are unclear and a wrong guess carries high cost.
- The user explicitly asks you to "decide", "pick", or "choose".

## Question & Context Framing Template

Laya System One evaluates options against the `question` (subject/instruction) and `context` (body). Structure your inputs using this format for best accuracy:

```text
Question:
Which [category/decision type] should be chosen for [goal/project]?

Options:
- [Option A]: [Short title]
- [Option B]: [Short title]
- [Option C]: [Short title]

Context:
- Primary Goal: [What we are trying to achieve]
- Constraints: [Budget, deadline, stack compatibility, team preference]
- Trade-offs:
  - [Option A]: [Pros / Cons]
  - [Option B]: [Pros / Cons]
- Unresolved Factor: [The core ambiguity requiring a decision]