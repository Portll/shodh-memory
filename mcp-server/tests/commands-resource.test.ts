import { describe, it, expect } from "vitest";
import {
  renderCommandsResource,
  firstSentence,
  TOOL_GROUPS,
  type CommandsTool,
  type CommandsPrompt,
} from "../commands-resource";

const tool = (name: string, description = `Does ${name}. And more detail here.`): CommandsTool => ({
  name,
  description,
});

/** Every tool named in TOOL_GROUPS, which is what the real server passes in. */
const allGroupedTools = (): CommandsTool[] =>
  TOOL_GROUPS.flatMap(([, names]) => names.map((n) => tool(n)));

const prompts: CommandsPrompt[] = [
  { name: "quick_recall", description: "Search your memories for relevant context" },
];

describe("firstSentence", () => {
  it("takes the first sentence of a multi-sentence description", () => {
    expect(firstSentence("Store a memory. Use this for decisions.")).toBe("Store a memory.");
  });

  it("returns the whole string when there is no terminator", () => {
    expect(firstSentence("List all stored memories")).toBe("List all stored memories");
  });

  it("does not split on a decimal point or an abbreviation mid-sentence", () => {
    expect(firstSentence("Defaults to 2.0 sigma and ranks. Then stops.")).toBe(
      "Defaults to 2.0 sigma and ranks.",
    );
  });
});

describe("renderCommandsResource", () => {
  it("lists every declared tool exactly once", () => {
    const tools = allGroupedTools();
    const md = renderCommandsResource(tools, prompts);
    for (const t of tools) {
      const occurrences = md.split(`- **${t.name}** —`).length - 1;
      expect(occurrences, `tool ${t.name} should appear exactly once`).toBe(1);
    }
  });

  it("names no tool that is not declared", () => {
    const tools = allGroupedTools();
    const declared = new Set(tools.map((t) => t.name));
    const md = renderCommandsResource(tools, prompts);
    const listed = [...md.matchAll(/^- \*\*([a-z_]+)\*\* —/gm)]
      .map((m) => m[1])
      .filter((n) => !n.startsWith("/"));
    for (const name of listed) {
      expect(declared.has(name), `${name} is listed but not declared`).toBe(true);
    }
  });

  it("throws when a declared tool has no group, naming the tool", () => {
    const tools = [...allGroupedTools(), tool("brand_new_tool")];
    expect(() => renderCommandsResource(tools, prompts)).toThrow(/brand_new_tool/);
  });

  it("throws when a group names a tool that no longer exists", () => {
    const tools = allGroupedTools().filter((t) => t.name !== "recall");
    expect(() => renderCommandsResource(tools, prompts)).toThrow(/recall/);
  });

  it("renders prompts as slash commands", () => {
    const md = renderCommandsResource(allGroupedTools(), prompts);
    expect(md).toContain("/mcp__shodh-memory__quick_recall");
  });

  it("reports the real tool and prompt counts", () => {
    const tools = allGroupedTools();
    const md = renderCommandsResource(tools, prompts);
    expect(md).toContain(`${tools.length} tools and ${prompts.length} prompts`);
  });

  it("assigns each tool to exactly one group", () => {
    const seen = new Set<string>();
    for (const [, names] of TOOL_GROUPS) {
      for (const name of names) {
        expect(seen.has(name), `${name} appears in two groups`).toBe(false);
        seen.add(name);
      }
    }
  });
});
