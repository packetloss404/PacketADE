import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve everything from this file, not from the caller's cwd, so the gate
// behaves identically whether it is run via `pnpm check:tauri-schema`, from a
// subdirectory, or out of `prebundle`.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = path.join(root, "src-tauri");

const cargoArgs = [
  "test",
  "--test",
  "api_schema",
  "export_api_bindings",
  "--",
  "--ignored",
  "--nocapture",
];

const schemaPath = path.join(root, "src", "generated", "tauri-schema.ts");

try {
  const current = readFileSync(schemaPath, "utf8");

  execFileSync("cargo", cargoArgs, {
    // Cargo discovers `.cargo/config.toml` from its working directory, not
    // from `--manifest-path`. Running this from the repo root misses
    // `src-tauri/.cargo/config.toml`'s `target-dir` redirect and builds into
    // the stale `src-tauri/target/` tree instead, which on a machine that
    // copied that tree from an older checkout fails with a dead absolute path
    // baked into the cached tauri-build permission files. Run where Tauri
    // invokes Cargo.
    cwd: srcTauri,
    stdio: "inherit",
  });
  const generated = readFileSync(schemaPath, "utf8");
  writeFileSync(schemaPath, current);

  if (current !== generated) {
    console.error(
      `${path.relative(root, schemaPath)} is stale. Run pnpm generate:tauri-schema.`,
    );
    process.exit(1);
  }
} catch (error) {
  process.exit(error.status ?? 1);
}
