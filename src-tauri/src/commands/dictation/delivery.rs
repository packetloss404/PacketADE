/// Put dictated text on the native clipboard and optionally paste it into the
/// foreground application. The transcript intentionally remains on the
/// clipboard after paste; restoring an earlier clipboard value can re-expose a
/// password or one-time code.
#[tauri::command]
pub fn deliver_dictation_text(text: String, paste: bool) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Cannot deliver an empty transcription".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use enigo::{
            Direction::{Click, Press, Release},
            Enigo, Key, Keyboard, Settings,
        };

        clipboard_win::set_clipboard_string(&text)
            .map_err(|err| format!("Failed to copy transcription to the clipboard: {err}"))?;

        if paste {
            // Give Windows a moment to publish CF_UNICODETEXT before Ctrl+V.
            std::thread::sleep(std::time::Duration::from_millis(20));
            let mut enigo = Enigo::new(&Settings::default())
                .map_err(|err| format!("Failed to initialize system-wide paste: {err}"))?;
            enigo
                .key(Key::Control, Press)
                .map_err(|err| format!("Failed to press Ctrl for system-wide paste: {err}"))?;
            let paste_result = enigo.key(Key::Unicode('v'), Click);
            let release_result = enigo.key(Key::Control, Release);
            paste_result
                .map_err(|err| format!("Failed to send Ctrl+V to the foreground app: {err}"))?;
            release_result.map_err(|err| {
                format!("System-wide paste completed but Ctrl could not be released: {err}")
            })?;
        }

        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = paste;
        Err(
            "Native dictation delivery is currently available on Windows; the transcript remains available in PacketBench"
                .to_string(),
        )
    }
}
