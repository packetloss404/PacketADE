use std::path::PathBuf;

fn main() {
    tauri_build::build();

    // Copy the per-triple Node externalBin binary into the cargo output
    // directory alongside `packetade.exe` so the Tauri shell plugin can
    // resolve `app.shell().sidecar("node")` when the user runs the
    // standalone `target/<profile>/packetade.exe` directly (without
    // installing via the MSI/NSIS bundle, which handles this for us).
    //
    // `OUT_DIR` is `target/<profile>/build/<crate>-<hash>/out`; the cargo
    // output dir is four parents up. Best-effort — any IO failure is a
    // warning, never a build failure.
    if let Err(e) = copy_per_triple_node() {
        println!(
            "cargo:warning=copy_per_triple_node skipped: {} (standalone packetade.exe will report sidecar down — install via MSI/NSIS or copy `binaries/node-<triple>.<ext>` next to the exe manually)",
            e
        );
    }
}

fn copy_per_triple_node() -> Result<(), String> {
    let target = std::env::var("TARGET").map_err(|e| format!("read TARGET: {}", e))?;
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .map_err(|e| format!("read CARGO_MANIFEST_DIR: {}", e))?;
    let out_dir = std::env::var("OUT_DIR").map_err(|e| format!("read OUT_DIR: {}", e))?;

    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let src_name = format!("node-{}{}", target, ext);
    let src = PathBuf::from(&manifest_dir)
        .join("binaries")
        .join(&src_name);
    if !src.exists() {
        return Err(format!("source {} missing", src.display()));
    }

    // Walk OUT_DIR up to the cargo output dir (target/<profile>/).
    let dest_dir = PathBuf::from(&out_dir)
        .ancestors()
        .nth(3)
        .ok_or("OUT_DIR has unexpected shape")?
        .to_path_buf();
    let dest = dest_dir.join(&src_name);

    // Tell cargo to re-run if the source binary is replaced (e.g. via
    // `pnpm fetch-node`) so the copy stays current.
    println!("cargo:rerun-if-changed={}", src.display());

    std::fs::copy(&src, &dest)
        .map_err(|e| format!("copy {} → {}: {}", src.display(), dest.display(), e))?;
    Ok(())
}
