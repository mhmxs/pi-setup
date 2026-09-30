import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "fs";
import os from "os";
import path from "path";

let layaPromise: Promise<any> | null = null;

async function getLaya() {
  if (!layaPromise) {
    layaPromise = import("@receptron/laya")
      .then(({ Laya }) => Laya.load())
      .catch((error) => {
        layaPromise = null;
        throw error;
      });
  }

  return layaPromise;
}

function renderDecisionMakerSkill() {
  return `# Decision Maker (runtime)

This runtime SKILL.md exposes the native 'decision_maker' tool provided by the extension.

Tool: ` + "`decision_maker`" + `

Description:
Ask the external decision maker service to choose between options. Use when a choice is ambiguous, has trade-offs, or needs an authoritative answer.

Parameters:
- question: string — The decision to be made, stated clearly.
- options: string[] (optional) — Candidate choices, if known.
- context: string (optional) — Relevant facts, constraints, trade-offs.

Example payload:

{
  "question": "Which deployment strategy should we use for the new feature?",
  "options": ["blue-green", "canary", "rolling"],
  "context": "Traffic patterns, rollback time, and team familiarity"
}
`;
}

function writeSkill(rootDir: string, skillName: string, content: string) {
  const skillDir = path.join(rootDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

export default function (pi: ExtensionAPI) {
  // create a per-execution temporary skill directory and expose a runtime SKILL.md
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-decision-maker-skill-'));
  let skillPathPromise: Promise<string> | null = null;

  pi.on('resources_discover', async () => {
    if (!skillPathPromise) {
      skillPathPromise = (async () => {
        return writeSkill(skillRoot, 'decision-maker-runtime', renderDecisionMakerSkill());
      })();
    }

    return {
      skillPaths: [await skillPathPromise]
    };
  });

  pi.on('session_shutdown', async () => {
    try { fs.rmSync(skillRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  // keep existing native tool registration intact
  pi.registerTool({
    name: "decision_maker",
    label: "Decision Maker",
    description:
      "Ask the external decision maker service to choose between options. " +
      "Use when a choice is ambiguous, has trade-offs, or needs an authoritative answer.",
    parameters: Type.Object({
      question: Type.String({ description: "The decision to be made, stated clearly" }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "Candidate choices, if known" })
      ),
      context: Type.Optional(
        Type.String({ description: "Relevant facts, constraints, trade-offs" })
      ),
    }),

    async execute(_toolCallId, params) {
      try {
        const laya = await getLaya();

        const criteriaObj: Record<string, string> = {};
        if (params.options && params.options.length > 0) {
          params.options.forEach((opt, idx) => {
            criteriaObj[opt || `option_${idx + 1}`] = opt;
          });
        } else {
          criteriaObj["yes"] = "Yes / Agree / Approve";
          criteriaObj["no"] = "No / Disagree / Reject";
        }

        const result = await laya.systemOne(
          {
            subject: params.question,
            body: params.context ?? "",
          },
          {
            decision: {
              type: "choice",
              instructions: params.question,
              criteria: criteriaObj,
            },
          }
        );

        const choice = result.answers.decision?.choice;
        const probabilities = result.answers.decision?.probabilities;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  selected_option: choice,
                  probabilities: probabilities,
                  usage: result.usage,
                },
                null,
                2
              ),
            },
          ],
          details: {
            selected: choice,
            probabilities,
            usage: result.usage,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Decision maker failed: ${(err as Error).message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  });
}
