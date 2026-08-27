import { describe, it, expect } from "vitest";
import {
  buildSlashItems,
  templatesToSlashDefs,
  TEMPLATE_SOURCE_TAG,
} from "../slashCommandSource";
import type { AcpSlashCommand, SkillDef, SlashCommandDef } from "@/lib/tauri";
import type { PromptTemplate } from "@/types/prompt";

const customCmd = (name: string): SlashCommandDef => ({
  name,
  description: `${name} desc`,
  body: `${name} body`,
  source: "project",
});

const skill = (name: string, userInvocable = true): SkillDef => ({
  name,
  description: `${name} skill`,
  userInvocable,
  source: "user",
  body: `${name} skill body`,
});

describe("buildSlashItems — the single slash-command source of truth", () => {
  it("orders builtins, then custom commands, then skills", () => {
    const items = buildSlashItems("", {
      includeBuiltins: true,
      customCommands: [customCmd("deploy")],
      userSkills: [skill("verify")],
    });
    const kinds = items.map((i) => i.selection.kind);
    const firstCustom = kinds.indexOf("custom");
    const firstSkill = kinds.indexOf("skill");
    expect(kinds[0]).toBe("builtin");
    expect(firstCustom).toBeGreaterThan(0);
    expect(firstSkill).toBeGreaterThan(firstCustom);
  });

  it("omits builtins for the launch variant (no live conversation to act on)", () => {
    const items = buildSlashItems("", {
      includeBuiltins: false,
      customCommands: [customCmd("deploy")],
      userSkills: [skill("verify")],
    });
    expect(items.some((i) => i.selection.kind === "builtin")).toBe(false);
    expect(items.map((i) => i.label)).toEqual(["/deploy", "/verify"]);
  });

  it("filters every source with the same case-insensitive prefix rule", () => {
    const items = buildSlashItems("PE", {
      includeBuiltins: true,
      customCommands: [customCmd("perf-audit"), customCmd("deploy")],
      userSkills: [skill("perf-skill"), skill("verify")],
    });
    expect(items.map((i) => i.label)).toEqual([
      "/permissions",
      "/perf-audit",
      "/perf-skill",
    ]);
  });

  it("excludes skills that are not user-invocable", () => {
    const items = buildSlashItems("hidden", {
      includeBuiltins: false,
      customCommands: [],
      userSkills: [skill("hidden-skill", false)],
    });
    expect(items).toEqual([]);
  });

  it("every item carries the selection it resolves to (keyboard == popover)", () => {
    const items = buildSlashItems("", {
      includeBuiltins: true,
      customCommands: [customCmd("deploy")],
      userSkills: [skill("verify")],
    });
    for (const item of items) {
      if (item.selection.kind === "builtin") {
        expect(item.key).toBe(`builtin:${item.selection.name}`);
      } else if (item.selection.kind === "custom") {
        expect(item.key).toBe(`custom:${item.selection.def.name}`);
        expect(item.selection.def.body).toBe("deploy body");
      } else if (item.selection.kind === "skill") {
        expect(item.key).toBe(`skill:${item.selection.def.name}`);
        expect(item.selection.def.body).toBe("verify skill body");
      } else {
        // No engine commands were passed to this call — an engine row here
        // would mean the merge invented one.
        throw new Error(`unexpected engine row: ${item.key}`);
      }
    }
  });
});

/**
 * ACP engine commands merged into the SAME menu. The engine owns commands
 * PacketBench has never heard of, but PacketBench owns `/model` and `/permissions`
 * — those open the composer's own pickers via `paneEvents`, so a same-named
 * engine command must not be able to take them over.
 */
describe("buildSlashItems — ACP engine commands", () => {
  const engineCmd = (
    name: string,
    over: Partial<AcpSlashCommand> = {},
  ): AcpSlashCommand => ({
    name,
    description: `${name} from engine`,
    source: "builtin",
    ...over,
  });

  it("merges engine commands after the builtins and before custom/skills", () => {
    const items = buildSlashItems("", {
      includeBuiltins: true,
      customCommands: [customCmd("deploy")],
      userSkills: [skill("verify")],
      engineCommands: [engineCmd("cost")],
    });
    const kinds = items.map((i) => i.selection.kind);
    expect(kinds.indexOf("engine")).toBeGreaterThan(kinds.lastIndexOf("builtin"));
    expect(kinds.indexOf("engine")).toBeLessThan(kinds.indexOf("custom"));
    expect(kinds.indexOf("custom")).toBeLessThan(kinds.indexOf("skill"));
  });

  it("surfaces the engine's argument hint on the row and tags its source", () => {
    const [item] = buildSlashItems("cost", {
      includeBuiltins: false,
      customCommands: [],
      userSkills: [],
      engineCommands: [
        engineCmd("cost", { argumentHint: "[days]", source: "project" }),
      ],
    });
    expect(item.label).toBe("/cost [days]");
    expect(item.description).toBe("cost from engine (project)");
    expect(item.key).toBe("engine:cost");
    expect(item.selection).toEqual({
      kind: "engine",
      def: expect.objectContaining({ name: "cost" }),
    });
  });

  it("omits the hint from the label when the command takes no arguments", () => {
    const [item] = buildSlashItems("cost", {
      includeBuiltins: false,
      customCommands: [],
      userSkills: [],
      engineCommands: [engineCmd("cost")],
    });
    expect(item.label).toBe("/cost");
  });

  it("lets a builtin shadow a same-named engine command", () => {
    // `/model` opens the composer's model picker (OPEN_MODEL_DROPDOWN_EVENT).
    // Handing the name to the engine would silently delete that control.
    const items = buildSlashItems("model", {
      includeBuiltins: true,
      customCommands: [],
      userSkills: [],
      engineCommands: [engineCmd("model"), engineCmd("models")],
    });
    expect(items.map((i) => i.key)).toEqual(["builtin:model", "engine:models"]);
  });

  it("keeps an engine command whose name only collides in the launch variant", () => {
    // No builtins offered there, so nothing shadows.
    const items = buildSlashItems("model", {
      includeBuiltins: false,
      customCommands: [],
      userSkills: [],
      engineCommands: [engineCmd("model")],
    });
    expect(items.map((i) => i.key)).toEqual(["engine:model"]);
  });

  it("filters engine commands with the same case-insensitive prefix rule", () => {
    const items = buildSlashItems("CO", {
      includeBuiltins: false,
      customCommands: [],
      userSkills: [],
      engineCommands: [engineCmd("cost"), engineCmd("context"), engineCmd("undo")],
    });
    expect(items.map((i) => i.label)).toEqual(["/cost", "/context"]);
  });

  it("is byte-identical to the pre-engine menu when the engine gave nothing", () => {
    const sources = {
      includeBuiltins: true,
      customCommands: [customCmd("deploy")],
      userSkills: [skill("verify")],
    };
    const withoutField = buildSlashItems("", sources).map((i) => i.key);
    const withEmpty = buildSlashItems("", { ...sources, engineCommands: [] }).map(
      (i) => i.key,
    );
    expect(withEmpty).toEqual(withoutField);
  });
});

describe("templatesToSlashDefs", () => {
  it("slugifies template names and tags them as template-sourced", () => {
    const templates: PromptTemplate[] = [
      {
        id: "t1",
        name: "Code Review!",
        content: "Review the diff carefully.",
        category: "review",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const defs = templatesToSlashDefs(templates);
    expect(defs).toEqual([
      {
        name: "code-review",
        description: "Code Review!",
        body: "Review the diff carefully.",
        source: TEMPLATE_SOURCE_TAG,
      },
    ]);
  });
});
