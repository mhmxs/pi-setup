# Headless and Kubernetes orchestration prompts and extensions

## Overview
This repo defines prompt-and-tool workflows for delegating coding tasks to either local headless `pi` runs or Kubernetes Jobs: an orchestrator plans file-scoped micro-steps, a worker executes focused edits, and helper extensions provide headless execution, Kubernetes command dispatch, output extraction, and decision checkpoints.

## Prompt files
- `prompts/orchestrator.md`
  - Master controller prompt for the local headless runner path.
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

- `prompts/kubernetes.md`
  - Master controller prompt optimized for Kubernetes-backed orchestration.
  - Requires file-scoped work to run as Kubernetes **Jobs** managed through `exec_kubectl`.
  - Keeps the same Graft-first, micro-step, and `decision_maker` discipline while allowing up to **5 active per-file Jobs** at once.
  - Documents the shared `/workspace` mount, `pi-agent-config` secret prerequisite, and concise follow-up status checks for each Job.

## Extension files
- `extensions/headless_pi.ts`
  - Registers `run_headless_pi`.
  - Args: required `prompt`, optional `cwd`, `provider`, `model`.
  - Defaults: `cwd = process.cwd()`, `provider = github-copilot`, `model = gpt-5-mini`.
  - Spawns `pi` in JSON mode with no session and only `npm:pi-graft` loaded:
    - `--mode json --no-extensions --extension npm:pi-graft --no-session`

- `extensions/exec-kubectl.ts`
  - Registers `exec_kubectl`.
  - Executes exactly one non-interactive `kubectl` invocation using the configured cluster context.
  - Accepts kubectl arguments after the binary name, optional namespace override, optional STDIN for `apply -f -` / `replace -f -`, and optional retry-on-conflict settings.
  - Auto-resolves the namespace from the current ServiceAccount when available and returns structured success/error metadata for Job orchestration.

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

## `exec_kubectl` runtime behavior
- Wraps a single `kubectl` invocation and rejects shell chaining, embedded `kubectl` prefixes, and multiline commands.
- Uses an explicit namespace when provided, otherwise falls back to the current ServiceAccount namespace when that file is present.
- Supports STDIN payloads for manifest-driven commands such as `apply -f -` and `replace -f -`.
- Optionally retries conflict-prone apply/replace flows and returns structured `status`, `attempts`, `commandExecuted`, `stdout`, and `stderr` fields.

## Logging and failure model
- Every `run_headless_pi` invocation records raw output plus final metadata in a per-run log file.
- `exec_kubectl` returns structured command results directly so callers can make concise Job lifecycle decisions without pulling large logs into context.
- Error responses include a concise display message and output tail or stderr for quick triage.
- Prompt-level wrappers are expected to stop on failure rather than continue speculative recovery.

## Realistic usage example
1. Choose the orchestration path for the task:
   - Use `prompts/orchestrator.md` when a local headless `run_headless_pi` execution is appropriate.
   - Use `prompts/kubernetes.md` when you want per-file work dispatched as Kubernetes Jobs through `exec_kubectl`.
2. Use Graft to verify the exact target file for the next micro-step, then call `decision_maker` to confirm the next action.
3. For the local headless path, optionally call `decision_maker` again to choose a Copilot model, then dispatch one delegated run via `run_headless_pi` with a compact single-file prompt plus optional `cwd`, `provider`, and `model`.
4. For the Kubernetes path, use `exec_kubectl` to ensure prerequisites such as `pi-agent-config`, create one Job for one file-scoped worker prompt, and then wait/check status with follow-up `exec_kubectl` calls.
5. If either path returns a `needs_input` condition, Job failure, or error status, stop and re-scope before retrying.

## Limitations
- `run_headless_pi` remains the local general-purpose headless runner; the prompts here narrow it to tightly scoped single-file delegation.
- The Kubernetes workflow assumes a reachable local cluster, a shared host workspace mounted into worker Jobs at `/workspace`, and the required agent config secret.
- The prompts in this repo intentionally constrain operation to **single-file micro-steps** with strict scope and minimal context.
