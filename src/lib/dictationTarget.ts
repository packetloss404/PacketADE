export type DictationDomTarget =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLElement;

export type DictationTarget =
  | { kind: "dom"; element: DictationDomTarget }
  | { kind: "pty"; element: HTMLElement; sessionId: string };

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel"]);
const SECURE_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
]);

export function isSecureDictationTarget(element: Element): boolean {
  if (
    element.closest('[data-dictation="off"]') ||
    element.closest('[data-dictation="secure"]') ||
    element.closest('[data-sensitive="true"]')
  ) {
    return true;
  }
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.type.toLowerCase() === "password") return true;
  return element.autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SECURE_AUTOCOMPLETE_TOKENS.has(token));
}

export function findDictationTarget(element: Element | null): DictationTarget | null {
  if (!element || isSecureDictationTarget(element)) return null;

  const terminal = element.closest<HTMLElement>("[data-dictation-pty-session]");
  const sessionId = terminal?.dataset.dictationPtySession?.trim();
  if (terminal && sessionId) {
    return { kind: "pty", element: terminal, sessionId };
  }

  if (element instanceof HTMLTextAreaElement) {
    return element.readOnly || element.disabled
      ? null
      : { kind: "dom", element };
  }
  if (element instanceof HTMLInputElement) {
    return element.readOnly ||
      element.disabled ||
      !TEXT_INPUT_TYPES.has(element.type.toLowerCase())
      ? null
      : { kind: "dom", element };
  }

  const editable = element.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
  if (
    editable?.isContentEditable &&
    editable.getAttribute("aria-disabled") !== "true" &&
    !isSecureDictationTarget(editable)
  ) {
    return { kind: "dom", element: editable };
  }
  return null;
}

export function isDictationTargetUsable(target: DictationTarget): boolean {
  if (!target.element.isConnected || isSecureDictationTarget(target.element)) return false;
  if (target.kind === "pty") {
    return target.element.dataset.dictationPtySession === target.sessionId;
  }
  return findDictationTarget(target.element)?.kind === "dom";
}

export function insertDictationText(target: DictationDomTarget, text: string) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next = target.value.slice(0, start) + text + target.value.slice(end);
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, next);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    const cursor = start + text.length;
    try {
      target.setSelectionRange(cursor, cursor);
    } catch {
      // Some text-like input types do not expose a selection range.
    }
    return;
  }

  target.focus();
  const selection = window.getSelection();
  const range =
    selection?.rangeCount && target.contains(selection.anchorNode)
      ? selection.getRangeAt(0)
      : null;
  if (range) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  } else {
    target.append(document.createTextNode(text));
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
}
