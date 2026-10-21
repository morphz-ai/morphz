//! Client for the administrator-installed Linux policy service. All authority
//! is kernel peer identity; neither launch IDs nor command output are receipts.
use super::{SandboxError, SandboxPolicy, ShellRequest};
use nix::libc;
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::CString;
use std::io;
use std::mem::{size_of, size_of_val, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const CONTROL: &str = "/run/morphz-sandbox/control.sock";
const CONFIG: &str = "/etc/morphz-sandbox/config.json";
const MAX_REPLY: usize = 262144;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    abi: u32,
    launcher: PathBuf,
    runtimes: Vec<PathBuf>,
}

fn error(context: &str, reason: impl std::fmt::Display) -> SandboxError {
    SandboxError::new(format!("Linux Bubblewrap/AppArmor policy service {context}: {reason}; fail_closed=true refuses unsandboxed fallback"))
}

fn trusted_file(path: &Path, executable: bool) -> Result<std::fs::File, SandboxError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(error(
            "installation",
            "expected a canonical administrator-owned path",
        ));
    }
    let mut parent = path.parent();
    while let Some(directory) = parent {
        let info = std::fs::symlink_metadata(directory).map_err(|e| error("directory", e))?;
        if !info.is_dir() || info.uid() != 0 || info.mode() & 0o022 != 0 {
            return Err(error(
                "installation",
                "a parent directory is not administrator-owned",
            ));
        }
        parent = directory.parent();
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| error("installation", e))?;
    let info = file.metadata().map_err(|e| error("installation", e))?;
    if !info.is_file()
        || info.uid() != 0
        || info.mode() & 0o6022 != 0
        || (executable && info.mode() & 0o111 == 0)
    {
        return Err(error(
            "installation",
            "untrusted configuration or non-setuid launcher",
        ));
    }
    Ok(file)
}

pub(super) fn launcher() -> Result<PathBuf, SandboxError> {
    use std::io::Read;
    let mut raw = Vec::new();
    trusted_file(Path::new(CONFIG), false)?
        .take((MAX_REPLY + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| error("configuration", e))?;
    if raw.len() > MAX_REPLY {
        return Err(error("configuration", "size limit exceeded"));
    }
    let config: Config = serde_json::from_slice(&raw).map_err(|e| error("configuration", e))?;
    if config.abi != 1 || config.runtimes.is_empty() || config.runtimes.len() > 16 {
        return Err(error(
            "configuration",
            "unsupported ABI or Runtime registry",
        ));
    }
    trusted_file(&config.launcher, true)?;
    Ok(config.launcher)
}

fn exchange(value: Value) -> Result<(Value, Option<OwnedFd>), SandboxError> {
    let raw = serde_json::to_vec(&value).map_err(|e| error("request", e))?;
    if raw.len() > MAX_REPLY {
        return Err(error("request", "size limit exceeded"));
    }
    // All raw descriptors become OwnedFd immediately. SCM_RIGHTS are collected
    // even on malformed replies, so rejected responses cannot leak handles.
    unsafe {
        let raw_socket = libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0);
        if raw_socket < 0 {
            return Err(error("socket", io::Error::last_os_error()));
        }
        let socket = OwnedFd::from_raw_fd(raw_socket);
        let timeout = libc::timeval {
            tv_sec: 5,
            tv_usec: 0,
        };
        for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
            if libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                size_of::<libc::timeval>() as _,
            ) != 0
            {
                return Err(error("timeout", io::Error::last_os_error()));
            }
        }
        let mut address: libc::sockaddr_un = zeroed();
        address.sun_family = libc::AF_UNIX as _;
        let path = CString::new(CONTROL).unwrap();
        std::ptr::copy_nonoverlapping(
            path.as_ptr(),
            address.sun_path.as_mut_ptr(),
            path.as_bytes_with_nul().len(),
        );
        if libc::connect(
            socket.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as _,
        ) != 0
        {
            return Err(error(
                "connection (install/start morphz-sandbox.service)",
                io::Error::last_os_error(),
            ));
        }
        let mut peer: libc::ucred = zeroed();
        let mut length = size_of::<libc::ucred>() as libc::socklen_t;
        if libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(),
            &mut length,
        ) != 0
            || peer.uid != 0
        {
            return Err(error(
                "identity",
                "control endpoint is not owned by the administrator service",
            ));
        }
        if libc::send(
            socket.as_raw_fd(),
            raw.as_ptr().cast(),
            raw.len(),
            libc::MSG_NOSIGNAL,
        ) != raw.len() as isize
        {
            return Err(error("write", io::Error::last_os_error()));
        }
        let mut bytes = vec![0_u8; MAX_REPLY + 1];
        // usize backing provides the alignment required by cmsghdr.
        let mut ancillary = [0_usize; 32];
        let mut vector = libc::iovec {
            iov_base: bytes.as_mut_ptr().cast(),
            iov_len: bytes.len(),
        };
        let mut message: libc::msghdr = zeroed();
        message.msg_iov = &mut vector;
        message.msg_iovlen = 1;
        message.msg_control = ancillary.as_mut_ptr().cast();
        message.msg_controllen = size_of_val(&ancillary);
        let count = libc::recvmsg(socket.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC);
        if count <= 0 {
            return Err(error("reply", io::Error::last_os_error()));
        }
        let mut descriptors = Vec::new();
        let mut invalid = false;
        let mut item = libc::CMSG_FIRSTHDR(&message);
        while !item.is_null() {
            if (*item).cmsg_level == libc::SOL_SOCKET && (*item).cmsg_type == libc::SCM_RIGHTS {
                let base = libc::CMSG_LEN(0) as usize;
                if (*item).cmsg_len < base {
                    invalid = true;
                    break;
                }
                let size = (*item).cmsg_len - base;
                if !size.is_multiple_of(size_of::<libc::c_int>()) {
                    invalid = true;
                }
                for index in 0..size / size_of::<libc::c_int>() {
                    let fd = std::ptr::read_unaligned(
                        libc::CMSG_DATA(item).cast::<libc::c_int>().add(index),
                    );
                    descriptors.push(OwnedFd::from_raw_fd(fd));
                }
            } else {
                invalid = true;
            }
            item = libc::CMSG_NXTHDR(&message, item);
        }
        if invalid
            || descriptors.len() > 1
            || count as usize > MAX_REPLY
            || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
        {
            return Err(error("reply", "unexpected or truncated capabilities"));
        }
        let reply: Value =
            serde_json::from_slice(&bytes[..count as usize]).map_err(|e| error("reply", e))?;
        if reply.get("ok") != Some(&Value::Bool(true)) {
            return Err(error(
                "registration",
                reply
                    .get("detail")
                    .and_then(Value::as_str)
                    .unwrap_or("request rejected"),
            ));
        }
        Ok((reply, descriptors.pop()))
    }
}

pub(super) fn probe() -> Result<(), SandboxError> {
    launcher()?;
    let (reply, descriptor) = exchange(json!({"op":"probe"}))?;
    if descriptor.is_some() || reply.get("abi").and_then(Value::as_u64) != Some(1) {
        return Err(error("probe", "unexpected ABI or capability"));
    }
    Ok(())
}

#[derive(Debug)]
pub(super) struct Receipt {
    descriptor: OwnedFd,
    launch: String,
    confirmed: Mutex<bool>,
}

impl Receipt {
    pub(super) fn wait(&self) -> Result<(), SandboxError> {
        let mut confirmed = self
            .confirmed
            .lock()
            .map_err(|_| error("startup", "receipt state poisoned"))?;
        if *confirmed {
            return Ok(());
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(error("startup", "private admission confirmation timed out"));
            }
            let mut pending = libc::pollfd {
                fd: self.descriptor.as_raw_fd(),
                events: libc::POLLIN | libc::POLLHUP,
                revents: 0,
            };
            let result = unsafe {
                libc::poll(
                    &mut pending,
                    1,
                    remaining.as_millis().min(i32::MAX as u128) as i32,
                )
            };
            if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            if result <= 0 {
                return Err(error(
                    "startup",
                    "private admission confirmation unavailable",
                ));
            }
            let mut bytes = [0_u8; 2];
            let count = unsafe {
                libc::read(
                    self.descriptor.as_raw_fd(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if count != 1 || bytes[0] != 1 {
                return Err(error(
                    "startup",
                    "service refused or exited before verified admission (see launcher stderr)",
                ));
            }
            *confirmed = true;
            return Ok(());
        }
    }
}

impl Drop for Receipt {
    fn drop(&mut self) {
        // Releases admission, never live protection. The service keeps labels
        // until the kernel proves every descendant left the lifetime cgroup.
        let _ = exchange(json!({"op":"release", "launch":self.launch}));
    }
}

pub(super) fn register(
    request: &ShellRequest,
    private_pty: bool,
) -> Result<(PathBuf, String, Receipt), SandboxError> {
    let executable = launcher()?;
    let SandboxPolicy {
        ref denied_read_patterns,
        ref denied_write_patterns,
        ..
    } = request.policy;
    if !denied_read_patterns.is_empty() || !denied_write_patterns.is_empty() {
        return Err(error(
            "policy",
            "symbolic protected-path patterns remain unsupported; use exact paths",
        ));
    }
    let cwd = std::fs::canonicalize(&request.cwd).map_err(|e| error("cwd", e))?;
    let mut reads = super::canonical_roots(&request.policy.read_roots, "read")?;
    let writes = super::canonical_roots(&request.policy.write_roots, "write")?;
    let mut hidden = Vec::new();
    if let Some(home) = std::env::var_os("HOME").and_then(|p| std::fs::canonicalize(p).ok()) {
        for directory in [home.join(".cargo"), home.join(".rustup")] {
            if let Ok(path) = std::fs::canonicalize(directory) {
                super::push_unique(&mut reads, path);
            }
        }
        super::push_unique(&mut hidden, home);
    }
    if let Ok(temp) = std::fs::canonicalize(std::env::temp_dir()) {
        super::push_unique(&mut hidden, temp);
    }
    let paths = |values: Vec<PathBuf>| -> Result<Vec<String>, SandboxError> {
        values
            .into_iter()
            .map(|value| {
                value
                    .into_os_string()
                    .into_string()
                    .map_err(|_| error("policy", "path is not valid UTF-8"))
            })
            .collect()
    };
    let reads = paths(reads)?;
    let writes = paths(writes)?;
    let hidden = paths(hidden)?;
    let denied_reads = paths(super::denied_roots(
        &request.policy.denied_read_paths,
        "read",
    )?)?;
    let denied_writes = paths(super::denied_roots(
        &request.policy.denied_write_paths,
        "write",
    )?)?;
    let cwd = cwd
        .to_str()
        .ok_or_else(|| error("policy", "cwd is not valid UTF-8"))?;
    let (reply, descriptor) = exchange(json!({"op":"register", "policy":{
        "abi":1, "mode":if private_pty {"pty"} else {"exec"}, "cwd":cwd,
        "read_roots":reads, "write_roots":writes, "hidden_roots":hidden,
        "denied_read_paths":denied_reads,
        "denied_write_paths":denied_writes,
        "denied_read_patterns":[], "denied_write_patterns":[], "network":request.policy.network
    }}))?;
    let launch = reply
        .get("launch")
        .and_then(Value::as_str)
        .filter(|v| {
            v.len() == 32
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| error("registration", "invalid launch identity"))?
        .to_owned();
    let descriptor =
        descriptor.ok_or_else(|| error("registration", "private receipt is missing"))?;
    unsafe {
        let mut info: libc::stat = zeroed();
        if libc::fstat(descriptor.as_raw_fd(), &mut info) != 0
            || info.st_uid != 0
            || info.st_mode & libc::S_IFMT != libc::S_IFIFO
            || libc::fcntl(descriptor.as_raw_fd(), libc::F_GETFL) & libc::O_ACCMODE
                != libc::O_RDONLY
        {
            return Err(error("receipt", "not a root-owned read-only pipe"));
        }
    }
    Ok((
        executable,
        launch.clone(),
        Receipt {
            descriptor,
            launch,
            confirmed: Mutex::new(false),
        },
    ))
}
