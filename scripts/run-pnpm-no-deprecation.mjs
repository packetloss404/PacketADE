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

const isWindows = process.platform === "win32";
const command = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
const spawnArgs = isWindows ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : args;
const result = spawnSync(command, spawnArgs, {
  env,
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
