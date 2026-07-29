#[test]
#[ignore = "run manually to refresh checked-in TS bindings"]
fn export_api_bindings() {
    let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated");
    std::fs::create_dir_all(&out_dir).unwrap();
    std::fs::write(
        out_dir.join("tauri-schema.ts"),
        packetade_lib::api::generated_typescript_schema(),
    )
    .unwrap();
}
