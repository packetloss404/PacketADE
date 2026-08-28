import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  claimDictationCapture,
  findDictationTarget,
  insertDictationText,
  isDictationTargetUsable,
  isSecureDictationTarget,
  releaseDictationCapture,
} from "../dictationTarget";
import { validateDictationShortcuts, type DictationSettings } from "@/types/dictation";

const tauriMocks = vi.hoisted(() => ({
  deliverDictationText: vi.fn(),
  writePty: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/tauri", () => ({
  deliverDictationText: tauriMocks.deliverDictationText,
  writePty: tauriMocks.writePty,
  startRecordingCmd: vi.fn(),
  stopRecordingCmd: vi.fn(),
  cancelRecordingCmd: vi.fn(),
  getDictationHistory: vi.fn().mockResolvedValue("[]"),
  getDictationAnalytics: vi.fn().mockResolvedValue("{}"),
  searchDictationHistory: vi.fn(),
  getDictationSettings: vi.fn().mockResolvedValue("{}"),
  setDictationSettings: vi.fn(),
  downloadWhisperModel: vi.fn(),
  listWhisperModels: vi.fn().mockResolvedValue([]),
  listAudioDevices: vi.fn().mockResolvedValue([]),
}));

import { useDictationStore } from "@/stores/dictationStore";
import { useDictationTarget } from "@/hooks/useDictationTarget";

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
    if (target?.kind === "dom") insertDictationText(target.element, "PacketBench");
    expect(textarea.value).toBe("hello PacketBench");
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

  it("appends when the input type refuses to expose a selection", () => {
    // `selectionStart` throws InvalidStateError on `email`/`url` inputs, both of
    // which are accepted dictation targets. The throw used to escape into the
    // store subscriber and kill delivery for every later transcript.
    const email = document.createElement("input");
    email.type = "email";
    email.value = "a@b.com";
    const boom = () => {
      throw new Error("InvalidStateError");
    };
    Object.defineProperty(email, "selectionStart", { get: boom });
    Object.defineProperty(email, "selectionEnd", { get: boom });
    document.body.append(email);

    const target = findDictationTarget(email);
    expect(target?.kind).toBe("dom");
    if (target?.kind === "dom") {
      expect(() => insertDictationText(target.element, " x")).not.toThrow();
    }
    expect(email.value).toBe("a@b.com x");
  });

  it("treats any control inside a sensitive region as secure", () => {
    const region = document.createElement("div");
    region.dataset.sensitive = "true";
    const button = document.createElement("button");
    region.append(button);
    const plain = document.createElement("button");
    document.body.append(region, plain);

    expect(isSecureDictationTarget(button)).toBe(true);
    expect(isSecureDictationTarget(plain)).toBe(false);
  });

  it("stops treating a target as usable once it leaves the DOM", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    const target = findDictationTarget(textarea);
    expect(target && isDictationTargetUsable(target)).toBe(true);

    textarea.remove();
    expect(target && isDictationTargetUsable(target)).toBe(false);
  });

  it("rejects a PTY target whose pane was recycled onto another session", () => {
    const terminal = document.createElement("div");
    terminal.dataset.dictationPtySession = "session-a";
    document.body.append(terminal);
    const target = findDictationTarget(terminal);
    expect(target && isDictationTargetUsable(target)).toBe(true);

    terminal.dataset.dictationPtySession = "session-b";
    expect(target && isDictationTargetUsable(target)).toBe(false);
  });
});

const baseSettings: DictationSettings = {
  modelSize: "base",
  deviceId: null,
  deviceIndex: null,
  customDictionary: [],
  autoPaste: true,
  language: "auto",
  systemWidePaste: false,
  globalShortcutsEnabled: false,
  maxDurationSeconds: 300,
};

function focus(element: Element) {
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function beginCapture() {
  useDictationStore.setState((state) => ({
    captureId: state.captureId + 1,
    isRecording: true,
    status: "recording",
    lastResult: null,
    lastResultCaptureId: null,
  }));
  return useDictationStore.getState().captureId;
}

function finishCapture(captureId: number, text: string) {
  useDictationStore.setState({
    lastResult: text,
    lastResultCaptureId: captureId,
    isRecording: false,
    status: "done",
  });
}

describe("dictation delivery targeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.deliverDictationText.mockResolvedValue(undefined);
    tauriMocks.writePty.mockResolvedValue(undefined);
    document.body.innerHTML = "";
    // Capture ids restart at 0 each test, so drop any claim left behind.
    for (let i = 0; i <= 10; i++) releaseDictationCapture(i);
    useDictationStore.setState({
      settings: { ...baseSettings },
      captureId: 0,
      lastResultCaptureId: null,
      lastResult: null,
      isRecording: false,
      isStarting: false,
      isTranscribing: false,
      status: "idle",
      deliveryNotice: null,
    });
  });

  it("delivers to the field focused when the capture started, not the one focused when it returns", () => {
    const intended = document.createElement("textarea");
    const other = document.createElement("textarea");
    document.body.append(intended, other);
    renderHook(() => useDictationTarget());

    focus(intended);
    const captureId = beginCapture();
    // Transcription takes seconds; the user clicks into a different pane.
    focus(other);
    finishCapture(captureId, "hello there");

    expect(intended.value).toBe("hello there");
    expect(other.value).toBe("");
  });

  it("falls back to the clipboard when the armed target is gone rather than using current focus", () => {
    const intended = document.createElement("textarea");
    const other = document.createElement("textarea");
    document.body.append(intended, other);
    renderHook(() => useDictationTarget());

    focus(intended);
    const captureId = beginCapture();
    intended.remove();
    focus(other);
    finishCapture(captureId, "hello there");

    expect(other.value).toBe("");
    expect(tauriMocks.deliverDictationText).toHaveBeenCalledWith("hello there", false);
  });

  it("forgets the remembered field once focus enters a secure region", () => {
    const intended = document.createElement("textarea");
    const password = document.createElement("input");
    password.type = "password";
    document.body.append(intended, password);
    renderHook(() => useDictationTarget());

    focus(intended);
    focus(password);
    const captureId = beginCapture();
    finishCapture(captureId, "my passphrase");

    expect(intended.value).toBe("");
    expect(tauriMocks.deliverDictationText).toHaveBeenCalledWith("my passphrase", false);
  });

  it("keeps the remembered field when focus moves to an ordinary button", () => {
    const intended = document.createElement("textarea");
    const micButton = document.createElement("button");
    document.body.append(intended, micButton);
    renderHook(() => useDictationTarget());

    focus(intended);
    focus(micButton);
    const captureId = beginCapture();
    finishCapture(captureId, "still here");

    expect(intended.value).toBe("still here");
  });

  it("delivers two identical consecutive transcripts", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    renderHook(() => useDictationTarget());

    focus(field);
    finishCapture(beginCapture(), "yes");
    focus(field);
    finishCapture(beginCapture(), "yes");

    expect(field.value).toBe("yesyes");
  });

  it("strips line breaks before writing a transcript into a terminal", () => {
    const terminal = document.createElement("div");
    terminal.dataset.dictationPtySession = "session-1";
    document.body.append(terminal);
    renderHook(() => useDictationTarget());

    focus(terminal);
    finishCapture(beginCapture(), "remove the temp folder\nyes\n");

    // A newline in a PTY write submits the line. Dictation must never execute.
    expect(tauriMocks.writePty).toHaveBeenCalledWith(
      "session-1",
      "remove the temp folder yes",
    );
  });

  it("skips auto-paste for a capture an in-app surface already consumes", () => {
    // The composer mic inserts the transcript itself; a second insertion into
    // the same controlled textarea used to duplicate the utterance.
    const field = document.createElement("textarea");
    document.body.append(field);
    renderHook(() => useDictationTarget());

    focus(field);
    const captureId = beginCapture();
    claimDictationCapture(captureId);
    finishCapture(captureId, "hello");

    expect(field.value).toBe("");
    expect(tauriMocks.deliverDictationText).not.toHaveBeenCalled();
  });

  it("does not deliver anything while auto-paste is off", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    useDictationStore.setState({ settings: { ...baseSettings, autoPaste: false } });
    renderHook(() => useDictationTarget());

    focus(field);
    finishCapture(beginCapture(), "hello");

    expect(field.value).toBe("");
    expect(tauriMocks.deliverDictationText).not.toHaveBeenCalled();
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
