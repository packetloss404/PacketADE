import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "color-mix(in srgb, var(--color-bg-primary, #0f0f10) calc(<alpha-value> * 100%), transparent)",
          secondary: "color-mix(in srgb, var(--color-bg-secondary, #161617) calc(<alpha-value> * 100%), transparent)",
          tertiary: "color-mix(in srgb, var(--color-bg-tertiary, #1c1c1e) calc(<alpha-value> * 100%), transparent)",
          elevated: "color-mix(in srgb, var(--color-bg-elevated, #232326) calc(<alpha-value> * 100%), transparent)",
          hover: "color-mix(in srgb, var(--color-bg-hover, #2a2a2e) calc(<alpha-value> * 100%), transparent)",
          border: "color-mix(in srgb, var(--color-bg-border, #2a2a2e) calc(<alpha-value> * 100%), transparent)",
        },
        line: {
          soft: "color-mix(in srgb, var(--color-line-soft, #1f1f22) calc(<alpha-value> * 100%), transparent)",
          strong: "color-mix(in srgb, var(--color-line-strong, #353539) calc(<alpha-value> * 100%), transparent)",
        },
        text: {
          primary: "color-mix(in srgb, var(--color-text-primary, #ededee) calc(<alpha-value> * 100%), transparent)",
          secondary: "color-mix(in srgb, var(--color-text-secondary, #b9b9bd) calc(<alpha-value> * 100%), transparent)",
          muted: "color-mix(in srgb, var(--color-text-muted, #8a8a91) calc(<alpha-value> * 100%), transparent)",
          faint: "color-mix(in srgb, var(--color-text-faint, #5e5e66) calc(<alpha-value> * 100%), transparent)",
        },
        accent: {
          green: "color-mix(in srgb, var(--color-accent-green, #6fb89a) calc(<alpha-value> * 100%), transparent)",
          amber: "color-mix(in srgb, var(--color-accent-amber, #d4b25c) calc(<alpha-value> * 100%), transparent)",
          blue: "color-mix(in srgb, var(--color-accent-blue, #6b9ed9) calc(<alpha-value> * 100%), transparent)",
          red: "color-mix(in srgb, var(--color-accent-red, #d96565) calc(<alpha-value> * 100%), transparent)",
          purple: "color-mix(in srgb, var(--color-accent-purple, #a89ad9) calc(<alpha-value> * 100%), transparent)",
          soft: "color-mix(in srgb, var(--color-accent-soft, rgba(111,184,154,0.14)) calc(<alpha-value> * 100%), transparent)",
          line: "color-mix(in srgb, var(--color-accent-line, rgba(111,184,154,0.32)) calc(<alpha-value> * 100%), transparent)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Cascadia Code",
          "Fira Code",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        ui: ["var(--text-ui, 11px)", { lineHeight: "var(--leading-ui, 16px)" }],
        meta: ["var(--text-meta, 10px)", { lineHeight: "var(--leading-meta, 14px)" }],
        // Transcript prose — assistant turns render as a document, not a chip.
        body: ["var(--text-body, 13px)", { lineHeight: "var(--leading-body, 21px)" }],
        // Composer chips & pickers.
        chip: ["var(--text-chip, 11.5px)", { lineHeight: "var(--leading-chip, 16px)" }],
      },
      spacing: {
        turn: "var(--space-turn, 24px)",
      },
      maxWidth: {
        chat: "var(--measure-chat, 680px)",
        composer: "var(--measure-composer, 680px)",
      },
    },
  },
  plugins: [],
} satisfies Config;
