---
description: Simplifies headless calling by using default prompt
---
run_headless_pi (cwd: current directory, prompt: `$@`)
### Execution Rules
- TOOL ERROR HANDLING: You are strictly forbidden from inspecting log files or diagnosing errors upon `run_headless_pi` failure. 
- ACTION ON FAILURE: On error output, halt execution instantly and report the failure to the user without further action.