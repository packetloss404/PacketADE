import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findDictationTarget,
  insertDictationText,
  isDictationTargetUsable,
} from "../dictationTarget";
import { validateDictationShortcuts } from "@/types/dictation";

describe("dictation targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts at a textarea selection through the native value setter", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    document.body.append(textarea);
    textarea.setSelectionRange(6, 11);

    const input = vi.fn();
    textarea.addEventListener("input", input);
    const target = findDictationTarget(textarea);

    expect(target?.kind).toBe("dom");
    if (target?.kind === "dom") insertDictationText(target.element, "PacketADE");
    expect(textarea.value).toBe("hello PacketADE");
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("rejects passwords, OTP fields, and explicitly sensitive regions", () => {
    const container = document.createElement("div");
    container.dataset.sensitive = "true";
    const nested = document.createElement("textarea");
    container.append(nested);
    const password = document.createElement("input");
    password.type = "password";
    const otp = document.createElement("input");
    otp.autocomplete = "one-time-code";
    document.body.append(container, password, otp);

    expect(findDictationTarget(nested)).toBeNull();
    expect(findDictationTarget(password)).toBeNull();
    expect(findDictationTarget(otp)).toBeNull();
  });

  it("recognizes an xterm descendant as a PTY target without touching its textarea", () => {
    const terminal = document.createElement("div");
    terminal.dataset.dictationPtySession = "session-123";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.append(helper);
    document.body.append(terminal);

    const target = findDictationTarget(helper);
    expect(target).toMatchObject({ kind: "pty", sessionId: "session-123" });
    expect(target && isDictationTargetUsable(target)).toBe(true);
  });

  it("supports contenteditable targets", () => {
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    // jsdom does not derive isContentEditable from contentEditable.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(editable);

    const target = findDictationTarget(editable);
    expect(target?.kind).toBe("dom");
    if (target?.kind === "dom") insertDictationText(target.element, "hello");
    expect(editable.textContent).toBe("hello");
  });
});

describe("dictation shortcut validation", () => {
  it("rejects duplicate global bindings case-insensitively", () => {
    expect(
      validateDictationShortcuts(
        "CommandOrControl+Alt+R",
        "commandorcontrol+alt+r",
      ),
    ).toContain("must be different");
  });

  it("accepts distinct defaults", () => {
    expect(
      validateDictationShortcuts(
        "CommandOrControl+Alt+Space",
        "CommandOrControl+Alt+R",
      ),
    ).toBeNull();
  });
});
