import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
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
      let laya: any = null;

      try {
        // Dynamically import to avoid top-level require failures
        const { Laya } = await import("@receptron/laya");
        laya = await Laya.load();

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
      } finally {
        if (laya && typeof laya.close === "function") {
          await laya.close();
        }
      }
    },
  });
}