import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "var(--color-bg-primary, #0f0f10)",
          secondary: "var(--color-bg-secondary, #161617)",
          tertiary: "var(--color-bg-tertiary, #1c1c1e)",
          elevated: "var(--color-bg-elevated, #232326)",
          hover: "var(--color-bg-hover, #2a2a2e)",
          border: "var(--color-bg-border, #2a2a2e)",
        },
        line: {
          soft: "var(--color-line-soft, #1f1f22)",
          strong: "var(--color-line-strong, #353539)",
        },
        text: {
          primary: "var(--color-text-primary, #ededee)",
          secondary: "var(--color-text-secondary, #b9b9bd)",
          muted: "var(--color-text-muted, #8a8a91)",
          faint: "var(--color-text-faint, #5e5e66)",
        },
        accent: {
          green: "var(--color-accent-green, #6fb89a)",
          amber: "var(--color-accent-amber, #d4b25c)",
          blue: "var(--color-accent-blue, #6b9ed9)",
          red: "var(--color-accent-red, #d96565)",
          purple: "var(--color-accent-purple, #a89ad9)",
          soft: "var(--color-accent-soft, rgba(111,184,154,0.14))",
          line: "var(--color-accent-line, rgba(111,184,154,0.32))",
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
      },
      spacing: {
        turn: "var(--space-turn, 20px)",
      },
    },
  },
  plugins: [],
} satisfies Config;
