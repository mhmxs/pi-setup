---
description: Simplifies headless calling by using default prompt
argument-hint: "[provider=<name>] [model=<id>] [cwd=<path>] <task>"
---
Use the `run_headless_pi` tool exactly once.

Tool arguments:
- `prompt`: the actual task body only; remove any leading `provider=<name>`, `model=<id>`, and `cwd=<path>` tokens before passing it
- `provider`: optional; when the request includes `provider=<name>`, forward that value as the named `provider` argument
- `model`: optional; when the request includes `model=<id>`, forward that value as the named `model` argument
- `cwd`: optional; when the request includes `cwd=<path>`, forward that value as the named `cwd` argument; otherwise use the current directory if the tool requires one

Do not embed `provider`, `model`, or `cwd` inside the tool `prompt`; the prompt must remain the task text.

Request: $@

### Execution Rules
- TOOL ERROR HANDLING: You are strictly forbidden from inspecting log files or diagnosing errors upon `run_headless_pi` failure.
- ACTION ON FAILURE: On error output, halt execution instantly and report the failure to the user without further action.
