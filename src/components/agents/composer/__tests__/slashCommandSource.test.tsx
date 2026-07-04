import { describe, it, expect } from "vitest";
import {
  buildSlashItems,
  templatesToSlashDefs,
  TEMPLATE_SOURCE_TAG,
} from "../slashCommandSource";
import type { SkillDef, SlashCommandDef } from "@/lib/tauri";
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
      } else {
        expect(item.key).toBe(`skill:${item.selection.def.name}`);
        expect(item.selection.def.body).toBe("verify skill body");
      }
    }
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
