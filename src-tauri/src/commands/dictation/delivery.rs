use super::config::read_dictation_config;

/// Decide whether a synthetic paste is allowed for this delivery.
///
/// Failure mode this closes: `paste` arrived straight from the webview and was
/// obeyed verbatim, so the `systemWidePaste` opt-in was enforced *only* in
/// TypeScript. Any caller that reached the command with `paste: true` could
/// drive Ctrl+V into whatever application happened to be in the foreground even
/// though the user had never enabled system-wide paste. The stored setting is
/// now the authority and the argument can only ever narrow it.
///
/// Fails closed: an unreadable or corrupt `dictation.json` means clipboard-only.
fn paste_is_permitted(requested: bool) -> bool {
    if !requested {
        return false;
    }
    match read_dictation_config() {
        Ok(config) => config.system_wide_paste,
        Err(err) => {
            tracing::warn!("Could not read dictation settings ({err}); refusing system-wide paste");
            false
        }
    }
}

/// Put dictated text on the native clipboard and optionally paste it into the
/// foreground application. The transcript intentionally remains on the
/// clipboard after paste; restoring an earlier clipboard value can re-expose a
/// password or one-time code.
#[tauri::command]
pub fn deliver_dictation_text(text: String, paste: bool) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("Cannot deliver an empty transcription".to_string());
    }

    let paste = paste_is_permitted(paste);

    #[cfg(target_os = "windows")]
    {
        use enigo::{
            Direction::{Click, Press, Release},
            Enigo, Key, Keyboard, Settings,
        };

        set_clipboard_with_retry(&text)?;

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
        // Tracked macOS/Linux blocker. This is deliberately a typed error rather
        // than a silent success so the caller falls back to its own clipboard
        // path instead of believing the transcript was delivered.
        Err(
            "Native dictation delivery is currently available on Windows; the transcript remains available in PacketBench"
                .to_string(),
        )
    }
}

/// Copy to the clipboard, retrying briefly on contention.
///
/// Failure mode: `OpenClipboard` fails outright while another process holds the
/// clipboard (Office, RDP, clipboard managers, and Windows Clipboard History
/// all grab it for a few milliseconds at a time). A single attempt turned that
/// routine contention into a lost transcript.
#[cfg(target_os = "windows")]
fn set_clipboard_with_retry(text: &str) -> Result<(), String> {
    const ATTEMPTS: usize = 5;
    const BACKOFF: std::time::Duration = std::time::Duration::from_millis(25);

    let mut last_error = String::new();
    for attempt in 0..ATTEMPTS {
        match clipboard_win::set_clipboard_string(text) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_error = err.to_string();
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(BACKOFF);
                }
            }
        }
    }
    Err(format!(
        "Failed to copy transcription to the clipboard after {ATTEMPTS} attempts: {last_error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paste_is_refused_when_the_caller_did_not_ask_for_it() {
        // Guards the cheap half of the opt-in without touching the user's real
        // dictation.json: `false` must short-circuit before the config is read.
        assert!(!paste_is_permitted(false));
    }

    #[test]
    fn empty_transcripts_are_never_delivered() {
        assert!(deliver_dictation_text("   \n\t ".to_string(), false).is_err());
        assert!(deliver_dictation_text(String::new(), true).is_err());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_delivery_is_a_typed_error_not_a_silent_success() {
        let result = deliver_dictation_text("hello".to_string(), false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Windows"));
    }
}
