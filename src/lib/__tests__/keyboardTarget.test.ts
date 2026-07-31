/**
 * UX-08: focus classification for global shortcuts. A terminal or any text
 * field must be able to keep its own keystrokes (Ctrl+K is readline's
 * kill-line).
 */
import { afterEach, describe, expect, it } from "vitest";
import { isEditableTarget, isTerminalTarget } from "@/lib/keyboardTarget";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTerminalTarget", () => {
  it("matches the xterm helper textarea", () => {
    const host = mount(
      `<div class="xterm"><div class="xterm-screen"></div><textarea class="xterm-helper-textarea"></textarea></div>`,
    );
    expect(isTerminalTarget(host.querySelector(".xterm-helper-textarea"))).toBe(true);
  });

  it("matches any node inside the .xterm container", () => {
    const host = mount(`<div class="xterm"><div class="xterm-screen"><canvas></canvas></div></div>`);
    expect(isTerminalTarget(host.querySelector("canvas"))).toBe(true);
  });

  it("matches the PTY pane wrapper even before xterm mounts", () => {
    const host = mount(`<div data-dictation-pty-session="s1"><div id="inner"></div></div>`);
    expect(isTerminalTarget(host.querySelector("#inner"))).toBe(true);
  });

  it("does not match ordinary chrome or plain inputs", () => {
    const host = mount(`<div><button id="b"></button><input id="i" /></div>`);
    expect(isTerminalTarget(host.querySelector("#b"))).toBe(false);
    expect(isTerminalTarget(host.querySelector("#i"))).toBe(false);
    expect(isTerminalTarget(null)).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("is true for input, textarea, and select", () => {
    const host = mount(`<div><input id="i" /><textarea id="t"></textarea><select id="s"></select></div>`);
    for (const sel of ["#i", "#t", "#s"]) {
      expect(isEditableTarget(host.querySelector(sel))).toBe(true);
    }
  });

  it("is true inside a contenteditable region", () => {
    const host = mount(`<div contenteditable="true"><span id="inner">x</span></div>`);
    expect(isEditableTarget(host.querySelector("#inner"))).toBe(true);
  });

  it("is false for contenteditable=\"false\"", () => {
    const host = mount(`<div contenteditable="false"><span id="inner">x</span></div>`);
    expect(isEditableTarget(host.querySelector("#inner"))).toBe(false);
  });

  it("is true for terminals", () => {
    const host = mount(`<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>`);
    expect(isEditableTarget(host.querySelector(".xterm-helper-textarea"))).toBe(true);
  });

  it("is false for buttons, divs, and non-element targets", () => {
    const host = mount(`<div><button id="b"></button><div id="d"></div></div>`);
    expect(isEditableTarget(host.querySelector("#b"))).toBe(false);
    expect(isEditableTarget(host.querySelector("#d"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(window)).toBe(false);
  });

  it("reads the target off a KeyboardEvent", () => {
    const host = mount(`<input id="i" />`);
    const input = host.querySelector("#i") as HTMLInputElement;
    const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true });
    input.dispatchEvent(e);
    expect(isEditableTarget(e)).toBe(true);
  });
});
