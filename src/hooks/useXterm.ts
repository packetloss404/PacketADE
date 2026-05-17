import { useEffect, useRef, type RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
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

    // Use WebGL renderer for GPU-accelerated 60fps rendering.
    // Keep a reference so we can dispose it explicitly on cleanup.
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // GPU context was lost (e.g. too many contexts, system sleep).
        // Dispose the addon — xterm falls back to its default canvas renderer.
        webglAddon?.dispose();
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available — falls back to default canvas renderer
      webglAddon = null;
    }

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
        // Per-keystroke writePty — swallow silently because a broken
        // pipeline would otherwise flood the console with one entry per
        // character. The user will notice their input isn't echoing.
        writePty(sid, data).catch(() => {});
        onUserInput?.();
      }
    });

    const resizeObserver = new ResizeObserver((entries) => {
      // When the workspace is switched away, its container is set to display:none
      // which reports a 0x0 contentRect. Fitting to that would resize the PTY to
      // degenerate dimensions, which scrambles full-TUI CLIs like OpenCode on return.
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width < 1 || height < 1) return;
      }
      try {
        fitAddon.fit();
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    term.onResize(({ cols, rows }) => {
      // Guard against any residual degenerate resize slipping through.
      if (cols < 2 || rows < 2) return;
      const sid = sessionIdRef.current;
      if (sid) {
        resizePty(sid, cols, rows).catch((err) =>
          console.warn("[useXterm.resizePty] failed:", err),
        );
      }
    });

    return () => {
      resizeObserver.disconnect();
      // Dispose WebGL addon explicitly before terminal to release GPU context
      if (webglAddon) {
        webglAddon.dispose();
        webglAddon = null;
      }
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { xtermRef, fitAddonRef };
}
