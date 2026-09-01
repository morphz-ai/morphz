//! Windows command runner used by the **elevated** sandbox path.
//!
//! The CLI launches this binary under the sandbox user when Windows sandbox level is
//! Elevated. It connects to the IPC pipes, reads the framed `SpawnRequest`, derives a
//! restricted token from the sandbox user, and spawns the child process via ConPTY
//! (`tty=true`) or pipes (`tty=false`). It then streams output frames back to the parent,
//! accepts stdin/terminate frames, and emits a final exit frame. The legacy restricted‑token
//! path spawns the child directly and does not use this runner.

#![allow(unsafe_op_in_unsafe_fn)]

mod cwd_junction;
#[cfg(test)]
#[path = "win/input_loop_tests.rs"]
mod input_loop_tests;

use anyhow::Context;
use anyhow::Result;
use codex_utils_pty::JobObject;
use morphz_windows_sandbox::ConsoleMode;
use morphz_windows_sandbox::ErrorPayload;
use morphz_windows_sandbox::ErrorStage;
use morphz_windows_sandbox::ExitPayload;
use morphz_windows_sandbox::FramedMessage;
use morphz_windows_sandbox::IPC_PROTOCOL_VERSION;
use morphz_windows_sandbox::LaunchDesktop;
use morphz_windows_sandbox::LocalSid;
use morphz_windows_sandbox::Message;
use morphz_windows_sandbox::OutputPayload;
use morphz_windows_sandbox::OutputStream;
use morphz_windows_sandbox::PipeSpawnHandles;
use morphz_windows_sandbox::ResizePayload;
use morphz_windows_sandbox::SpawnReady;
use morphz_windows_sandbox::SpawnRequest;
use morphz_windows_sandbox::StderrMode;
use morphz_windows_sandbox::StdinMode;
use morphz_windows_sandbox::WindowsSandboxTokenMode;
use morphz_windows_sandbox::allow_null_device;
use morphz_windows_sandbox::create_readonly_token_with_caps_and_user_from;
use morphz_windows_sandbox::create_workspace_write_token_with_caps_and_user_from;
use morphz_windows_sandbox::decode_bytes;
use morphz_windows_sandbox::encode_bytes;
use morphz_windows_sandbox::get_current_token_for_restriction;
use morphz_windows_sandbox::hide_current_user_profile_dir;
use morphz_windows_sandbox::log_note;
use morphz_windows_sandbox::read_frame;
use morphz_windows_sandbox::read_handle_loop;
use morphz_windows_sandbox::spawn_process_with_pipes;
use morphz_windows_sandbox::to_wide;
use morphz_windows_sandbox::token_mode_for_permission_profile;
use morphz_windows_sandbox::write_frame;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::path::PathBuf;
use std::ptr;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;
use windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING;
use windows_sys::Win32::System::Console::AllocConsole;
use windows_sys::Win32::System::Console::COORD;
use windows_sys::Win32::System::Console::ResizePseudoConsole;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::GetProcessId;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

// Morphz's private filesystem-helper marker. Keep this product-scoped because it can appear in
// process inspection and diagnostics even though it is not part of the public CLI.
const FS_HELPER_ARG: &str = "--morphz-run-as-fs-helper";
const TERMINATION_WAIT_MS: u32 = 5_000;
const WAIT_TIMEOUT: u32 = 0x0000_0102;

fn bootstrap_log(path: Option<&Path>, stage: &str) {
    let Some(path) = path else {
        return;
    };
    let pid = std::process::id();
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp} pid={pid}] {stage}");
    }
}

struct IpcSpawnedProcess {
    log_dir: PathBuf,
    pi: PROCESS_INFORMATION,
    job: Arc<JobObject>,
    stdout_handle: HANDLE,
    stderr_handle: HANDLE,
    stdin_handle: Option<HANDLE>,
    conpty_owner: Option<morphz_windows_sandbox::ConptyInstance>,
    hpc_handle: Option<HANDLE>,
    _pipe_handles: Option<PipeSpawnHandles>,
}

/// Small RAII wrapper for raw Win32 handles.
///
/// The elevated runner has a few early-return paths where we acquire a token, job, or pipe
/// handle and then may fail while preparing the child. Keeping those handles in a guard makes
/// the error paths read more directly and closes the gaps that were previously leaking them.
struct OwnedWinHandle(HANDLE);

impl OwnedWinHandle {
    fn new(handle: HANDLE) -> Self {
        Self(handle)
    }

    fn raw(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        // Transfer ownership to the caller. After this point the caller is responsible for
        // eventually closing the returned HANDLE.
        let handle = self.0;
        self.0 = 0;
        handle
    }
}

impl Drop for OwnedWinHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Open a named pipe created by the parent process.
fn open_pipe(name: &str, access: u32) -> Result<HANDLE> {
    let path = to_wide(name);
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            0,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            0,
            0,
        )
    };
    if handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        let err = unsafe { GetLastError() };
        return Err(anyhow::anyhow!("CreateFileW failed for pipe {name}: {err}"));
    }
    Ok(handle)
}

/// Send an error frame back to the parent process.
fn send_error(
    writer: &Arc<StdMutex<File>>,
    stage: ErrorStage,
    windows_error_code: Option<u32>,
    message: String,
) -> Result<()> {
    let msg = FramedMessage {
        version: IPC_PROTOCOL_VERSION,
        message: Message::Error {
            payload: ErrorPayload {
                message,
                stage,
                windows_error_code,
            },
        },
    };
    if let Ok(mut guard) = writer.lock() {
        write_frame(&mut *guard, &msg)?;
    }
    Ok(())
}

fn windows_error_code(err: &anyhow::Error) -> Option<u32> {
    err.chain().find_map(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::raw_os_error)
            .and_then(|code| u32::try_from(code).ok())
    })
}

/// Read and validate the initial spawn request frame.
fn read_spawn_request(reader: &mut File) -> Result<SpawnRequest> {
    let Some(msg) = read_frame(reader)? else {
        anyhow::bail!("runner: pipe closed before spawn_request");
    };
    if msg.version != IPC_PROTOCOL_VERSION {
        anyhow::bail!("runner: unsupported protocol version {}", msg.version);
    }
    match msg.message {
        Message::SpawnRequest { payload } => Ok(*payload),
        other => anyhow::bail!("runner: expected spawn_request, got {other:?}"),
    }
}

/// Pick an effective CWD through the sandbox user's private junction tree.
///
/// A restricted local account cannot reliably inherit a startup directory nested below the
/// signed-in user's profile even after the leaf ACL is granted. Keeping this indirection stable
/// also avoids coupling command correctness to whether the ACL helper happens to be alive at
/// spawn time. Write authority remains fenced by the per-root capability SID.
fn effective_cwd(req_cwd: &Path, log_dir: Option<&Path>) -> PathBuf {
    cwd_junction::create_cwd_junction(req_cwd, log_dir).unwrap_or_else(|| req_cwd.to_path_buf())
}

fn ensure_inheritable_console(log_dir: Option<&Path>) -> Result<()> {
    if unsafe { AllocConsole() } != 0 {
        log_note(
            "console: allocated private runner console for restricted child inheritance",
            log_dir,
        );
        return Ok(());
    }
    let error = unsafe { GetLastError() };
    if error == ERROR_ACCESS_DENIED {
        // AllocConsole reports access denied when this process is already attached to a console.
        log_note(
            "console: runner already has a console for restricted child inheritance",
            log_dir,
        );
        return Ok(());
    }
    anyhow::bail!("AllocConsole failed for sandbox runner: {error}")
}

fn spawn_ipc_process(req: &SpawnRequest) -> Result<IpcSpawnedProcess> {
    let log_dir = req.codex_home.clone();
    hide_current_user_profile_dir(req.codex_home.as_path());
    let token_mode = token_mode_for_permission_profile(
        &req.permission_profile,
        &req.workspace_roots,
        &req.cwd,
        &req.env,
    )
    .context("resolve permission profile token mode")?;
    let mut cap_psids: Vec<LocalSid> = Vec::new();
    for sid in &req.cap_sids {
        cap_psids.push(
            LocalSid::from_string(sid)
                .context("ConvertStringSidToSidW failed for capability SID")?,
        );
    }
    if cap_psids.is_empty() {
        anyhow::bail!("runner: empty capability SID list");
    }
    let network_proxy_restricting_sid = req
        .network_proxy_restricting_sid
        .as_deref()
        .map(LocalSid::from_string)
        .transpose()
        .context("ConvertStringSidToSidW failed for network proxy restricting SID")?;

    // The token helpers still take raw SID pointers, but we keep ownership in `LocalSid`
    // wrappers for as long as possible. That way any failure after SID parsing but before the
    // child is fully spawned still releases the backing LocalAlloc memory automatically.
    let cap_psid_ptrs: Vec<*mut _> = cap_psids.iter().map(LocalSid::as_ptr).collect();
    let additional_restricting_sid_ptrs: Vec<*mut _> = network_proxy_restricting_sid
        .iter()
        .map(LocalSid::as_ptr)
        .collect();
    let base = OwnedWinHandle::new(unsafe { get_current_token_for_restriction()? });
    let h_token = OwnedWinHandle::new(unsafe {
        match token_mode {
            WindowsSandboxTokenMode::ReadOnlyCapability => {
                create_readonly_token_with_caps_and_user_from(
                    base.raw(),
                    &cap_psid_ptrs,
                    &additional_restricting_sid_ptrs,
                )
            }
            WindowsSandboxTokenMode::WritableRootsCapability => {
                create_workspace_write_token_with_caps_and_user_from(
                    base.raw(),
                    &cap_psid_ptrs,
                    &additional_restricting_sid_ptrs,
                )
            }
        }
    }?);
    unsafe {
        // These ACL adjustments need the raw SID values, but ownership stays with `cap_psids`.
        // We do not manually `LocalFree` anything here; the wrappers handle every return path.
        allow_null_device(cap_psid_ptrs[0]);
        for psid in &cap_psid_ptrs {
            allow_null_device(*psid);
        }
    }

    let effective_cwd = effective_cwd(&req.cwd, Some(log_dir.as_path()));
    let desktop = if req.use_private_desktop {
        LaunchDesktop::reference_parent_owned_private(
            req.private_desktop_path
                .as_deref()
                .context("runner: missing parent-owned private desktop")?,
        )?
    } else {
        LaunchDesktop::reference_default()
    };

    let mut conpty_owner = None;
    let mut hpc_handle: Option<HANDLE> = None;
    let mut pipe_handles = None;
    if !req.tty && !req.command.get(1).is_some_and(|arg| arg == FS_HELPER_ARG) {
        ensure_inheritable_console(Some(log_dir.as_path()))?;
    }
    let (pi, job, stdout_handle, stderr_handle, stdin_handle) = if req.tty {
        let (pi, mut conpty) = morphz_windows_sandbox::spawn_conpty_process_as_user(
            h_token.raw(),
            &req.command,
            &effective_cwd,
            &req.env,
            desktop,
        )?;
        let job = conpty
            .job()
            .context("spawned ConPTY is missing its process job")?;
        hpc_handle = conpty.raw_handle();
        let input_write = conpty.take_input_write();
        let output_read = conpty.take_output_read();
        conpty_owner = Some(conpty);
        let stdin_handle = if req.stdin_open {
            Some(input_write)
        } else {
            unsafe {
                CloseHandle(input_write);
            }
            None
        };
        (
            pi,
            job,
            output_read,
            windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE,
            stdin_handle,
        )
    } else {
        let stdin_mode = if req.stdin_open {
            StdinMode::Open
        } else {
            StdinMode::Closed
        };
        let spawned_pipes: PipeSpawnHandles = spawn_process_with_pipes(
            h_token.raw(),
            &req.command,
            &effective_cwd,
            &req.env,
            stdin_mode,
            StderrMode::Separate,
            if req.command.get(1).is_some_and(|arg| arg == FS_HELPER_ARG) {
                ConsoleMode::NoWindow
            } else {
                ConsoleMode::Inherit
            },
            desktop,
            Some(log_dir.as_path()),
        )?;
        let pi = spawned_pipes.process;
        let stdout_handle = spawned_pipes.stdout_read;
        let stderr_handle = spawned_pipes
            .stderr_read
            .unwrap_or(windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE);
        let stdin_handle = spawned_pipes.stdin_write;
        let job = spawned_pipes.job();
        pipe_handles = Some(spawned_pipes);
        (pi, job, stdout_handle, stderr_handle, stdin_handle)
    };
    log_note(
        &format!("runner child spawned pid={}", unsafe {
            GetProcessId(pi.hProcess)
        }),
        Some(log_dir.as_path()),
    );
    Ok(IpcSpawnedProcess {
        log_dir,
        pi,
        job,
        stdout_handle,
        stderr_handle,
        stdin_handle,
        conpty_owner,
        hpc_handle,
        _pipe_handles: pipe_handles,
    })
}

/// Stream stdout/stderr from the child into Output frames.
fn spawn_output_reader(
    writer: Arc<StdMutex<File>>,
    handle: HANDLE,
    stream: OutputStream,
    log_dir: Option<PathBuf>,
) -> std::thread::JoinHandle<()> {
    read_handle_loop(handle, move |chunk| {
        let msg = FramedMessage {
            version: IPC_PROTOCOL_VERSION,
            message: Message::Output {
                payload: OutputPayload {
                    data_b64: encode_bytes(chunk),
                    stream,
                },
            },
        };
        if let Ok(mut guard) = writer.lock()
            && let Err(err) = write_frame(&mut *guard, &msg)
        {
            log_note(
                &format!("runner output write failed: {err}"),
                log_dir.as_deref(),
            );
        }
    })
}

fn terminate_job_or_process(job: &JobObject, process: HANDLE, log_dir: Option<&Path>) {
    if let Err(job_err) = job.terminate() {
        log_note(
            &format!("runner failed to terminate process tree: {job_err}"),
            log_dir,
        );
        if unsafe { TerminateProcess(process, 1) } == 0 {
            log_note(
                &format!("runner failed to terminate root process: {}", unsafe {
                    GetLastError()
                }),
                log_dir,
            );
        }
    }
}

/// Read stdin/terminate frames and forward to the child process.
fn spawn_input_loop(
    mut reader: File,
    stdin_handle: Option<HANDLE>,
    hpc_handle: Arc<StdMutex<Option<HANDLE>>>,
    job: Arc<JobObject>,
    process: HANDLE,
    log_dir: Option<PathBuf>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut stdin_handle = stdin_handle;
        loop {
            let msg = match read_frame(&mut reader) {
                Ok(Some(v)) => v,
                Ok(None) | Err(_) => {
                    terminate_job_or_process(&job, process, log_dir.as_deref());
                    break;
                }
            };
            match msg.message {
                Message::Stdin { payload } => {
                    let Ok(bytes) = decode_bytes(&payload.data_b64) else {
                        continue;
                    };
                    if let Some(handle) = stdin_handle {
                        let mut offset = 0usize;
                        // `WriteFile` can report success after consuming only part of the buffer
                        // when the target is a pipe. Treat this like a normal partial write and
                        // keep advancing until every decoded stdin byte has been forwarded.
                        //
                        // If the child closes stdin or the pipe enters an error state, we log
                        // that fact, close our local HANDLE, and stop trying to forward later
                        // `Stdin` frames. That prevents silent truncation while also avoiding an
                        // endless stream of failing writes after the child is already gone.
                        while offset < bytes.len() {
                            let chunk = &bytes[offset..];
                            let chunk_len = chunk.len().min(u32::MAX as usize);
                            let mut written = 0u32;
                            let ok = unsafe {
                                windows_sys::Win32::Storage::FileSystem::WriteFile(
                                    handle,
                                    chunk.as_ptr(),
                                    chunk_len as u32,
                                    &mut written,
                                    ptr::null_mut(),
                                )
                            };
                            if ok == 0 {
                                log_note(
                                    &format!(
                                        "runner stdin write failed after {offset} bytes: {}",
                                        unsafe { GetLastError() }
                                    ),
                                    log_dir.as_deref(),
                                );
                                unsafe {
                                    CloseHandle(handle);
                                }
                                stdin_handle = None;
                                break;
                            }
                            if written == 0 {
                                log_note(
                                    "runner stdin write made no progress; closing child stdin",
                                    log_dir.as_deref(),
                                );
                                unsafe {
                                    CloseHandle(handle);
                                }
                                stdin_handle = None;
                                break;
                            }
                            offset += written as usize;
                        }
                    }
                }
                Message::CloseStdin { .. } => {
                    if let Some(handle) = stdin_handle.take() {
                        unsafe {
                            CloseHandle(handle);
                        }
                    }
                }
                Message::Resize {
                    payload: ResizePayload { rows, cols },
                } => {
                    if let Ok(guard) = hpc_handle.lock()
                        && let Some(hpc) = guard.as_ref()
                    {
                        unsafe {
                            let _ = ResizePseudoConsole(
                                *hpc,
                                COORD {
                                    X: cols as i16,
                                    Y: rows as i16,
                                },
                            );
                        }
                    }
                }
                Message::Terminate { .. } => {
                    terminate_job_or_process(&job, process, log_dir.as_deref());
                }
                Message::SpawnRequest { .. } => {}
                Message::SpawnReady { .. } => {}
                Message::Output { .. } => {}
                Message::Exit { .. } => {}
                Message::Error { .. } => {}
            }
        }
        if let Some(handle) = stdin_handle {
            unsafe {
                CloseHandle(handle);
            }
        }
    })
}

/// Terminate the restricted child Job as soon as the trusted wrapper disappears.
///
/// The wrapper and command runner use different local Windows accounts. Relying only on named
/// pipe EOF after `TerminateProcess(wrapper)` can leave the runner blocked long enough for an
/// untrusted descendant to continue executing. A process synchronization handle is the kernel's
/// direct lifetime signal and is independent of Rust destructors and pipe-drain scheduling.
fn spawn_supervisor_watchdog(
    supervisor_process_handle: Option<usize>,
    supervisor_process_id: Option<u32>,
    job: Arc<JobObject>,
    process: HANDLE,
    log_dir: Option<PathBuf>,
) -> Option<std::thread::JoinHandle<()>> {
    let supervisor = supervisor_process_handle
        .map(|handle| handle as HANDLE)
        .or_else(|| {
            let supervisor_process_id = supervisor_process_id?;
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, supervisor_process_id) };
            (handle != 0).then_some(handle)
        });
    let Some(supervisor) = supervisor else {
        let supervisor_label = supervisor_process_id
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        log_note(
            &format!(
                "runner could not attach a supervisor lifetime handle for pid {supervisor_label}: {}; falling back to the authenticated transport lifetime",
                unsafe { GetLastError() }
            ),
            log_dir.as_deref(),
        );
        return None;
    };
    let supervisor_label = supervisor_process_id
        .map(|pid| pid.to_string())
        .unwrap_or_else(|| "duplicated-handle".to_string());
    log_note(
        &format!("runner supervisor watchdog attached supervisor={supervisor_label}"),
        log_dir.as_deref(),
    );
    Some(std::thread::spawn(move || {
        let _ = unsafe { WaitForSingleObject(supervisor, INFINITE) };
        unsafe {
            CloseHandle(supervisor);
        }
        log_note(
            &format!("runner supervisor watchdog observed exit supervisor={supervisor_label}"),
            log_dir.as_deref(),
        );
        terminate_job_or_process(&job, process, log_dir.as_deref());
    }))
}

/// Entry point for the Windows command runner process.
pub fn main() -> Result<()> {
    let mut pipe_in = None;
    let mut pipe_out = None;
    let mut bootstrap_log_path = None;
    for arg in std::env::args().skip(1) {
        if let Some(rest) = arg.strip_prefix("--pipe-in=") {
            pipe_in = Some(rest.to_string());
        } else if let Some(rest) = arg.strip_prefix("--pipe-out=") {
            pipe_out = Some(rest.to_string());
        } else if let Some(rest) = arg.strip_prefix("--bootstrap-log=") {
            bootstrap_log_path = Some(PathBuf::from(rest));
        }
    }
    let bootstrap_log_path = bootstrap_log_path.as_deref();
    bootstrap_log(bootstrap_log_path, "runner main entered");

    let Some(pipe_in) = pipe_in else {
        bootstrap_log(bootstrap_log_path, "missing --pipe-in argument");
        anyhow::bail!("runner: no pipe-in provided");
    };
    let Some(pipe_out) = pipe_out else {
        bootstrap_log(bootstrap_log_path, "missing --pipe-out argument");
        anyhow::bail!("runner: no pipe-out provided");
    };

    // Open both pipe ends under guards first so a failure on the second open cannot leak the
    // first HANDLE. Only after both opens succeed do we transfer ownership into `File`, which
    // then becomes responsible for closing them.
    let h_pipe_in = match open_pipe(&pipe_in, FILE_GENERIC_READ) {
        Ok(handle) => {
            bootstrap_log(bootstrap_log_path, "pipe-in opened");
            OwnedWinHandle::new(handle)
        }
        Err(err) => {
            bootstrap_log(bootstrap_log_path, &format!("pipe-in open failed: {err:#}"));
            return Err(err);
        }
    };
    let h_pipe_out = match open_pipe(&pipe_out, FILE_GENERIC_WRITE) {
        Ok(handle) => {
            bootstrap_log(bootstrap_log_path, "pipe-out opened");
            OwnedWinHandle::new(handle)
        }
        Err(err) => {
            bootstrap_log(
                bootstrap_log_path,
                &format!("pipe-out open failed: {err:#}"),
            );
            return Err(err);
        }
    };
    bootstrap_log(bootstrap_log_path, "both parent pipes connected");
    let mut pipe_read = unsafe { File::from_raw_handle(h_pipe_in.into_raw() as _) };
    let pipe_write = Arc::new(StdMutex::new(unsafe {
        File::from_raw_handle(h_pipe_out.into_raw() as _)
    }));

    let req = match read_spawn_request(&mut pipe_read) {
        Ok(v) => v,
        Err(err) => {
            let _ = send_error(
                &pipe_write,
                ErrorStage::ReadSpawnRequest,
                /*windows_error_code*/ None,
                err.to_string(),
            );
            return Err(err);
        }
    };

    let ipc_spawn = match spawn_ipc_process(&req) {
        Ok(value) => value,
        Err(err) => {
            let _ = send_error(
                &pipe_write,
                ErrorStage::SpawnChild,
                windows_error_code(&err),
                err.to_string(),
            );
            return Err(err);
        }
    };
    let log_dir = Some(ipc_spawn.log_dir.as_path());
    let pi = ipc_spawn.pi;
    let stdout_handle = ipc_spawn.stdout_handle;
    let stderr_handle = ipc_spawn.stderr_handle;
    let job = Arc::clone(&ipc_spawn.job);
    let mut conpty_owner = ipc_spawn.conpty_owner;
    let stdin_handle = ipc_spawn.stdin_handle;
    let hpc_handle = Arc::new(StdMutex::new(ipc_spawn.hpc_handle));

    let msg = FramedMessage {
        version: IPC_PROTOCOL_VERSION,
        message: Message::SpawnReady {
            payload: SpawnReady {
                process_id: unsafe { GetProcessId(pi.hProcess) },
            },
        },
    };
    if let Err(err) = if let Ok(mut guard) = pipe_write.lock() {
        write_frame(&mut *guard, &msg)
    } else {
        anyhow::bail!("runner spawn_ready write failed: pipe_write lock poisoned");
    } {
        let _ = send_error(
            &pipe_write,
            ErrorStage::WriteSpawnReady,
            /*windows_error_code*/ None,
            err.to_string(),
        );
        return Err(err);
    }
    let log_dir_owned = log_dir.map(Path::to_path_buf);
    let out_thread = spawn_output_reader(
        Arc::clone(&pipe_write),
        stdout_handle,
        OutputStream::Stdout,
        log_dir_owned.clone(),
    );
    let err_thread = if stderr_handle != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        Some(spawn_output_reader(
            Arc::clone(&pipe_write),
            stderr_handle,
            OutputStream::Stderr,
            log_dir_owned.clone(),
        ))
    } else {
        None
    };

    let _input_thread = spawn_input_loop(
        pipe_read,
        stdin_handle,
        Arc::clone(&hpc_handle),
        Arc::clone(&job),
        pi.hProcess,
        log_dir_owned,
    );
    let _supervisor_watchdog = spawn_supervisor_watchdog(
        req.supervisor_process_handle,
        req.supervisor_process_id,
        Arc::clone(&job),
        pi.hProcess,
        log_dir.map(Path::to_path_buf),
    );

    let timeout = req.timeout_ms.map(|ms| ms as u32).unwrap_or(INFINITE);
    let wait_res = unsafe { WaitForSingleObject(pi.hProcess, timeout) };
    let timed_out = wait_res == WAIT_TIMEOUT;
    let child_stopped = if timed_out {
        terminate_job_or_process(&job, pi.hProcess, log_dir);
        let termination_wait = unsafe { WaitForSingleObject(pi.hProcess, TERMINATION_WAIT_MS) };
        if termination_wait == WAIT_TIMEOUT {
            log_note(
                "runner root process did not exit after termination",
                log_dir,
            );
            false
        } else {
            true
        }
    } else {
        if let Err(err) = job.preserve_descendants() {
            log_note(
                &format!("runner failed to preserve descendants after root exit: {err}"),
                log_dir,
            );
        }
        true
    };

    let exit_code: i32;
    unsafe {
        if timed_out {
            exit_code = 128 + 64;
        } else {
            let mut raw_exit: u32 = 1;
            GetExitCodeProcess(pi.hProcess, &mut raw_exit);
            exit_code = raw_exit as i32;
        }
        if pi.hThread != 0 {
            CloseHandle(pi.hThread);
        }
        if pi.hProcess != 0 {
            CloseHandle(pi.hProcess);
        }
    }

    if let Ok(mut guard) = hpc_handle.lock() {
        let _ = guard.take();
    }
    drop(conpty_owner.take());

    if child_stopped {
        if out_thread.join().is_err() {
            log_note("runner stdout reader thread panicked", log_dir);
        }
        if let Some(thread) = err_thread
            && thread.join().is_err()
        {
            log_note("runner stderr reader thread panicked", log_dir);
        }
    }

    let exit_msg = FramedMessage {
        version: IPC_PROTOCOL_VERSION,
        message: Message::Exit {
            payload: ExitPayload {
                exit_code,
                timed_out,
            },
        },
    };
    if let Ok(mut guard) = pipe_write.lock()
        && let Err(err) = write_frame(&mut *guard, &exit_msg)
    {
        log_note(&format!("runner exit write failed: {err}"), log_dir);
    }

    std::process::exit(exit_code);
}
