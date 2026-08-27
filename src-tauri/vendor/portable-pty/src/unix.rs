//! Working with pseudo-terminals

use crate::{Child, CommandBuilder, MasterPty, PtyPair, PtySize, PtySystem, SlavePty};
use anyhow::{bail, Error};
use filedescriptor::FileDescriptor;
use libc::{self, winsize};
use std::cell::RefCell;
use std::io::{Read, Write};
use std::os::unix::io::{AsRawFd, FromRawFd};
// CommandExt (pre_exec) intentionally removed — PacketBench spawns via posix_spawn
// (no pre_exec) to stay fork-safe in a multi-threaded host. See spawn_command.
use std::{io, mem, ptr};

pub use std::os::unix::io::RawFd;

#[derive(Default)]
pub struct UnixPtySystem {}

fn openpty(size: PtySize) -> anyhow::Result<(UnixMasterPty, UnixSlavePty)> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;

    let mut size = winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: size.pixel_width,
        ws_ypixel: size.pixel_height,
    };

    let result = unsafe {
        // BSDish systems may require mut pointers to some args
        #[cfg_attr(feature = "cargo-clippy", allow(clippy::unnecessary_mut_passed))]
        libc::openpty(
            &mut master,
            &mut slave,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut size,
        )
    };

    if result != 0 {
        bail!("failed to openpty: {:?}", io::Error::last_os_error());
    }

    let master = UnixMasterPty {
        fd: PtyFd(unsafe { FileDescriptor::from_raw_fd(master) }),
        took_writer: RefCell::new(false),
    };
    let slave = UnixSlavePty {
        fd: PtyFd(unsafe { FileDescriptor::from_raw_fd(slave) }),
    };

    // Ensure that these descriptors will get closed when we execute
    // the child process.  This is done after constructing the Pty
    // instances so that we ensure that the Ptys get drop()'d if
    // the cloexec() functions fail (unlikely!).
    cloexec(master.fd.as_raw_fd())?;
    cloexec(slave.fd.as_raw_fd())?;

    Ok((master, slave))
}

impl PtySystem for UnixPtySystem {
    fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair> {
        let (master, slave) = openpty(size)?;
        Ok(PtyPair {
            master: Box::new(master),
            slave: Box::new(slave),
        })
    }
}

struct PtyFd(pub FileDescriptor);
impl std::ops::Deref for PtyFd {
    type Target = FileDescriptor;
    fn deref(&self) -> &FileDescriptor {
        &self.0
    }
}
impl std::ops::DerefMut for PtyFd {
    fn deref_mut(&mut self) -> &mut FileDescriptor {
        &mut self.0
    }
}

impl Read for PtyFd {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, io::Error> {
        match self.0.read(buf) {
            Err(ref e) if e.raw_os_error() == Some(libc::EIO) => {
                // EIO indicates that the slave pty has been closed.
                // Treat this as EOF so that std::io::Read::read_to_string
                // and similar functions gracefully terminate when they
                // encounter this condition
                Ok(0)
            }
            x => x,
        }
    }
}

/// On Big Sur, Cocoa leaks various file descriptors to child processes,
/// so we need to make a pass through the open descriptors beyond just the
/// stdio descriptors and close them all out.
/// This is approximately equivalent to the darwin `posix_spawnattr_setflags`
/// option POSIX_SPAWN_CLOEXEC_DEFAULT which is used as a bit of a cheat
/// on macOS.
/// On Linux, gnome/mutter leak shell extension fds to wezterm too, so we
/// also need to make an effort to clean up the mess.
///
/// This function enumerates the open filedescriptors in the current process
/// and then will forcibly call close(2) on each open fd that is numbered
/// 3 or higher, effectively closing all descriptors except for the stdio
/// streams.
///
/// The implementation of this function relies on `/dev/fd` being available
/// to provide the list of open fds.  Any errors in enumerating or closing
/// the fds are silently ignored.
pub fn close_random_fds() {
    // PATCHED (PacketBench): upstream read `/dev/fd` via `std::fs::read_dir` and
    // collected fds into a `Vec`. That runs inside the forked child *before*
    // exec, and `read_dir`/`Vec` call `malloc`. In a heavily-threaded host
    // (Tauri's embedded WebKit) a background thread can hold the allocator lock
    // at `fork()` time, so the child deadlocks/aborts ("crashed on child side of
    // fork pre-exec"). Replaced with an allocation-free, async-signal-safe raw
    // `close()` sweep over the descriptor table.
    let max = unsafe { libc::getdtablesize() };
    let mut fd: libc::c_int = 3;
    while fd < max {
        unsafe {
            libc::close(fd);
        }
        fd += 1;
    }
}

impl PtyFd {
    fn resize(&self, size: PtySize) -> Result<(), Error> {
        let ws_size = winsize {
            ws_row: size.rows,
            ws_col: size.cols,
            ws_xpixel: size.pixel_width,
            ws_ypixel: size.pixel_height,
        };

        if unsafe {
            libc::ioctl(
                self.0.as_raw_fd(),
                libc::TIOCSWINSZ as _,
                &ws_size as *const _,
            )
        } != 0
        {
            bail!(
                "failed to ioctl(TIOCSWINSZ): {:?}",
                io::Error::last_os_error()
            );
        }

        Ok(())
    }

    fn get_size(&self) -> Result<PtySize, Error> {
        let mut size: winsize = unsafe { mem::zeroed() };
        if unsafe {
            libc::ioctl(
                self.0.as_raw_fd(),
                libc::TIOCGWINSZ as _,
                &mut size as *mut _,
            )
        } != 0
        {
            bail!(
                "failed to ioctl(TIOCGWINSZ): {:?}",
                io::Error::last_os_error()
            );
        }
        Ok(PtySize {
            rows: size.ws_row,
            cols: size.ws_col,
            pixel_width: size.ws_xpixel,
            pixel_height: size.ws_ypixel,
        })
    }

    fn spawn_command(&self, builder: CommandBuilder) -> anyhow::Result<std::process::Child> {
        // PATCHED (PacketBench): upstream forked and ran `setsid`/`TIOCSCTTY` in a
        // `.pre_exec()` closure. `fork()` is unsafe in this host — Tauri's
        // embedded WebKit makes the process heavily multi-threaded, and the fork
        // child aborts before exec ("crashed on child side of fork pre-exec").
        //
        // Instead we `posix_spawn` a tiny helper (this same binary, re-invoked as
        // `__pty_spawn`) with the slave pty as its stdin/stdout/stderr. The helper
        // is a fresh, single-threaded process: it `chdir`s, becomes a session
        // leader, claims the pty as its controlling terminal, and `exec`s the real
        // program. A `std::process::Command` with NO `pre_exec` and NO
        // `current_dir` resolves to `posix_spawn` on macOS, which is designed to
        // be safe in a multi-threaded process.
        let real = builder.as_command()?;
        let program = real.get_program().to_os_string();
        let args: Vec<std::ffi::OsString> = real.get_args().map(|a| a.to_os_string()).collect();
        let cwd: std::ffi::OsString = real
            .get_current_dir()
            .map(|p| p.as_os_str().to_os_string())
            .unwrap_or_default();
        let envs: Vec<(std::ffi::OsString, Option<std::ffi::OsString>)> = real
            .get_envs()
            .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
            .collect();
        drop(real);

        let helper = std::env::current_exe()
            .map_err(|e| anyhow::anyhow!("failed to resolve current_exe for pty helper: {}", e))?;

        // Helper protocol: <exe> __pty_spawn <cwd> <program> <args...>
        // (cwd is applied by the helper via chdir, so we don't set current_dir
        // here — that keeps Rust on the posix_spawn path rather than fork.)
        let mut cmd = std::process::Command::new(helper);
        cmd.arg("__pty_spawn");
        cmd.arg(&cwd);
        cmd.arg(&program);
        cmd.args(&args);
        cmd.env_clear();
        for (k, v) in envs {
            if let Some(v) = v {
                cmd.env(k, v);
            }
        }
        cmd.stdin(self.as_stdio()?)
            .stdout(self.as_stdio()?)
            .stderr(self.as_stdio()?);
        // No `.pre_exec()` and no `.current_dir()` → posix_spawn, not fork().

        let mut child = cmd.spawn()?;

        // Ensure that we close out the slave fds that Child retains.
        child.stdin.take();
        child.stdout.take();
        child.stderr.take();

        Ok(child)
    }
}

/// Represents the master end of a pty.
/// The file descriptor will be closed when the Pty is dropped.
struct UnixMasterPty {
    fd: PtyFd,
    took_writer: RefCell<bool>,
}

/// Represents the slave end of a pty.
/// The file descriptor will be closed when the Pty is dropped.
struct UnixSlavePty {
    fd: PtyFd,
}

/// Helper function to set the close-on-exec flag for a raw descriptor
fn cloexec(fd: RawFd) -> Result<(), Error> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 {
        bail!(
            "fcntl to read flags failed: {:?}",
            io::Error::last_os_error()
        );
    }
    let result = unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) };
    if result == -1 {
        bail!(
            "fcntl to set CLOEXEC failed: {:?}",
            io::Error::last_os_error()
        );
    }
    Ok(())
}

impl SlavePty for UnixSlavePty {
    fn spawn_command(
        &self,
        builder: CommandBuilder,
    ) -> Result<Box<dyn Child + Send + Sync>, Error> {
        Ok(Box::new(self.fd.spawn_command(builder)?))
    }
}

impl MasterPty for UnixMasterPty {
    fn resize(&self, size: PtySize) -> Result<(), Error> {
        self.fd.resize(size)
    }

    fn get_size(&self) -> Result<PtySize, Error> {
        self.fd.get_size()
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, Error> {
        let fd = PtyFd(self.fd.try_clone()?);
        Ok(Box::new(fd))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>, Error> {
        if *self.took_writer.borrow() {
            anyhow::bail!("cannot take writer more than once");
        }
        *self.took_writer.borrow_mut() = true;
        let fd = PtyFd(self.fd.try_clone()?);
        Ok(Box::new(UnixMasterWriter { fd }))
    }

    fn as_raw_fd(&self) -> Option<RawFd> {
        Some(self.fd.0.as_raw_fd())
    }

    fn process_group_leader(&self) -> Option<libc::pid_t> {
        match unsafe { libc::tcgetpgrp(self.fd.0.as_raw_fd()) } {
            pid if pid > 0 => Some(pid),
            _ => None,
        }
    }

    fn get_termios(&self) -> Option<nix::sys::termios::Termios> {
        nix::sys::termios::tcgetattr(self.fd.0.as_raw_fd()).ok()
    }
}

/// Represents the master end of a pty.
/// EOT will be sent, and then the file descriptor will be closed when
/// the Pty is dropped.
struct UnixMasterWriter {
    fd: PtyFd,
}

impl Drop for UnixMasterWriter {
    fn drop(&mut self) {
        let mut t: libc::termios = unsafe { std::mem::MaybeUninit::zeroed().assume_init() };
        if unsafe { libc::tcgetattr(self.fd.0.as_raw_fd(), &mut t) } == 0 {
            // EOF is only interpreted after a newline, so if it is set,
            // we send a newline followed by EOF.
            let eot = t.c_cc[libc::VEOF];
            if eot != 0 {
                let _ = self.fd.0.write_all(&[b'\n', eot]);
            }
        }
    }
}

impl Write for UnixMasterWriter {
    fn write(&mut self, buf: &[u8]) -> Result<usize, io::Error> {
        self.fd.write(buf)
    }
    fn flush(&mut self) -> Result<(), io::Error> {
        self.fd.flush()
    }
}
