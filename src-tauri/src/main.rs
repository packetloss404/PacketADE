// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // PTY spawn helper mode (see `pty_spawn_helper`): when re-invoked with the
    // `__pty_spawn` sentinel, set up the controlling tty and exec the real
    // program instead of starting the app. Runs before any app init.
    #[cfg(unix)]
    {
        let argv: Vec<std::ffi::OsString> = std::env::args_os().collect();
        if argv.get(1).map(|a| a == "__pty_spawn").unwrap_or(false) {
            packetbench_lib::pty_spawn_helper(argv.get(2..).unwrap_or(&[]));
        }
    }

    if let Some(code) = packetbench_lib::core::ssh_askpass::helper_main() {
        std::process::exit(code);
    }

    if let Some(code) = packetbench_lib::core::claude_statusline::helper_main() {
        std::process::exit(code);
    }

    packetbench_lib::run()
}
