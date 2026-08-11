/**
 * The `shodh://commands` resource.
 *
 * This used to be a hand-written markdown list. It drifted: by the time the
 * capability map was written it advertised two tools that had never existed
 * (`recall_by_date`, `streaming_status`) and omitted eighteen that did, so an
 * agent reading it to discover capabilities would call tools that fail and miss
 * a third of the surface.
 *
 * It is now generated from the same arrays the server answers `tools/list` and
 * `prompts/list` from, so the three cannot disagree. `TOOL_GROUPS` only decides
 * which heading a tool is printed under; `renderCommandsResource` throws if a
 * declared tool has no group, or if a group names a tool that no longer exists.
 * A new tool therefore fails loudly at startup instead of silently vanishing
 * from the catalogue — the same contract `decorateTool()` enforces for
 * annotations and output schemas.
 */

export interface CommandsTool {
  name: string;
  description: string;
}

export interface CommandsPrompt {
  name: string;
  description: string;
}

/** Heading → tool names, in the order both should be printed. */
export const TOOL_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Store and retrieve", [
    "remember",
    "recall",
    "recall_by_tags",
    "read_memory",
    "list_memories",
    "context_summary",
    "proactive_context",
    "forget",
    "reinforce_memories",
  ]],
  ["Causal lineage", [
    "trace_lineage",
    "list_causal_edges",
    "add_causal_link",
    "validate_causal_link",
  ]],
  ["Knowledge graph", [
    "list_entities",
    "explore_entity",
  ]],
  ["Anomalies and distilled facts", [
    "list_anomalies",
    "search_facts",
    "fact_narratives",
    "purge_facts",
  ]],
  ["Tasks", [
    "add_todo",
    "list_todos",
    "update_todo",
    "complete_todo",
    "delete_todo",
    "reorder_todo",
    "todo_stats",
    "list_subtasks",
    "add_todo_comment",
    "list_todo_comments",
    "update_todo_comment",
    "delete_todo_comment",
    "add_project",
    "list_projects",
    "archive_project",
    "delete_project",
  ]],
  ["Reminders", [
    "set_reminder",
    "list_reminders",
    "dismiss_reminder",
  ]],
  ["Sessions and token accounting", [
    "session_digest",
    "session_history",
    "token_status",
    "reset_token_session",
  ]],
  ["Index, backups, maintenance", [
    "memory_stats",
    "verify_index",
    "repair_index",
    "consolidation_report",
    "backup_create",
    "backup_list",
    "backup_verify",
    "backup_purge",
    "backup_restore",
  ]],
];

/**
 * Tool descriptions are written for a model choosing between tools and run to
 * several sentences. The catalogue wants one line each, so take the first
 * sentence — enough to tell tools apart, without reprinting `tools/list`.
 */
export function firstSentence(description: string): string {
  const trimmed = description.trim();
  const match = /^.*?[.?!](?=\s|$)/.exec(trimmed);
  return (match ? match[0] : trimmed).trim();
}

export function renderCommandsResource(
  tools: readonly CommandsTool[],
  prompts: readonly CommandsPrompt[],
): string {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const grouped = new Set<string>();

  const lines: string[] = ["# Shodh-Memory Commands", ""];
  lines.push(
    `${tools.length} tools and ${prompts.length} prompts, generated from the server's own ` +
      "tool and prompt definitions.",
  );

  for (const [heading, names] of TOOL_GROUPS) {
    const rendered: string[] = [];
    for (const name of names) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(
          `shodh://commands lists tool "${name}" under "${heading}", but no such tool is declared. ` +
            "Remove it from TOOL_GROUPS in commands-resource.ts.",
        );
      }
      if (grouped.has(name)) {
        throw new Error(`shodh://commands lists tool "${name}" in more than one group.`);
      }
      grouped.add(name);
      rendered.push(`- **${name}** — ${firstSentence(tool.description)}`);
    }
    lines.push("", `## ${heading}`, "");
    lines.push(...rendered);
  }

  const ungrouped = tools.map((t) => t.name).filter((n) => !grouped.has(n));
  if (ungrouped.length > 0) {
    throw new Error(
      `shodh://commands has no group for: ${ungrouped.join(", ")}. ` +
        "Add each to TOOL_GROUPS in commands-resource.ts so the catalogue stays complete.",
    );
  }

  lines.push("", "## Slash commands (type / in chat)", "");
  for (const prompt of prompts) {
    lines.push(`- **/mcp__shodh-memory__${prompt.name}** — ${firstSentence(prompt.description)}`);
  }

  return `${lines.join("\n")}\n`;
}
