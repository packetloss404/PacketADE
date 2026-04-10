import { execFileSync } from "node:child_process";

const cargoArgs = [
  "test",
  "export_api_bindings",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--",
  "--ignored",
  "--nocapture",
];

try {
  execFileSync("cargo", cargoArgs, { stdio: "inherit" });
  execFileSync("git", ["diff", "--exit-code", "--", "src/generated/tauri-schema.ts"], {
    stdio: "inherit",
  });
} catch (error) {
  process.exit(error.status ?? 1);
}
