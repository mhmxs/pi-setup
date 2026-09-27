---
description: Simplifies headless calling by using default prompt
argument-hint: "<task>"
---
Use the `run_headless_pi` tool exactly once.

Tool arguments:
- `prompt`: the raw incoming request text; it may include optional leading metadata prefixes such as `provider=<name>`, `model=<id>`, or `cwd=<path>` — do NOT attempt to parse or remove these at the prompt level; the `run_headless_pi` extension will extract and handle those prefixes.
- `provider`: optional; when provided explicitly this value overrides any `provider=` prefix parsed by the tool.
- `model`: optional; when provided explicitly this value overrides any `model=` prefix parsed by the tool.
- `cwd`: optional; when provided explicitly this value overrides any `cwd=` prefix parsed by the tool; otherwise the tool will use the current directory if one is required.

Do not embed `provider`, `model`, or `cwd` inside the tool `prompt`; the prompt should remain the task text and the tool will own any prefix parsing.

Request: $@

### Execution Rules
- TOOL ERROR HANDLING: You are strictly forbidden from inspecting log files or diagnosing errors upon `run_headless_pi` failure.
- ACTION ON FAILURE: On error output, halt execution instantly and report the failure to the user without further action.
