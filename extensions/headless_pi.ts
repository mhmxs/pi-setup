import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import * as headlessOutput from "./headless_output.cjs";

export default function (pi: any) {
  pi.registerTool({
    name: "run_headless_pi",
    description: "Executes a task in a headless sub-process using pi with TTY allocation.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Task instruction or command for the worker"
        },
        cwd: {
          type: "string",
          description: "Working directory for the worker process (defaults to current process CWD)"
        },
        provider: {
          type: "string",
          description: "Provider to use for the headless pi subprocess"
        },
        model: {
          type: "string",
          description: "Model to use for the headless pi subprocess"
        }
      },
      required: ["prompt"]
    },
    execute: async (args: any, context: any) => {
      const extractPrompt = (rawArgs: any, ctx: any): string => {
        if (!rawArgs) return "";

        if (typeof rawArgs === "object" && rawArgs !== null) {
          for (const key of ["prompt", "command", "task", "instruction", "text"]) {
            if (rawArgs[key] && typeof rawArgs[key] === "string") {
              return rawArgs[key];
            }
          }
          for (const val of Object.values(rawArgs)) {
            if (typeof val === "string" && val.trim() && !val.startsWith("call_")) {
              return val;
            }
          }
        }

        if (typeof rawArgs === "string" && !rawArgs.startsWith("call_")) {
          return rawArgs;
        }

        if (ctx && typeof ctx === "object") {
          if (ctx.prompt && typeof ctx.prompt === "string") return ctx.prompt;
          if (ctx.args && typeof ctx.args === "object" && ctx.args.prompt) return ctx.args.prompt;
        }

        return "";
      };

      let cleanPrompt = extractPrompt(args, context).trim();

      if (!cleanPrompt && typeof args === "string" && args.startsWith("call_")) {
        cleanPrompt = "list parent folder";
      }

      if (!cleanPrompt) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not extract valid prompt from arguments: ${JSON.stringify(args)}`
            }
          ],
          isError: true
        };
      }

      const targetCwd = args && typeof args === "object" && args.cwd
        ? path.resolve(args.cwd)
        : process.cwd();

      // Ensure local .headless log directory exists
      const headlessDir = path.join(targetCwd, ".headless");
      if (!fs.existsSync(headlessDir)) {
        fs.mkdirSync(headlessDir, { recursive: true });
      }

      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomBytes(3).toString("hex")}`;
      const logPath = path.join(headlessDir, `${runId}.log`);

      const provider = args && typeof args === "object" && args.provider
        ? String(args.provider)
        : "freetoken";
      const model = args && typeof args === "object" && args.model
        ? String(args.model)
        : "gtp-oss-20b";

      const formattedPrompt = `Execute the necessary tool or shell commands to complete the request below.\n\nPrompt: ${cleanPrompt}`;

      return new Promise((resolve) => {
        // Save log with metadata, prompt, followed by raw stdout/stderr output
        const saveLog = (rawData: string, metadata: Record<string, unknown> = {}) => {
          const logContent = `METADATA: ${JSON.stringify({
            runId,
            cwd: targetCwd,
            provider,
            model,
            ...metadata
          }, null, 2)}\n\nPROMPT: ${cleanPrompt}\n\n${rawData}`;
          try {
            fs.writeFileSync(logPath, logContent, "utf-8");
          } catch (err) {
            // Ignore write errors to prevent blowing up process return
          }
        };

        const dumpErrorAndResolve = (errorMessage: string, rawData: string, metadata: Record<string, unknown> = {}) => {
          saveLog(rawData, {
            status: "error",
            errorMessage,
            ...metadata
          });
          return resolve({
            content: [
              {
                type: "text",
                text: `${errorMessage}\n\nFull response logged to: ${logPath}`
              }
            ],
            isError: true
          });
        };

        const pythonPtyCmd = `import pty, os, sys; pty.spawn(['pi', '--mode', 'json', '--no-extensions', '--extension', 'npm:pi-graft', '--no-session', '--provider', sys.argv[2], '--model', sys.argv[3], '-p', sys.argv[1]])`;

        const child = spawn("python3", ["-c", pythonPtyCmd, formattedPrompt, provider, model], {
          cwd: targetCwd,
          env: {
            ...process.env,
            CI: "true",
            PYTHONUNBUFFERED: "1",
            TERM: "xterm-256color"
          },
          stdio: ["pipe", "pipe", "pipe"]
        });

        let output = "";

        child.stdin.end();

        const TIMEOUT_MS = 10 * 60 * 1000;
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          dumpErrorAndResolve("Execution timed out after 10 minutes.", output, {
            timeoutMs: TIMEOUT_MS
          });
        }, TIMEOUT_MS);

        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
          output += chunk.toString();
        });

        child.on("close", (code) => {
          clearTimeout(timer);

          const cleanText = headlessOutput.stripAnsi(output);

          const errors = [...cleanText.matchAll(new RegExp(/reflections allowed, stopping/i, "g"))];
          if (errors.length !== 0) {
            return dumpErrorAndResolve("Error: Max reflections allowed, stopping.", output, {
              exitCode: code
            });
          }

          // Parse NDJSON lines from worker output
          const lines = cleanText.split(/\r?\n/);
          let finalAnswer = "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;

            try {
              const event = JSON.parse(trimmed);

              if (event.type === "agent_end" && Array.isArray(event.messages)) {
                // Find the assistant message in agent_end
                const assistantMsg = event.messages
                  .slice()
                  .reverse()
                  .find((m: any) => m.role === "assistant");

                if (assistantMsg && Array.isArray(assistantMsg.content)) {
                  const textBlocks = assistantMsg.content
                    .filter((c: any) => c.type === "text" && typeof c.text === "string")
                    .map((c: any) => c.text);

                  if (textBlocks.length > 0) {
                    finalAnswer = textBlocks.join("\n").trim();
                  }
                }
              }
            } catch (e) {
              // Ignore invalid JSON lines
            }
          }

          if (code !== 0 || !finalAnswer) {
            const errReason = code !== 0
              ? `Worker process exited with code ${code}.`
              : "Worker completed, but no valid answer could be extracted from JSON output.";
            return dumpErrorAndResolve(`Error: ${errReason}`, output, {
              exitCode: code
            });
          }

          // Save log for successful execution
          saveLog(output, {
            status: "success",
            exitCode: code
          });

          resolve({
            content: [
              {
                type: "text",
                text: `${finalAnswer}\n\n(Run ID: ${runId})`
              }
            ],
            isError: false
          });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          dumpErrorAndResolve(`Failed to spawn worker process: ${err.message}`, output, {
            spawnError: err.message
          });
        });
      });
    }
  });
}