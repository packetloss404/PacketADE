import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const cargoArgs = [
  "test",
  "export_api_bindings",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--",
  "--ignored",
  "--nocapture",
];

const schemaPath = "src/generated/tauri-schema.ts";

try {
  const current = readFileSync(schemaPath, "utf8");

  execFileSync("cargo", cargoArgs, { stdio: "inherit" });
  const generated = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, current);

  if (current !== generated) {
    console.error(`${schemaPath} is stale. Run pnpm generate:tauri-schema.`);
    process.exit(1);
  }
} catch (error) {
  process.exit(error.status ?? 1);
}
