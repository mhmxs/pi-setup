# Headless orchestration prompts and extensions

## Overview
This repo defines a prompt-and-tool workflow for delegating coding tasks to headless `pi` runs: an orchestrator plans micro-steps, a worker executes focused edits, and helper extensions provide execution and decision checkpoints.

## Prompt files
- `prompts/orchestrator.md`
  - Master controller prompt.
  - Enforces **Graft-first orchestration** before dispatching work.
  - Requires **all edits** to be delegated through `run_headless_pi`.
  - Requires explicit `decision_maker` checkpoints at branch points (tool choice, retries, step escalation, snippet requests, non-edit delegation).
  - Requires a **second `decision_maker` call** to choose the GitHub Copilot model, then passing `provider: github-copilot` and `model` on delegated runs.
  - Caps plans to small micro-steps and keeps prompts tightly scoped.

- `prompts/headless.md`
  - Thin wrapper around a single `run_headless_pi` call.
  - Accepts optional `provider=<name>`, `model=<id>`, and `cwd=<path>` prefixes.
  - Forwards those values into structured tool args (not embedded in the prompt body).
  - Halts immediately on failure (no log forensics in-prompt).

- `prompts/worker.md`
  - Single-file worker prompt.
  - Oriented around targeted inspection, TDD-style test/implementation flow, and concise completion output.

## Extension files
- `extensions/headless_pi.ts`
  - Registers `run_headless_pi`.
  - Args: required `prompt`, optional `cwd`, `provider`, `model`.
  - Defaults: `cwd = process.cwd()`, `provider = github-copilot`, `model = gpt-5-mini`.
  - Spawns `pi` in JSON mode with no session and only `npm:pi-graft` loaded:
    - `--mode json --no-extensions --extension npm:pi-graft --no-session`

- `extensions/decision-maker.ts`
  - Registers `decision_maker`.
  - Uses external decisioning to choose among options at orchestration branch points.

- `extensions/headless_output.cjs`
  - Output helpers used by headless execution.
  - Strips ANSI noise and extracts final assistant answer text from raw subprocess output.

## `run_headless_pi` runtime behavior
- Builds a structured execution prompt and runs a headless subprocess.
- Writes execution logs to:
  - `~/.pi/agent/.headless/<runId>.log`
- Returns structured metadata including run ID, status, log path, completion flags, and final answer when available.
- Surfaces clear failure metadata for cases like spawn errors, timeout, extraction failures, or non-zero worker exit.
- Can return a `needs_input`-style failure when the worker asks for clarification before performing tool actions.

## Logging and failure model
- Every run records raw output plus final metadata in a per-run log file.
- Error responses include a concise display message and output tail for quick triage.
- Prompt-level wrappers are expected to stop on failure rather than continue speculative recovery.

## Realistic usage example
1. Use `prompts/orchestrator.md` to plan one micro-step for one file.
2. Call `decision_maker` to confirm the next action.
3. If using Copilot, call `decision_maker` again to choose a model.
4. Dispatch one delegated run via `run_headless_pi` with:
   - `prompt`: compact single-file instruction block
   - `cwd`: target repo/subdir (optional)
   - `provider`: `github-copilot` (when selected)
   - `model`: chosen Copilot model (when selected)
5. If the run returns `needs_input` or error status, stop and re-scope before retrying.

## Limitations
- The `run_headless_pi` extension itself is a general headless runner.
- The prompts in this repo intentionally constrain operation to **single-file micro-steps** with strict scope and minimal context.