import { describe, it, expect, beforeEach } from "vitest";
import { usePromptStore } from "../promptStore";

const STORAGE_KEY = "packetade:prompt-templates";
const store = () => usePromptStore.getState();

describe("promptStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePromptStore.setState({ templates: [] });
  });

  describe("addTemplate", () => {
    it("creates a template with generated id and timestamps", () => {
      store().addTemplate("Bug Report", "Describe the bug", "debugging");
      const t = store().templates[0];
      expect(t.id).toMatch(/^tpl_/);
      expect(t.name).toBe("Bug Report");
      expect(t.content).toBe("Describe the bug");
      expect(t.category).toBe("debugging");
      expect(t.createdAt).toBeTypeOf("number");
      expect(t.updatedAt).toBe(t.createdAt);
    });

    it("persists templates to localStorage", () => {
      store().addTemplate("A", "content", "general");
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw).toHaveLength(1);
      expect(raw[0].name).toBe("A");
    });

    it("appends multiple templates", () => {
      store().addTemplate("A", "a", "general");
      store().addTemplate("B", "b", "feature");
      expect(store().templates.map((t) => t.name)).toEqual(["A", "B"]);
    });
  });

  describe("updateTemplate", () => {
    it("updates name/content/category and bumps updatedAt", async () => {
      store().addTemplate("Name", "body", "general");
      const id = store().templates[0].id;
      const originalUpdated = store().templates[0].updatedAt;
      await new Promise((r) => setTimeout(r, 2));
      store().updateTemplate(id, { name: "New", content: "new body", category: "review" });
      const t = store().templates[0];
      expect(t.name).toBe("New");
      expect(t.content).toBe("new body");
      expect(t.category).toBe("review");
      expect(t.updatedAt).toBeGreaterThanOrEqual(originalUpdated);
    });

    it("is a no-op for unknown id", () => {
      store().addTemplate("Name", "body", "general");
      expect(() => store().updateTemplate("nope", { name: "x" })).not.toThrow();
      expect(store().templates[0].name).toBe("Name");
    });

    it("persists updates", () => {
      store().addTemplate("Name", "body", "general");
      const id = store().templates[0].id;
      store().updateTemplate(id, { name: "Renamed" });
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(raw[0].name).toBe("Renamed");
    });
  });

  describe("deleteTemplate", () => {
    it("removes a template by id", () => {
      store().addTemplate("A", "a", "general");
      store().addTemplate("B", "b", "general");
      const id = store().templates[0].id;
      store().deleteTemplate(id);
      expect(store().templates.map((t) => t.name)).toEqual(["B"]);
    });

    it("is a no-op for unknown id", () => {
      store().addTemplate("A", "a", "general");
      expect(() => store().deleteTemplate("nope")).not.toThrow();
      expect(store().templates).toHaveLength(1);
    });

    it("persists deletion", () => {
      store().addTemplate("A", "a", "general");
      const id = store().templates[0].id;
      store().deleteTemplate(id);
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
    });
  });
});
