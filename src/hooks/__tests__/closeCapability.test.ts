import { describe, expect, it } from "vitest";
import mainCapability from "../../../src-tauri/capabilities/default.json";

describe("main-window close capability", () => {
  it("allows the non-recursive destroy used after close confirmation", () => {
    expect(mainCapability.permissions).toContain("core:window:allow-destroy");
  });
});
