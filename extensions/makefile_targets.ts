import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "fs";
import os from "os";
import path from "path";

// Module-level cache: resolvedMakefilePath -> parsed target records (name + optional help text)
const makefileCache: Record<string, { name: string; help?: string }[]> = {};

function parseTargetsFromMakefile(content: string): { name: string; help?: string }[] {
  const targets: { name: string; help?: string }[] = [];
  const seen = new Set<string>();
  // Conservative regex: line starts with non-whitespace, capture up to ':' but avoid lines with '=' or '#' before ':'
  // This matches typical targets like `build:` or `test-unit:` and skips variable assignments like `VAR := value`.
  const re = /^([^\s:#=][^:\s#=]*):/;
  // Help comment matcher: inline '## description' later on the same line
  const helpRe = /##\s*(.*)$/;

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) {
      const name = m[1].trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        const helpMatch = helpRe.exec(line);
        const help = helpMatch ? helpMatch[1].trim() : undefined;
        targets.push({ name, help });
      }
    }
  }
  return targets;
}

function renderMakefileTargetsSkill() {
  return `# Makefile Targets (runtime)

This runtime SKILL.md exposes the native 'makefile_targets' tool provided by the extension.

Tool: ` + "`makefile_targets`" + `

Description:
Discover Makefile targets in a repository and return matching targets, optionally filtered by a query string.

Parameters:
- query: string (optional) — Case-insensitive substring to filter target names.
- cwd: string (optional) — Working directory to search for Makefile (defaults to process.cwd()).

Returns:
An object containing the makefile path, the query, and a list of matching targets (each: name and optional help text).
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
  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-makefile-targets-skill-'));
  let skillPathPromise: Promise<string> | null = null;

  pi.on('resources_discover', async () => {
    if (!skillPathPromise) {
      skillPathPromise = (async () => {
        return writeSkill(skillRoot, 'makefile-targets-runtime', renderMakefileTargetsSkill());
      })();
    }

    return {
      skillPaths: [await skillPathPromise]
    };
  });

  pi.on('session_shutdown', async () => {
    try { fs.rmSync(skillRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  pi.registerTool({
    name: "makefile_targets",
    label: "Makefile Targets",
    description: "Read Makefile targets (cached per-process) and return targets matching a query.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Case-insensitive substring to filter target names" })),
      cwd: Type.Optional(Type.String({ description: "Working directory to search for Makefile" })),
    }),

    async execute(_toolCallId, params) {
      try {
        const cwd = params.cwd ? String(params.cwd) : process.cwd();
        const tryPaths = [path.join(cwd, "Makefile"), path.join(cwd, "makefile")];

        let foundPath: string | null = null;
        for (const p of tryPaths) {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            foundPath = path.resolve(p);
            break;
          }
        }

        if (!foundPath) {
          return {
            content: [{ type: "text", text: `No Makefile found in ${cwd}` }],
            details: { error: true },
            isError: true,
          };
        }

        if (!makefileCache[foundPath]) {
          try {
            const raw = await fs.promises.readFile(foundPath, "utf8");
            makefileCache[foundPath] = parseTargetsFromMakefile(raw);
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to read/parse Makefile: ${(err as Error).message}` }],
              details: { error: true },
              isError: true,
            };
          }
        }

        const allTargets = makefileCache[foundPath] || [];
        const q = String(params.query || "").toLowerCase();
        const matches = q
          ? allTargets.filter((t) => t.name.toLowerCase().includes(q))
          : allTargets.slice(0, 100);

        const payload = {
          makefile: foundPath,
          query: params.query,
          targets: matches,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `makefile_targets failed: ${(err as Error).message}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  });
}
