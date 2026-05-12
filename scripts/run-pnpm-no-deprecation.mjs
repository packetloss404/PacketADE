import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-pnpm-no-deprecation.mjs <pnpm args...>");
  process.exit(2);
}

const existingNodeOptions = (process.env.NODE_OPTIONS ?? "")
  .split(/\s+/)
  .filter(Boolean)
  .filter((option) => option !== "--trace-deprecation" && option !== "--trace-warnings");

const env = {
  ...process.env,
  NODE_OPTIONS: [...existingNodeOptions, "--no-deprecation"].join(" "),
};

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, args, {
  env,
  shell: process.platform === "win32",
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
