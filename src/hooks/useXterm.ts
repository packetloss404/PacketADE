import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { writePty, resizePty } from "@/lib/tauri";

interface UseXtermOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  sessionIdRef: RefObject<string | null>;
  onUserInput?: () => void;
}

export function useXterm({ containerRef, sessionIdRef, onUserInput }: UseXtermOptions) {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      lineHeight: 1.15,
      letterSpacing: 0,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontWeight: "400",
      fontWeightBold: "600",
      rescaleOverlappingGlyphs: true,
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#00ff41",
        cursorAccent: "#0d1117",
        selectionBackground: "#30363d",
        selectionForeground: "#c9d1d9",
        black: "#484f58",
        red: "#f85149",
        green: "#00ff41",
        yellow: "#f0b400",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#c9d1d9",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const unicode11Addon = new Unicode11Addon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";
    term.open(containerRef.current);

    try {
      fitAddon.fit();
    } catch {
      // Container might not be sized yet
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.onData((data) => {
      const sid = sessionIdRef.current;
      if (sid) {
        writePty(sid, data).catch(() => {});
        onUserInput?.();
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    term.onResize(({ cols, rows }) => {
      const sid = sessionIdRef.current;
      if (sid) {
        resizePty(sid, cols, rows).catch(() => {});
      }
    });

    return () => {
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { xtermRef, fitAddonRef };
}
