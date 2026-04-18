import { describe, it, expect, beforeEach } from "vitest";
import { loadFromStorage, saveToStorage, removeFromStorage } from "@/lib/storage";

describe("storage utilities", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns fallback when key does not exist", () => {
    const result = loadFromStorage("nonexistent", { value: 42 });
    expect(result).toEqual({ value: 42 });
  });

  it("saves and loads a value", () => {
    saveToStorage("test-key", { name: "PacketADE", version: 1 });
    const result = loadFromStorage("test-key", {});
    expect(result).toEqual({ name: "PacketADE", version: 1 });
  });

  it("returns fallback on corrupt JSON", () => {
    localStorage.setItem("corrupt", "not-json{{{");
    const result = loadFromStorage("corrupt", "default");
    expect(result).toBe("default");
  });

  it("removeFromStorage deletes the key", () => {
    saveToStorage("to-remove", "data");
    removeFromStorage("to-remove");
    const result = loadFromStorage("to-remove", null);
    expect(result).toBeNull();
  });
});
