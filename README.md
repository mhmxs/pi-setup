# Headless Master/Worker Setup

## Overview
This repository provides a lightweight controller‑to‑headless‑worker architecture for running AI‑powered code edits. The core is the `run_headless_pi` tool, which spawns a headless `pi` process, executes prompts, and returns the final assistant text.

## Components
- **`extensions/headless_pi.ts`** – Implements `run_headless_pi`.
- **`prompts/orchestrator.md`** – Master controller prompt that uses Graft first and delegates edits to `run_headless_pi`.
- **`prompts/worker.md`** – Single‑file worker prompt that inspects the target, runs tests, implements the file, and refreshes Graft metadata.
- **`prompts/headless.md`** – Lightweight wrapper around `run_headless_pi` that sets the current directory and handles failures.
- **Graft graph** – Provides code location, call edges, and API signatures.

## How `run_headless_pi` works
1. Accepts a required `prompt` and optional `cwd`, `provider`, `model`.
2. Defaults: `cwd` = process cwd, `provider` = `freetoken`, `model` = `gtp-oss-20b`.
3. Spawns `pi` via `python3` + `pty.spawn(...)` with flags:
   ```
   --mode json --no-extensions --extension npm:pi-graft --no-session
   ```
4. Sends a formatted prompt: `Execute the necessary tool or shell commands to complete the request below.` followed by `Prompt: <cleanPrompt>`.
5. Timeout: 10 minutes.
6. Parses NDJSON output, looks for `agent_end`, extracts the final assistant text, and returns it with the run ID.

## Workflow
1. **Orchestrator** – The master prompt orchestrates the overall task, calls Graft, and delegates each file edit to `run_headless_pi`.
2. **Worker** – For each target file, the worker prompt inspects the file with Graft, runs tests first, implements the change, and refreshes Graft metadata.
3. **Headless Wrapper** – `prompts/headless.md` invokes `run_headless_pi` in the current directory; on failure it halts and reports the error.

## Logging and Failure Behavior
- Logs are written to `~/.pi/agent/.headless/<runId>.log`.
- Failure cases: missing prompt, timeout, spawn failure, non‑zero exit, no extractable final answer, or `reflections allowed, stopping`.
- On failure, the tool returns an error message and the log path; the headless wrapper does not inspect logs further.

## Example Usage
```bash
# Run a headless edit on a target file
pi run_headless_pi --prompt "Add a new function to utils.ts" --cwd ./src
```
The tool will spawn `pi`, execute the prompt, and output the final assistant text along with the run ID.

## Limitations
- Only one file is edited per headless run.
- The tool expects a clean prompt; malformed prompts result in failure.
