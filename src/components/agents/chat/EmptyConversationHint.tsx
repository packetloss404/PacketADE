/** Keyboard-shortcut hint shown when the conversation has no messages yet. */
export function EmptyConversationHint() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <span className="text-[11px] text-text-muted">No messages yet</span>
      <div className="flex flex-col gap-1.5 text-[11px] text-text-secondary">
        <div className="flex items-center gap-2">
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            @
          </kbd>
          <span>files</span>
          <span className="text-text-muted">·</span>
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            /
          </kbd>
          <span>commands</span>
          <span className="text-text-muted">·</span>
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            ⇧⇥
          </kbd>
          <span>mode</span>
        </div>
        <div className="flex items-center gap-2">
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            ↑/↓
          </kbd>
          <span>history</span>
          <span className="text-text-muted">·</span>
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            ⌃S
          </kbd>
          <span>stash</span>
          <span className="text-text-muted">·</span>
          <kbd className="bg-bg-tertiary px-1.5 py-0.5 rounded text-[10px] font-mono">
            ⌃N
          </kbd>
          <span>new</span>
        </div>
      </div>
    </div>
  );
}
