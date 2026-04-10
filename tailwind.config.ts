import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "var(--color-bg-primary, #1e1e2e)",
          secondary: "var(--color-bg-secondary, #252537)",
          tertiary: "var(--color-bg-tertiary, #2b2b3d)",
          elevated: "var(--color-bg-elevated, #313147)",
          hover: "var(--color-bg-hover, #3b3b52)",
          border: "var(--color-bg-border, #3b3b52)",
        },
        text: {
          primary: "var(--color-text-primary, #e4e4e8)",
          secondary: "var(--color-text-secondary, #9d9db5)",
          muted: "var(--color-text-muted, #5c5c7a)",
        },
        accent: {
          green: "var(--color-accent-green, #4ec9b0)",
          amber: "var(--color-accent-amber, #dcdcaa)",
          blue: "var(--color-accent-blue, #569cd6)",
          red: "var(--color-accent-red, #f44747)",
          purple: "var(--color-accent-purple, #7b61ff)",
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
    },
  },
  plugins: [],
} satisfies Config;
