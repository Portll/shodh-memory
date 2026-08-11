import { describe, it, expect } from "vitest";
import {
  TOOL_ANNOTATIONS,
  TOOL_OUTPUT_SCHEMAS,
  READ_ONLY_TOOLS,
  isReadOnlyTool,
  decorateTool,
  type ToolDefinition,
} from "../tool-metadata";

const def = (name: string): ToolDefinition => ({
  name,
  description: "d",
  inputSchema: { type: "object", properties: {} },
});

describe("tool annotations", () => {
  it("covers every tool exactly once", () => {
    // The server declares 51 tools; decorateTool throws for anything missing,
    // so this count is the tripwire for a tool added without a judgement call.
    expect(Object.keys(TOOL_ANNOTATIONS)).toHaveLength(51);
  });

  it("gives every tool a display title", () => {
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(ann.title, `${name} has no title`).toBeTruthy();
    }
  });

  it("closes the world for every tool", () => {
    // The memory store is local and closed. The spec default is TRUE, so this
    // must be set explicitly everywhere or clients assume external reach.
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(ann.openWorldHint, `${name} should be closed-world`).toBe(false);
    }
  });

  it("sets destructive and idempotent explicitly on every mutating tool", () => {
    // destructiveHint defaults to TRUE when absent, so an unset hint on an
    // additive tool would wrongly mark it dangerous.
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      if (ann.readOnlyHint) continue;
      expect(typeof ann.destructiveHint, `${name} destructiveHint`).toBe("boolean");
      expect(typeof ann.idempotentHint, `${name} idempotentHint`).toBe("boolean");
    }
  });

  it("omits destructive/idempotent on read-only tools", () => {
    // The spec defines both as meaningful only when readOnlyHint is false.
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      if (!ann.readOnlyHint) continue;
      expect(ann.destructiveHint, `${name} destructiveHint`).toBeUndefined();
      expect(ann.idempotentHint, `${name} idempotentHint`).toBeUndefined();
    }
  });

  it("keeps isReadOnlyTool in sync with the annotations", () => {
    for (const [name, ann] of Object.entries(TOOL_ANNOTATIONS)) {
      expect(isReadOnlyTool(name)).toBe(Boolean(ann.readOnlyHint));
    }
    expect(READ_ONLY_TOOLS.size).toBe(
      Object.values(TOOL_ANNOTATIONS).filter((a) => a.readOnlyHint).length,
    );
  });
});

describe("data-loss hazard tools are never marked safe", () => {
  // Regression guard. A client that auto-approves readOnlyHint:true tools must
  // never be handed one of these. Flipping any of them to read-only is a
  // data-loss hazard, not a refactor.
  const mustBeDestructive = [
    "forget",
    "purge_facts",
    "delete_todo",
    "delete_project",
    "delete_todo_comment",
    "backup_purge",
    "backup_restore",
    "validate_causal_link",
    "update_todo",
    "update_todo_comment",
  ];

  for (const name of mustBeDestructive) {
    it(`${name} is destructive and not read-only`, () => {
      const ann = TOOL_ANNOTATIONS[name];
      expect(ann).toBeDefined();
      expect(ann.readOnlyHint).toBe(false);
      expect(ann.destructiveHint).toBe(true);
      expect(isReadOnlyTool(name)).toBe(false);
    });
  }

  // Names that read like queries but write. Verified against the handlers:
  // proactive_context defaults to auto_ingest:true, reset_token_session
  // persists a session-digest Context memory, repair_index re-indexes.
  const writesDespiteName = ["proactive_context", "reset_token_session", "repair_index"];

  for (const name of writesDespiteName) {
    it(`${name} writes despite its name`, () => {
      expect(TOOL_ANNOTATIONS[name].readOnlyHint).toBe(false);
      expect(isReadOnlyTool(name)).toBe(false);
    });
  }

  it("marks non-idempotent writers honestly", () => {
    // complete_todo re-completes and spawns another recurrence + memory;
    // add_project mints a fresh UUID; add_causal_link reinforces on repeat;
    // reinforce_memories compounds boosts.
    for (const name of ["complete_todo", "add_project", "add_causal_link", "reinforce_memories", "backup_create"]) {
      expect(TOOL_ANNOTATIONS[name].idempotentHint, name).toBe(false);
    }
  });
});

describe("output schemas", () => {
  it("declares an object at the root, as the spec requires", () => {
    for (const [name, schema] of Object.entries(TOOL_OUTPUT_SCHEMAS)) {
      expect(schema.type, `${name} root type`).toBe("object");
      expect(schema.properties, `${name} properties`).toBeTruthy();
    }
  });

  it("only lists required keys that the schema declares", () => {
    for (const [name, schema] of Object.entries(TOOL_OUTPUT_SCHEMAS)) {
      for (const key of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {}), `${name}.${key}`).toContain(key);
      }
    }
  });

  it("only schemas tools that exist", () => {
    for (const name of Object.keys(TOOL_OUTPUT_SCHEMAS)) {
      expect(TOOL_ANNOTATIONS[name], `${name} has a schema but no annotation`).toBeDefined();
    }
  });
});

describe("decorateTool", () => {
  it("attaches annotations", () => {
    const decorated = decorateTool(def("recall"));
    expect(decorated.annotations.readOnlyHint).toBe(true);
    expect(decorated.annotations.title).toBe("Recall Memories & Todos");
  });

  it("attaches an outputSchema only where one is declared", () => {
    expect(decorateTool(def("recall")).outputSchema).toBeDefined();
    // A one-line confirmation gains nothing from a schema.
    expect(decorateTool(def("forget")).outputSchema).toBeUndefined();
  });

  it("throws for an unannotated tool rather than defaulting silently", () => {
    // A silent default would ship the spec defaults (destructive + open world)
    // AND would leave the tool outside the ambient-ingestion gate.
    expect(() => decorateTool(def("brand_new_tool"))).toThrow(/no entry in TOOL_BEHAVIOUR/);
  });

  it("does not mutate the input definition", () => {
    const original = def("recall");
    decorateTool(original);
    expect("annotations" in original).toBe(false);
  });
});
