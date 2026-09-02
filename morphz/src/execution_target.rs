//! Stable execution destinations and backend-neutral target selection.
//!
//! An [`ExecutionTargetRecord`] is a logical security/execution boundary. It
//! is deliberately distinct from a live Node connection and from the Worker
//! process which claims one Execution Job.

use std::collections::HashMap;
use std::error::Error;
#[cfg(windows)]
use std::io::Read as _;
use std::io::Write as _;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt as _;
use std::path::PathBuf;
use std::path::{Component, Path};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

#[cfg(windows)]
use base64::Engine as _;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

use crate::approval::{ApprovalAction, CapabilityDelta};
use crate::config::ManagedSshTargetConfig;
use crate::llm::ToolDefinition;
use crate::memory::{
    EdgeCommandStatus, EdgeExecutionStore, ExecutionJobMutation, ExecutionJobRecord,
    ExecutionJobStatus, ExecutionJobStore, ExecutionJobTerminal, ExecutionRetrySafety,
    ExecutionTargetAuthorizationStore, ExecutionTargetFilter, ExecutionTargetKind,
    ExecutionTargetRecord, ExecutionTargetRegistration, ExecutionTargetStatus,
    ExecutionTargetStore, NewEdgeCommand, NewExecutionJob,
};
use crate::tool::{
    Tool, ToolExecutionClass, ToolExecutionResult, ToolExecutionRouting, CURRENT_PRINCIPAL_ID,
};

pub type TargetExecutionError = Box<dyn Error + Send + Sync>;

/// Machine-readable boundary used when a deployment intentionally has no
/// local executor. Public API adapters can turn this into Morphz Edge
/// onboarding instead of presenting a generic tool failure.
#[derive(Debug)]
pub struct ExecutionTargetRequired;

impl std::fmt::Display for ExecutionTargetRequired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "No usable default Execution Target is connected; connect morphz-edge and select that device before running physical tools",
        )
    }
}

impl Error for ExecutionTargetRequired {}

/// Single-machine compatibility target. Local callers may omit `target`; the
/// Runtime resolves that omission to this explicit authority before it creates
/// an Execution Job.
pub const DEFAULT_EXECUTION_TARGET_ID: &str = "target-default";
pub const EXECUTION_ROUTE_REQUEST_KEY: &str = "_morphz_execution_route";
pub const ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY: &str =
    crate::artifact::ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY;
pub const EDGE_EXECUTION_SCOPE_KEY: &str = "execution_scope";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManagedSshAuthMode {
    #[default]
    KeyOnly,
    PasswordOnly,
    KeyThenPassword,
}

impl ManagedSshAuthMode {
    fn uses_keys(self) -> bool {
        matches!(self, Self::KeyOnly | Self::KeyThenPassword)
    }

    fn uses_password(self) -> bool {
        matches!(self, Self::PasswordOnly | Self::KeyThenPassword)
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::KeyOnly => "key_only",
            Self::PasswordOnly => "password_only",
            Self::KeyThenPassword => "key_then_password",
        }
    }
}

/// Host-owned connection descriptor for a Managed SSH Target. Credential
/// values stay in the Runtime Secret Store; this descriptor carries aliases
/// only. When no private-key alias is bound, OpenSSH may still use its normal
/// host configuration and ssh-agent as a compatibility source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedSshEndpoint {
    /// When present, Runtime delegates connection resolution to the host
    /// user's existing OpenSSH configuration. The resolved host/user below
    /// are retained only for validation and policy hashing.
    #[serde(skip)]
    pub destination: Option<String>,
    pub host: String,
    pub user: Option<String>,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub known_hosts_file: PathBuf,
    /// Static endpoint admission flag. Dynamic hosts are admitted by the
    /// Runtime; connection authorization follows the active Permission Profile
    /// and the Thread + Target Capability Lease policy.
    #[serde(default)]
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_digest: Option<String>,
    #[serde(default)]
    pub auth_mode: ManagedSshAuthMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_passphrase_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_secret: Option<String>,
}

const RUNTIME_MANAGED_SSH_PROTOCOL_VERSION: u64 = 4;

fn runtime_managed_ssh_host_id() -> &'static str {
    static HOST_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HOST_ID.get_or_init(|| {
        let explicit = std::env::var("MORPHZ_RUNTIME_HOST_ID")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let hostname = std::process::Command::new("hostname")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown-host".to_string());
        let user = std::env::var("USER")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "unknown-user".to_string());
        let morphz_home = crate::config::morphz_home_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown-home".to_string());
        let material = explicit.unwrap_or_else(|| format!("{hostname}\0{user}\0{morphz_home}"));
        let digest = format!("{:x}", Sha256::digest(material.as_bytes()));
        format!("runtime-host-{}", &digest[..24])
    })
}

fn managed_ssh_uses_host_openssh(endpoint: &ManagedSshEndpoint) -> bool {
    endpoint.auth_mode == ManagedSshAuthMode::KeyOnly
        && endpoint.private_key_secret.is_none()
        && endpoint.private_key_passphrase_secret.is_none()
        && endpoint.password_secret.is_none()
}

fn managed_ssh_target_uses_host_openssh(target: &ExecutionTargetRecord) -> bool {
    target.kind == ExecutionTargetKind::ManagedSsh
        && target.provider_node_id.is_none()
        && target
            .metadata
            .get("execution_location")
            .and_then(serde_json::Value::as_str)
            == Some("runtime")
        && target
            .metadata
            .get("auth_mode")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|mode| mode == ManagedSshAuthMode::KeyOnly.as_str())
        && target
            .metadata
            .get("private_key_secret")
            .and_then(serde_json::Value::as_str)
            .is_none()
        && target
            .metadata
            .get("password_secret")
            .and_then(serde_json::Value::as_str)
            .is_none()
}

fn managed_ssh_target_runtime_host_id(target: &ExecutionTargetRecord) -> Option<&str> {
    target
        .metadata
        .get("runtime_host_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
}

fn default_ssh_port() -> u16 {
    22
}

impl ManagedSshEndpoint {
    pub fn load(endpoint_ref: &str) -> Result<Self, TargetExecutionError> {
        validate_endpoint_ref(endpoint_ref)?;
        let home = crate::config::morphz_home_dir()
            .ok_or("Cannot resolve Managed SSH endpoint because the Morphz user configuration directory is unavailable")?;
        let path = home
            .join("edge")
            .join("ssh")
            .join(format!("{endpoint_ref}.json"));
        let endpoint: Self = serde_json::from_slice(&std::fs::read(&path).map_err(|error| {
            format!(
                "Managed SSH endpoint '{}' is not configured ({}): {error}",
                endpoint_ref,
                path.display()
            )
        })?)?;
        endpoint.validate()?;
        Ok(endpoint)
    }

    pub fn validate(&self) -> Result<(), TargetExecutionError> {
        if let Some(host) = self.destination.as_deref() {
            validate_ssh_host(host)?;
        }
        if self.host.trim().is_empty()
            || self.host.starts_with('-')
            || self.host.chars().any(char::is_whitespace)
        {
            return Err(
                "Managed SSH host must not be empty, start with '-', or contain whitespace".into(),
            );
        }
        if self.user.as_deref().is_some_and(|user| {
            user.is_empty() || user.starts_with('-') || user.chars().any(char::is_whitespace)
        }) {
            return Err(
                "Managed SSH user must not be empty, start with '-', or contain whitespace".into(),
            );
        }
        if self.port == 0 {
            return Err("Managed SSH port must be greater than 0".into());
        }
        match (
            self.auth_mode.uses_password(),
            self.password_secret.as_deref(),
        ) {
            (true, Some(alias)) => validate_managed_ssh_secret_alias("password_secret", alias)?,
            (true, None) => {
                return Err(format!(
                    "Managed SSH auth_mode={} requires password_secret",
                    self.auth_mode.as_str()
                )
                .into())
            }
            (false, Some(_)) => {
                return Err("Managed SSH key_only cannot bind password_secret".into())
            }
            (false, None) => {}
        }
        if self.auth_mode.uses_keys() {
            if let Some(alias) = self.private_key_secret.as_deref() {
                validate_managed_ssh_secret_alias("private_key_secret", alias)?;
            }
            if let Some(alias) = self.private_key_passphrase_secret.as_deref() {
                validate_managed_ssh_secret_alias("private_key_passphrase_secret", alias)?;
                if self.private_key_secret.is_none() {
                    return Err(
                        "Managed SSH private_key_passphrase_secret requires private_key_secret"
                            .into(),
                    );
                }
            }
        } else if self.private_key_secret.is_some() || self.private_key_passphrase_secret.is_some()
        {
            return Err(
                "Managed SSH password_only must not bind private_key_secret or private_key_passphrase_secret"
                    .into(),
            );
        }
        if self.destination.is_none()
            && (!self.known_hosts_file.is_absolute() || !self.known_hosts_file.is_file())
        {
            return Err(format!(
                "Managed SSH known_hosts_file must be an existing absolute file: {}",
                self.known_hosts_file.display()
            )
            .into());
        }
        Ok(())
    }
}

fn validate_managed_ssh_secret_alias(field: &str, alias: &str) -> Result<(), TargetExecutionError> {
    if alias == "SSH_AUTH_SOCK" {
        return Err(
            format!("Managed SSH {field} cannot use the reserved SSH_AUTH_SOCK alias").into(),
        );
    }
    if alias.is_empty()
        || alias.len() > 128
        || !alias.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
        || !alias
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(format!("Managed SSH {field} must be a valid Secret Store alias").into());
    }
    Ok(())
}

fn managed_ssh_endpoint_secret_aliases(endpoint: &ManagedSshEndpoint) -> Vec<String> {
    let mut aliases = Vec::new();
    if endpoint.auth_mode.uses_keys()
        && endpoint.private_key_secret.is_none()
        && std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty())
    {
        aliases.push("SSH_AUTH_SOCK".to_string());
    }
    if let Some(alias) = endpoint.private_key_secret.as_ref() {
        aliases.push(alias.clone());
    }
    if let Some(alias) = endpoint.private_key_passphrase_secret.as_ref() {
        aliases.push(alias.clone());
    }
    if let Some(alias) = endpoint.password_secret.as_ref() {
        aliases.push(alias.clone());
    }
    aliases
}

fn validate_ssh_host(host: &str) -> Result<(), TargetExecutionError> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(
            "Managed SSH host may contain only letters, digits, dots, hyphens, and underscores, and must not start with '-'".into(),
        );
    }
    Ok(())
}

fn validate_ssh_user(user: &str) -> Result<(), TargetExecutionError> {
    if user.is_empty() || user.starts_with('-') || user.chars().any(char::is_whitespace) {
        return Err(
            "Managed SSH user must not be empty, start with '-', or contain whitespace".into(),
        );
    }
    Ok(())
}

async fn resolve_runtime_ssh_host(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
) -> Result<ManagedSshEndpoint, TargetExecutionError> {
    validate_ssh_host(host)?;
    if let Some(user) = user {
        validate_ssh_user(user)?;
    }
    if port == Some(0) {
        return Err("Managed SSH port must be greater than 0".into());
    }
    let mut command = tokio::process::Command::new("ssh");
    command.arg("-G");
    if let Some(user) = user {
        command.arg("-l").arg(user);
    }
    if let Some(port) = port {
        command.arg("-p").arg(port.to_string());
    }
    command
        .arg("--")
        .arg(host)
        .stdin(std::process::Stdio::null());
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
        .await
        .map_err(|_| format!("Timed out while resolving SSH host '{host}'"))??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Runtime failed to resolve SSH host '{}': {}",
            host,
            stderr.trim()
        )
        .into());
    }
    if output.stdout.len() > 1024 * 1024 {
        return Err(
            format!("Expanded configuration for SSH host '{host}' is unexpectedly large").into(),
        );
    }
    let expanded = String::from_utf8(output.stdout)?;
    managed_ssh_endpoint_from_expanded(host, &expanded)
}

fn managed_ssh_endpoint_from_expanded(
    ssh_host: &str,
    expanded: &str,
) -> Result<ManagedSshEndpoint, TargetExecutionError> {
    validate_ssh_host(ssh_host)?;
    let field = |name: &str| {
        expanded.lines().find_map(|line| {
            line.split_once(' ')
                .filter(|(key, value)| *key == name && !value.trim().is_empty())
                .map(|(_, value)| value.trim().to_string())
        })
    };
    let host =
        field("hostname").ok_or_else(|| format!("SSH host '{ssh_host}' is missing hostname"))?;
    let user = field("user");
    let port = field("port")
        .as_deref()
        .unwrap_or("22")
        .parse::<u16>()
        .map_err(|_| format!("SSH host '{ssh_host}' has an invalid port"))?;
    let endpoint = ManagedSshEndpoint {
        destination: Some(ssh_host.to_string()),
        host,
        user,
        port,
        known_hosts_file: PathBuf::new(),
        approved: true,
        config_digest: Some(format!("sha256:{:x}", Sha256::digest(expanded.as_bytes()))),
        auth_mode: ManagedSshAuthMode::KeyOnly,
        private_key_secret: None,
        private_key_passphrase_secret: None,
        password_secret: None,
    };
    endpoint.validate()?;
    Ok(endpoint)
}

fn validate_endpoint_ref(endpoint_ref: &str) -> Result<(), TargetExecutionError> {
    if endpoint_ref.is_empty()
        || !endpoint_ref
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Managed SSH endpoint_ref may contain only letters, digits, dots, hyphens, and underscores".into());
    }
    Ok(())
}

#[derive(Clone, Default)]
struct ManagedSshAuthentication {
    private_key: Option<Arc<Zeroizing<String>>>,
    private_key_passphrase: Option<Arc<Zeroizing<String>>>,
    password: Option<Arc<Zeroizing<String>>>,
}

struct ManagedSshAskpass {
    _directory: tempfile::TempDir,
    _pipes: Vec<ManagedSshSecretPipe>,
    helper_path: PathBuf,
    password_pipe_path: Option<PathBuf>,
    key_passphrase_pipe_path: Option<PathBuf>,
}

impl ManagedSshAskpass {
    fn new(
        password: Option<&str>,
        key_passphrase: Option<&str>,
    ) -> Result<Self, TargetExecutionError> {
        validate_managed_ssh_prompt_secret("password", password)?;
        validate_managed_ssh_prompt_secret("private key passphrase", key_passphrase)?;
        if password.is_none() && key_passphrase.is_none() {
            return Err("Managed SSH askpass requires at least one prompted credential".into());
        }
        let directory = tempfile::Builder::new()
            .prefix("morphz-ssh-askpass-")
            .tempdir()?;
        #[cfg(unix)]
        let helper_path = {
            use std::os::unix::fs::PermissionsExt;
            let helper_path = directory.path().join("askpass");
            std::fs::write(
                &helper_path,
                b"#!/bin/sh\nset -eu\ncase \"${1-}\" in\n  *assphrase*|*ASSPHRASE*) fifo=${MORPHZ_SSH_KEY_PASSPHRASE_FIFO-} ;;\n  *assword*|*ASSWORD*) fifo=${MORPHZ_SSH_PASSWORD_FIFO-} ;;\n  *) exit 1 ;;\nesac\n[ -n \"$fifo\" ] || exit 1\nIFS= read -r secret < \"$fifo\"\nprintf '%s\\n' \"$secret\"\n",
            )?;
            std::fs::set_permissions(&helper_path, std::fs::Permissions::from_mode(0o700))?;
            helper_path
        };
        #[cfg(windows)]
        let helper_path = std::env::current_exe().map_err(|error| {
            format!("failed to locate Morphz for the Windows SSH askpass helper: {error}")
        })?;
        let mut pipes = Vec::new();
        let password_pipe_path = password
            .map(|secret| create_managed_ssh_secret_pipe(directory.path(), "password.pipe", secret))
            .transpose()?
            .map(|(path, pipe)| {
                pipes.push(pipe);
                path
            });
        let key_passphrase_pipe_path = key_passphrase
            .map(|secret| {
                create_managed_ssh_secret_pipe(directory.path(), "key-passphrase.pipe", secret)
            })
            .transpose()?
            .map(|(path, pipe)| {
                pipes.push(pipe);
                path
            });
        Ok(Self {
            _directory: directory,
            _pipes: pipes,
            helper_path,
            password_pipe_path,
            key_passphrase_pipe_path,
        })
    }

    fn apply_to_command(&self, command: &mut tokio::process::Command) {
        command
            .env("SSH_ASKPASS", &self.helper_path)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", "morphz-managed-ssh");
        #[cfg(windows)]
        command.env("MORPHZ_INTERNAL_SSH_ASKPASS", "1");
        if let Some(path) = self.password_pipe_path.as_ref() {
            command.env("MORPHZ_SSH_PASSWORD_FIFO", path);
        }
        if let Some(path) = self.key_passphrase_pipe_path.as_ref() {
            command.env("MORPHZ_SSH_KEY_PASSPHRASE_FIFO", path);
        }
    }

    #[cfg(unix)]
    fn command_prefix(&self) -> Vec<String> {
        let mut prefix = vec![
            "env".to_string(),
            format!("SSH_ASKPASS={}", self.helper_path.display()),
            "SSH_ASKPASS_REQUIRE=force".to_string(),
            "DISPLAY=morphz-managed-ssh".to_string(),
        ];
        if let Some(path) = self.password_pipe_path.as_ref() {
            prefix.push(format!("MORPHZ_SSH_PASSWORD_FIFO={}", path.display()));
        }
        if let Some(path) = self.key_passphrase_pipe_path.as_ref() {
            prefix.push(format!("MORPHZ_SSH_KEY_PASSPHRASE_FIFO={}", path.display()));
        }
        prefix
    }
}

#[cfg(unix)]
type ManagedSshSecretPipe = std::fs::File;

#[cfg(windows)]
struct ManagedSshSecretPipe {
    path: PathBuf,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(windows)]
impl Drop for ManagedSshSecretPipe {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Connect once to release a server blocked in ConnectNamedPipe. The
        // server observes `stop` before writing any credential bytes.
        for _ in 0..100 {
            if self
                .thread
                .as_ref()
                .is_none_or(|thread| thread.is_finished())
            {
                break;
            }
            if std::fs::OpenOptions::new()
                .read(true)
                .open(&self.path)
                .is_ok()
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn validate_managed_ssh_prompt_secret(
    label: &str,
    secret: Option<&str>,
) -> Result<(), TargetExecutionError> {
    let Some(secret) = secret else {
        return Ok(());
    };
    if secret.is_empty() {
        return Err(format!("Managed SSH {label} Secret must not be empty").into());
    }
    if secret.contains(['\0', '\r', '\n']) {
        return Err(format!(
            "Managed SSH {label} Secret must not contain NUL or newline characters"
        )
        .into());
    }
    Ok(())
}

#[cfg(unix)]
fn create_managed_ssh_secret_pipe(
    directory: &Path,
    name: &str,
    secret: &str,
) -> Result<(PathBuf, ManagedSshSecretPipe), TargetExecutionError> {
    let path = directory.join(name);
    nix::unistd::mkfifo(
        &path,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )?;
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)?;
    // OpenSSH may invoke askpass again after a rejected identity. Keep a few
    // one-shot values buffered without ever placing the secret in argv/env.
    for _ in 0..4 {
        pipe.write_all(secret.as_bytes())?;
        pipe.write_all(b"\n")?;
    }
    pipe.flush()?;
    Ok((path, pipe))
}

#[cfg(windows)]
fn create_managed_ssh_secret_pipe(
    _directory: &Path,
    name: &str,
    secret: &str,
) -> Result<(PathBuf, ManagedSshSecretPipe), TargetExecutionError> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FlushFileBuffers, WriteFile, PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = PathBuf::from(format!(
        r"\\.\pipe\morphz-ssh-askpass-{}-{name}-{suffix}",
        std::process::id()
    ));
    let pipe_name = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let secret = Zeroizing::new(format!("{secret}\n").into_bytes());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name(format!("morphz-ssh-askpass-{name}"))
        .spawn(move || {
            let mut ready_tx = Some(ready_tx);
            for _ in 0..4 {
                let handle = unsafe {
                    CreateNamedPipeW(
                        pipe_name.as_ptr(),
                        PIPE_ACCESS_OUTBOUND,
                        PIPE_TYPE_BYTE
                            | PIPE_READMODE_BYTE
                            | PIPE_WAIT
                            | PIPE_REJECT_REMOTE_CLIENTS,
                        1,
                        u32::try_from(secret.len()).unwrap_or(u32::MAX),
                        0,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if handle == INVALID_HANDLE_VALUE {
                    if let Some(sender) = ready_tx.take() {
                        let _ = sender.send(Err(format!(
                            "CreateNamedPipeW failed with OS error {}",
                            unsafe { GetLastError() }
                        )));
                    }
                    return;
                }
                if let Some(sender) = ready_tx.take() {
                    let _ = sender.send(Ok(()));
                }
                let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
                    || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if connected && !stop_for_thread.load(Ordering::Acquire) {
                    let mut written = 0_u32;
                    unsafe {
                        WriteFile(
                            handle,
                            secret.as_ptr().cast(),
                            u32::try_from(secret.len()).unwrap_or(u32::MAX),
                            &mut written,
                            std::ptr::null_mut(),
                        );
                        FlushFileBuffers(handle);
                    }
                }
                unsafe {
                    DisconnectNamedPipe(handle);
                    CloseHandle(handle);
                }
                if stop_for_thread.load(Ordering::Acquire) {
                    break;
                }
            }
        })?;
    ready_rx
        .recv()
        .map_err(|_| "Windows SSH askpass pipe server exited before startup")??;
    Ok((
        path.clone(),
        ManagedSshSecretPipe {
            path,
            stop,
            thread: Some(thread),
        },
    ))
}

/// Internal Windows OpenSSH askpass entry point. It is called before normal
/// CLI parsing, reads exactly one credential from a local named pipe, and
/// never accepts a value through argv or the environment.
#[cfg(windows)]
pub fn run_windows_ssh_askpass_if_requested() -> Result<bool, TargetExecutionError> {
    if std::env::var_os("MORPHZ_INTERNAL_SSH_ASKPASS").as_deref() != Some(std::ffi::OsStr::new("1"))
    {
        return Ok(false);
    }
    let prompt = std::env::args_os()
        .nth(1)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let password_pipe = std::env::var_os("MORPHZ_SSH_PASSWORD_FIFO").map(PathBuf::from);
    let key_passphrase_pipe = std::env::var_os("MORPHZ_SSH_KEY_PASSPHRASE_FIFO").map(PathBuf::from);
    let value = read_windows_ssh_askpass_value(
        &prompt,
        password_pipe.as_deref(),
        key_passphrase_pipe.as_deref(),
    )?;
    println!("{}", value.as_str());
    Ok(true)
}

#[cfg(windows)]
fn read_windows_ssh_askpass_value(
    prompt: &str,
    password_pipe: Option<&Path>,
    key_passphrase_pipe: Option<&Path>,
) -> Result<Zeroizing<String>, TargetExecutionError> {
    let prompt = prompt.to_ascii_lowercase();
    let (pipe, label) = if prompt.contains("passphrase") {
        (key_passphrase_pipe, "MORPHZ_SSH_KEY_PASSPHRASE_FIFO")
    } else if prompt.contains("password") {
        (password_pipe, "MORPHZ_SSH_PASSWORD_FIFO")
    } else {
        return Err("Windows SSH askpass received an unsupported prompt".into());
    };
    let pipe = pipe.ok_or_else(|| format!("Windows SSH askpass is missing {label}"))?;
    let mut pipe = std::fs::OpenOptions::new().read(true).open(pipe)?;
    let mut bytes = Zeroizing::new(Vec::new());
    let mut buffer = [0_u8; 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => bytes.extend_from_slice(&buffer[..read]),
            // Windows byte-mode named pipes report their normal disconnected
            // end as either BROKEN_PIPE (109) or NO_DATA (232/233), rather
            // than a Unix-style zero-byte EOF.
            Err(error) if matches!(error.raw_os_error(), Some(109 | 232 | 233)) => break,
            Err(error) => return Err(error.into()),
        }
    }
    let mut value = Zeroizing::new(String::from_utf8(bytes.to_vec())?);
    while value.ends_with('\r') || value.ends_with('\n') {
        value.pop();
    }
    if value.is_empty() {
        return Err("Windows SSH askpass received an empty credential".into());
    }
    Ok(value)
}

#[cfg(not(windows))]
pub fn run_windows_ssh_askpass_if_requested() -> Result<bool, TargetExecutionError> {
    Ok(false)
}

struct ManagedSshIdentityFile {
    _directory: tempfile::TempDir,
    path: PathBuf,
}

impl ManagedSshIdentityFile {
    fn new(private_key: &str) -> Result<Self, TargetExecutionError> {
        if private_key.trim().is_empty() {
            return Err("Managed SSH private-key Secret must not be empty".into());
        }
        if private_key.contains('\0') {
            return Err("Managed SSH private-key Secret must not contain NUL".into());
        }
        let directory = tempfile::Builder::new()
            .prefix("morphz-ssh-identity-")
            .tempdir()?;
        #[cfg(windows)]
        protect_windows_managed_ssh_path(directory.path(), true)?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))?;
            let path = directory.path().join("identity");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?;
            file.write_all(private_key.as_bytes())?;
            if !private_key.ends_with('\n') {
                file.write_all(b"\n")?;
            }
            file.flush()?;
            file.sync_all()?;
            Self {
                _directory: directory,
                path,
            }
        };
        #[cfg(windows)]
        let identity = {
            let path = directory.path().join("identity");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            file.write_all(private_key.as_bytes())?;
            if !private_key.ends_with('\n') {
                file.write_all(b"\n")?;
            }
            file.flush()?;
            file.sync_all()?;
            protect_windows_managed_ssh_path(&path, false)?;
            Self {
                _directory: directory,
                path,
            }
        };
        Ok(identity)
    }
}

/// Replace inherited Windows ACLs with a protected DACL that grants access
/// only to the Runtime user. The directory is protected before the private
/// key is created, so the key is never exposed through the host Temp ACL.
#[cfg(windows)]
fn protect_windows_managed_ssh_path(
    path: &Path,
    inherit_to_children: bool,
) -> Result<(), TargetExecutionError> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, GENERIC_ALL,
    };
    use windows_sys::Win32::Security::Authorization::{
        SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE,
        SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct TokenHandle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for TokenHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let mut token = 0;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let token = TokenHandle(token);

    let mut required = 0_u32;
    let first =
        unsafe { GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut required) };
    if first != 0 || required == 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(std::io::Error::last_os_error().into());
    }
    let words = usize::try_from(required)
        .unwrap_or(usize::MAX)
        .div_ceil(std::mem::size_of::<usize>());
    let mut token_user = vec![0_usize; words];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            token_user.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let user_sid = unsafe { (*(token_user.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if user_sid.is_null() {
        return Err("Windows access token did not contain a user SID".into());
    }

    let access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: GENERIC_ALL,
        grfAccessMode: SET_ACCESS,
        grfInheritance: if inherit_to_children {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            0
        },
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: user_sid.cast(),
        },
    };
    let mut acl = std::ptr::null_mut();
    let status = unsafe { SetEntriesInAclW(1, &access, std::ptr::null(), &mut acl) };
    if status != 0 {
        return Err(format!("SetEntriesInAclW failed with Windows error {status}").into());
    }
    struct LocalAcl(*mut windows_sys::Win32::Security::ACL);
    impl Drop for LocalAcl {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0.cast());
            }
        }
    }
    let acl = LocalAcl(acl);
    let mut wide_path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl.0,
            std::ptr::null(),
        )
    };
    if status != 0 {
        return Err(format!("SetNamedSecurityInfoW failed with Windows error {status}").into());
    }
    Ok(())
}

#[derive(Default)]
struct ManagedSshCredentialMaterial {
    askpass: Option<ManagedSshAskpass>,
    identity: Option<ManagedSshIdentityFile>,
    scrubbed_environment: Vec<String>,
}

impl ManagedSshCredentialMaterial {
    fn new(
        endpoint: &ManagedSshEndpoint,
        authentication: &ManagedSshAuthentication,
    ) -> Result<Self, TargetExecutionError> {
        let private_key = match endpoint.private_key_secret.as_deref() {
            Some(alias) => Some(authentication.private_key.as_deref().ok_or_else(|| {
                format!("Managed SSH private-key Secret '{alias}' was not resolved")
            })?),
            None => None,
        };
        let key_passphrase = match endpoint.private_key_passphrase_secret.as_deref() {
            Some(alias) => Some(
                authentication
                    .private_key_passphrase
                    .as_deref()
                    .ok_or_else(|| {
                        format!(
                            "Managed SSH private-key passphrase Secret '{alias}' was not resolved"
                        )
                    })?,
            ),
            None => None,
        };
        let password = match endpoint.password_secret.as_deref() {
            Some(alias) => Some(authentication.password.as_deref().ok_or_else(|| {
                format!("Managed SSH password Secret '{alias}' was not resolved")
            })?),
            None => None,
        };
        let askpass = if password.is_some() || key_passphrase.is_some() {
            Some(ManagedSshAskpass::new(
                password.map(|value| value.as_str()),
                key_passphrase.map(|value| value.as_str()),
            )?)
        } else {
            None
        };
        let identity = private_key
            .map(|value| ManagedSshIdentityFile::new(value.as_str()))
            .transpose()?;
        let mut scrubbed_environment = [
            endpoint.private_key_secret.as_ref(),
            endpoint.private_key_passphrase_secret.as_ref(),
            endpoint.password_secret.as_ref(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
        if endpoint.private_key_secret.is_some() {
            scrubbed_environment.push("SSH_AUTH_SOCK".to_string());
        }
        scrubbed_environment.sort();
        scrubbed_environment.dedup();
        Ok(Self {
            askpass,
            identity,
            scrubbed_environment,
        })
    }

    fn apply_to_command(&self, command: &mut tokio::process::Command) {
        for name in &self.scrubbed_environment {
            command.env_remove(name);
        }
        if let Some(askpass) = self.askpass.as_ref() {
            askpass.apply_to_command(command);
        }
    }

    #[cfg(unix)]
    fn command_prefix(&self) -> Vec<String> {
        let mut prefix = self
            .askpass
            .as_ref()
            .map(ManagedSshAskpass::command_prefix)
            .unwrap_or_else(|| {
                if self.scrubbed_environment.is_empty() {
                    Vec::new()
                } else {
                    vec!["env".to_string()]
                }
            });
        if !prefix.is_empty() {
            let removals = self
                .scrubbed_environment
                .iter()
                .flat_map(|name| ["-u".to_string(), name.clone()])
                .collect::<Vec<_>>();
            prefix.splice(1..1, removals);
        }
        prefix
    }

    #[cfg(unix)]
    fn render_shell_command(&self, ssh: Vec<String>) -> Result<String, TargetExecutionError> {
        let mut command = self.command_prefix();
        command.extend(ssh);
        Ok(command
            .iter()
            .map(|part| shell_quote(part))
            .collect::<Vec<_>>()
            .join(" "))
    }

    #[cfg(windows)]
    fn render_shell_command(&self, mut ssh: Vec<String>) -> Result<String, TargetExecutionError> {
        if ssh.first().map(String::as_str) != Some("ssh") {
            return Err("Managed SSH shell command is missing the ssh executable".into());
        }
        ssh.remove(0);
        let decode =
            |value: &str| base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        let mut script = "function D([string]$v) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }; $ErrorActionPreference='Stop'; ".to_string();
        for name in &self.scrubbed_environment {
            script.push_str(&format!(
                "Remove-Item -LiteralPath ('Env:' + (D '{}')) -ErrorAction SilentlyContinue; ",
                decode(name)
            ));
        }
        if let Some(askpass) = self.askpass.as_ref() {
            let mut environment = vec![
                ("SSH_ASKPASS", askpass.helper_path.display().to_string()),
                ("SSH_ASKPASS_REQUIRE", "force".to_string()),
                ("DISPLAY", "morphz-managed-ssh".to_string()),
                ("MORPHZ_INTERNAL_SSH_ASKPASS", "1".to_string()),
            ];
            if let Some(path) = askpass.password_pipe_path.as_ref() {
                environment.push(("MORPHZ_SSH_PASSWORD_FIFO", path.display().to_string()));
            }
            if let Some(path) = askpass.key_passphrase_pipe_path.as_ref() {
                environment.push(("MORPHZ_SSH_KEY_PASSPHRASE_FIFO", path.display().to_string()));
            }
            for (name, value) in environment {
                script.push_str(&format!(
                    "Set-Item -LiteralPath ('Env:' + (D '{}')) -Value (D '{}'); ",
                    decode(name),
                    decode(&value)
                ));
            }
        }
        let arguments = serde_json::to_string(&ssh)?;
        script.push_str(&format!(
            "$a = @(ConvertFrom-Json -InputObject (D '{}')); & (D '{}') @a; exit $LASTEXITCODE",
            decode(&arguments),
            decode("ssh.exe")
        ));
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Ok(format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}"
        ))
    }

    fn append_identity_arguments(&self, arguments: &mut Vec<String>) {
        if let Some(identity) = self.identity.as_ref() {
            arguments.extend([
                "-o".to_string(),
                "IdentityFile=none".to_string(),
                "-o".to_string(),
                "IdentitiesOnly=yes".to_string(),
                "-i".to_string(),
                identity.path.display().to_string(),
            ]);
        }
    }

    fn append_identity_to_command(&self, command: &mut tokio::process::Command) {
        if let Some(identity) = self.identity.as_ref() {
            command
                .arg("-o")
                .arg("IdentityFile=none")
                .arg("-o")
                .arg("IdentitiesOnly=yes")
                .arg("-i")
                .arg(&identity.path);
        }
    }
}

fn managed_ssh_credentials(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
) -> Result<ManagedSshCredentialMaterial, TargetExecutionError> {
    ManagedSshCredentialMaterial::new(endpoint, authentication)
}

/// Cloud authority copied from the immutable parent Job into the Edge
/// command. It lets the Provider Node scope its own local Capability Lease to
/// the same logical work without trusting model-authored arguments.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeExecutionScope {
    pub principal_id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub thread_id: String,
}

/// Immutable one-hop Route selected before an Execution Job becomes
/// claimable. A later Target heartbeat may update the registry, but it cannot
/// silently move an already-created physical action to another provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionRouteSnapshot {
    pub route_id: String,
    pub target_id: String,
    pub target_revision: u64,
    pub provider_node_id: Option<String>,
    pub backend_kind: ExecutionTargetKind,
    pub endpoint_ref: Option<String>,
    pub policy_digest: String,
}

/// Immutable dual-endpoint route carried by one Artifact Transfer
/// ExecutionJob. `ExecutionJob.target_id` remains the coordinator (currently
/// the destination); these two snapshots are the authoritative data route.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactTransferRouteSnapshot {
    pub source: ExecutionRouteSnapshot,
    pub destination: ExecutionRouteSnapshot,
}

pub const EDGE_ARTIFACT_DATA_CHANNEL_KEY: &str = "_morphz_edge_artifact_channel";

/// Private instruction between Runtime and an authenticated Edge Worker.  It
/// is never accepted from the model-facing transfer arguments and never
/// contains a credential or an arbitrary server-side path.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeArtifactDataDirection {
    RuntimeToEdge,
    EdgeToRuntime,
}

/// Representation carried by the private Runtime↔Edge byte channel. This is
/// deliberately distinct from the logical Artifact media type/digest in the
/// final Receipt: a directory travels as a canonical archive, while its
/// logical identity is still computed from the materialized tree.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeArtifactPayloadKind {
    #[default]
    File,
    DirectoryArchive,
    /// Edge→Runtime cannot know the source kind until the target-local
    /// permission check and Tool execution have inspected it.
    Detect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeArtifactDataChannel {
    pub direction: EdgeArtifactDataDirection,
    #[serde(default)]
    pub payload_kind: EdgeArtifactPayloadKind,
    /// Digest of the exact bytes carried by this channel. For a directory
    /// this is the canonical archive digest, not the logical directory digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

pub fn attach_edge_artifact_data_channel(
    route: &mut serde_json::Value,
    channel: &EdgeArtifactDataChannel,
) -> Result<(), TargetExecutionError> {
    route
        .as_object_mut()
        .ok_or("Edge Artifact Route must be encoded as a JSON object")?
        .insert(
            EDGE_ARTIFACT_DATA_CHANNEL_KEY.to_string(),
            serde_json::to_value(channel)?,
        );
    Ok(())
}

pub fn edge_artifact_data_channel_from_route(
    route: &serde_json::Value,
) -> Result<Option<EdgeArtifactDataChannel>, TargetExecutionError> {
    route
        .get(EDGE_ARTIFACT_DATA_CHANNEL_KEY)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}

impl ExecutionRouteSnapshot {
    pub fn freeze(target: &ExecutionTargetRecord) -> Self {
        Self {
            route_id: format!("route:{}:r{}", target.id, target.revision),
            target_id: target.id.clone(),
            target_revision: target.revision,
            provider_node_id: target.provider_node_id.clone(),
            backend_kind: target.kind,
            endpoint_ref: target
                .metadata
                .get("endpoint_ref")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            policy_digest: target.policy_digest.clone(),
        }
    }
}

pub fn attach_route_snapshot(
    request: &mut serde_json::Value,
    route: &ExecutionRouteSnapshot,
) -> Result<(), TargetExecutionError> {
    let object = request
        .as_object_mut()
        .ok_or("Execution Job request must be a JSON object")?;
    object.insert(
        EXECUTION_ROUTE_REQUEST_KEY.to_string(),
        serde_json::to_value(route)?,
    );
    Ok(())
}

pub fn attach_artifact_transfer_routes(
    request: &mut serde_json::Value,
    routes: &ArtifactTransferRouteSnapshot,
) -> Result<(), TargetExecutionError> {
    let object = request
        .as_object_mut()
        .ok_or("Artifact Transfer Execution Job request must be a JSON object")?;
    object.insert(
        ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY.to_string(),
        serde_json::to_value(routes)?,
    );
    // The ordinary dispatcher and Edge protocol still need one coordinator
    // route. The destination owns atomic publication, so it is the natural
    // coordinator in v1.
    object.insert(
        EXECUTION_ROUTE_REQUEST_KEY.to_string(),
        serde_json::to_value(&routes.destination)?,
    );
    Ok(())
}

pub fn artifact_transfer_routes_from_job(
    job: &ExecutionJobRecord,
) -> Result<ArtifactTransferRouteSnapshot, TargetExecutionError> {
    let routes: ArtifactTransferRouteSnapshot = serde_json::from_value(
        job.request
            .get(ARTIFACT_TRANSFER_ROUTES_REQUEST_KEY)
            .cloned()
            .ok_or("Artifact Transfer Execution Job is missing its frozen pair of Routes")?,
    )?;
    if routes.destination.target_id != job.target_id {
        return Err("Artifact Transfer coordinator and destination Route are inconsistent".into());
    }
    Ok(routes)
}

pub fn route_snapshot_from_job(
    job: &ExecutionJobRecord,
) -> Result<ExecutionRouteSnapshot, TargetExecutionError> {
    let route = job
        .request
        .get(EXECUTION_ROUTE_REQUEST_KEY)
        .ok_or("Execution Job is missing its frozen Execution Route")?;
    let route: ExecutionRouteSnapshot = serde_json::from_value(route.clone())?;
    if route.target_id != job.target_id {
        return Err("Execution Job target_id and frozen Route are inconsistent".into());
    }
    Ok(route)
}

pub fn edge_command_route_from_job(
    job: &ExecutionJobRecord,
) -> Result<serde_json::Value, TargetExecutionError> {
    let mut value = serde_json::to_value(route_snapshot_from_job(job)?)?;
    let principal_id = job
        .initiating_principal_id
        .clone()
        .ok_or("Remote Execution Job is missing its authoritative Principal")?;
    value
        .as_object_mut()
        .ok_or("Execution Route must be encoded as a JSON object")?
        .insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(EdgeExecutionScope {
                principal_id,
                agent_id: job.agent_id.clone(),
                context_id: job.context_id.clone(),
                session_id: job.session_id.clone(),
                thread_id: job.thread_id.clone(),
            })?,
        );
    Ok(value)
}

/// Encode an Artifact Transfer's dual immutable route together with the
/// authority scope that the Edge Node must independently enforce.  The scope
/// is intentionally outside `ArtifactTransferRouteSnapshot`: it is execution
/// authority, not part of the data route itself.
pub fn edge_artifact_transfer_route_from_job(
    job: &ExecutionJobRecord,
    routes: &ArtifactTransferRouteSnapshot,
) -> Result<serde_json::Value, TargetExecutionError> {
    let mut value = serde_json::to_value(routes)?;
    let principal_id = job
        .initiating_principal_id
        .clone()
        .ok_or("Remote Artifact Transfer Job is missing its authoritative Principal")?;
    value
        .as_object_mut()
        .ok_or("Artifact Transfer Route must be encoded as a JSON object")?
        .insert(
            EDGE_EXECUTION_SCOPE_KEY.to_string(),
            serde_json::to_value(EdgeExecutionScope {
                principal_id,
                agent_id: job.agent_id.clone(),
                context_id: job.context_id.clone(),
                session_id: job.session_id.clone(),
                thread_id: job.thread_id.clone(),
            })?,
        );
    Ok(value)
}

pub fn edge_execution_scope_from_route(
    route: &serde_json::Value,
) -> Result<EdgeExecutionScope, TargetExecutionError> {
    let value = route
        .get(EDGE_EXECUTION_SCOPE_KEY)
        .ok_or("Edge Command is missing its authoritative Execution Scope")?;
    Ok(serde_json::from_value(value.clone())?)
}

pub fn prepare_managed_ssh_exec_arguments(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
    target_id: &str,
    arguments: &str,
) -> Result<String, TargetExecutionError> {
    validate_endpoint_ref(endpoint_ref)?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!(
            "Managed SSH endpoint '{endpoint_ref}' has not been explicitly approved"
        )
        .into());
    }
    if endpoint.auth_mode.uses_password() || endpoint.private_key_secret.is_some() {
        return Err("Managed SSH Secret authentication must be resolved and executed by the Runtime Secret Store".into());
    }
    let credentials = ManagedSshCredentialMaterial {
        askpass: None,
        identity: None,
        scrubbed_environment: Vec::new(),
    };
    build_managed_ssh_exec_arguments(endpoint_ref, endpoint, target_id, arguments, &credentials)
}

fn build_managed_ssh_exec_arguments(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
    target_id: &str,
    arguments: &str,
    credentials: &ManagedSshCredentialMaterial,
) -> Result<String, TargetExecutionError> {
    let mut arguments: serde_json::Value = serde_json::from_str(arguments)?;
    let object = arguments
        .as_object_mut()
        .ok_or("Managed SSH exec arguments must be a JSON object")?;
    let remote_command = object
        .get("command")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .ok_or("Managed SSH exec is missing a non-empty command")?;
    let remote_command = match object.get("cwd").and_then(serde_json::Value::as_str) {
        Some(cwd) if !cwd.trim().is_empty() => {
            format!("cd -- {} && {remote_command}", shell_quote(cwd))
        }
        _ => remote_command.to_string(),
    };
    let mut ssh = vec!["ssh".to_string()];
    if endpoint.destination.is_none() {
        ssh.extend([
            "-F".to_string(),
            if cfg!(windows) { "NUL" } else { "/dev/null" }.to_string(),
        ]);
        if credentials.identity.is_none() {
            ssh.extend(["-o".to_string(), "IdentitiesOnly=no".to_string()]);
        }
    }
    credentials.append_identity_arguments(&mut ssh);
    append_managed_ssh_auth_options(
        &mut ssh,
        endpoint.auth_mode,
        endpoint.private_key_passphrase_secret.is_some(),
    );
    append_managed_ssh_transport_liveness_options(&mut ssh);
    ssh.extend(["-o".to_string(), "StrictHostKeyChecking=yes".to_string()]);
    let destination = match endpoint.destination.as_deref() {
        Some(host) => {
            if let Some(user) = endpoint.user.as_deref() {
                ssh.extend(["-l".to_string(), user.to_string()]);
            }
            ssh.extend(["-p".to_string(), endpoint.port.to_string()]);
            host.to_string()
        }
        None => {
            ssh.extend([
                "-o".to_string(),
                format!("UserKnownHostsFile={}", endpoint.known_hosts_file.display()),
                "-p".to_string(),
                endpoint.port.to_string(),
            ]);
            endpoint
                .user
                .as_deref()
                .map(|user| format!("{user}@{}", endpoint.host))
                .unwrap_or_else(|| endpoint.host.clone())
        }
    };
    ssh.extend([
        "--".to_string(),
        destination,
        managed_ssh_posix_remote_command(&remote_command),
    ]);
    let ssh = credentials.render_shell_command(ssh)?;
    let wait_ms = object
        .get("wait_ms")
        .cloned()
        .unwrap_or(serde_json::json!(10_000));
    let background = object
        .get("background")
        .cloned()
        .unwrap_or(serde_json::json!(false));
    let managed_wait_ms = if background.as_bool().unwrap_or(false) {
        serde_json::Value::Null
    } else {
        wait_ms
    };
    let keep_running = object
        .get("keep_running")
        .cloned()
        .unwrap_or(serde_json::json!(false));
    let read_paths = endpoint
        .destination
        .is_none()
        .then(|| endpoint.known_hosts_file.clone())
        .into_iter()
        .collect::<Vec<_>>();
    let secret_env = managed_ssh_endpoint_secret_aliases(endpoint);
    Ok(serde_json::to_string(&serde_json::json!({
        "command": ssh,
        "cwd": ".",
        "wait_ms": managed_wait_ms,
        "background": background,
        "keep_running": keep_running,
        "sandbox_permissions": "require_escalated",
        "requested_permissions": {
            "network": true,
            "read_paths": read_paths,
            "secret_env": secret_env
        },
        "justification": format!(
            "Runtime uses locally preauthorized Managed SSH endpoint '{}' to execute Target '{}'",
            endpoint_ref, target_id
        )
    }))?)
}

fn append_managed_ssh_auth_options(
    arguments: &mut Vec<String>,
    mode: ManagedSshAuthMode,
    has_key_passphrase: bool,
) {
    match mode {
        ManagedSshAuthMode::KeyOnly if !has_key_passphrase => {
            arguments.extend(["-o".to_string(), "BatchMode=yes".to_string()]);
        }
        ManagedSshAuthMode::KeyOnly => arguments.extend([
            "-o".to_string(),
            "BatchMode=no".to_string(),
            "-o".to_string(),
            "PreferredAuthentications=publickey".to_string(),
        ]),
        ManagedSshAuthMode::PasswordOnly => arguments.extend([
            "-o".to_string(),
            "BatchMode=no".to_string(),
            "-o".to_string(),
            "PreferredAuthentications=password".to_string(),
            "-o".to_string(),
            "PubkeyAuthentication=no".to_string(),
            "-o".to_string(),
            "NumberOfPasswordPrompts=1".to_string(),
        ]),
        ManagedSshAuthMode::KeyThenPassword => arguments.extend([
            "-o".to_string(),
            "BatchMode=no".to_string(),
            "-o".to_string(),
            "PreferredAuthentications=publickey,password".to_string(),
            "-o".to_string(),
            "NumberOfPasswordPrompts=1".to_string(),
        ]),
    }
}

fn append_managed_ssh_transport_liveness_options(arguments: &mut Vec<String>) {
    // Authentication mode must not decide whether the transport can occupy a
    // durable Execution Job forever. ConnectTimeout bounds connection setup,
    // while protocol keepalives detect a dead established
    // connection without imposing a wall-clock limit on a legitimate long
    // remote command.
    arguments.extend([
        "-o".to_string(),
        "ConnectTimeout=30".to_string(),
        "-o".to_string(),
        "ConnectionAttempts=1".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=2".to_string(),
    ]);
}

pub(crate) fn is_prepared_managed_ssh_exec_command(command: &str) -> bool {
    #[cfg(unix)]
    {
        command.starts_with("'ssh' ")
            || (command.starts_with("'env' ") && command.contains(" 'ssh' "))
    }
    #[cfg(windows)]
    {
        command.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ")
    }
}

fn tool_result_is_background(
    result: &Result<Box<ToolExecutionResult>, TargetExecutionError>,
) -> bool {
    result
        .as_ref()
        .ok()
        .and_then(|result| serde_json::from_str::<serde_json::Value>(&result.text).ok())
        .is_some_and(|value| {
            value.get("execution").and_then(serde_json::Value::as_str) == Some("background")
        })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Quotes a path for a remote POSIX shell while preserving the conventional
/// current-user home shorthand. Artifact transfer commands do not run through
/// an interactive shell, so quoting the whole `~/...` value would otherwise
/// turn `~` into a literal directory name.
fn shell_quote_remote_path(value: &str) -> String {
    if value == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(relative) = value.strip_prefix("~/") {
        if relative.is_empty() {
            "\"$HOME\"".to_string()
        } else {
            format!("\"$HOME\"/{}", shell_quote(relative))
        }
    } else {
        shell_quote(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetInvocation {
    pub target_id: String,
    pub explicit_target: bool,
    /// Tool arguments after removing the Runtime-owned `target` routing field.
    pub tool_arguments: String,
}

/// Extracts the model-visible routing field without leaking it into individual
/// tool argument structs. This lets every physical tool share one protocol and
/// keeps logical tools completely unaware of Execution Targets.
pub fn split_target_argument(arguments: &str) -> Result<TargetInvocation, TargetExecutionError> {
    let mut value: serde_json::Value = serde_json::from_str(arguments)?;
    let object = value
        .as_object_mut()
        .ok_or("Physical-tool arguments must be a JSON object")?;
    let (target_id, explicit_target) = match object.remove("target") {
        None | Some(serde_json::Value::Null) => (DEFAULT_EXECUTION_TARGET_ID.to_string(), false),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => (value, true),
        Some(_) => return Err("Physical-tool target must be a non-empty string".into()),
    };
    Ok(TargetInvocation {
        target_id,
        explicit_target,
        tool_arguments: serde_json::to_string(&value)?,
    })
}

/// Cloud-side authorization boundary for a non-local Target. It deliberately
/// does not canonicalize paths against the cloud host: paths belong to the
/// Target Workspace and are validated again by the Provider Node's real
/// PermissionProfile and native sandbox.
pub fn remote_target_approval_requirement(
    target: &ExecutionTargetRecord,
    tool_name: &str,
    arguments: &str,
) -> Result<crate::permission::ApprovalRequirement, TargetExecutionError> {
    let value: serde_json::Value = serde_json::from_str(arguments)?;
    let object = value
        .as_object()
        .ok_or("Remote physical-tool arguments must be a JSON object")?;
    let path = object
        .get("path")
        .or_else(|| object.get("cwd"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from);
    let mut requested = CapabilityDelta::default();
    match tool_name {
        "read" | "list_files" | "search" => {
            if let Some(path) = path.clone() {
                requested.read_roots.push(path);
            }
            if tool_name == "search" {
                for path in json_string_array(object.get("paths")) {
                    let path = std::path::PathBuf::from(path);
                    if !requested.read_roots.contains(&path) {
                        requested.read_roots.push(path);
                    }
                }
            }
        }
        "write" | "edit" => {
            if let Some(path) = path.clone() {
                requested.write_roots.push(path);
            }
        }
        "exec" => {
            if let Some(permissions) = object
                .get("requested_permissions")
                .and_then(serde_json::Value::as_object)
            {
                requested.network = permissions
                    .get("network")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                requested.read_roots = json_string_array(permissions.get("read_paths"))
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect();
                requested.write_roots = json_string_array(permissions.get("write_paths"))
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .collect();
                requested.secret_env = json_string_array(permissions.get("secret_env"));
            }
        }
        _ => {}
    }
    if target.kind == ExecutionTargetKind::ManagedSsh {
        requested.network = true;
        if target.provider_node_id.is_none() {
            // Runtime Managed SSH credentials are Target-owned bindings. Do
            // not let model-authored exec arguments select unrelated local
            // secrets for a remote command.
            requested.secret_env.clear();
            requested.secret_env = managed_ssh_target_secret_aliases(target)?;
        }
    }
    let execution_location =
        if target.kind == ExecutionTargetKind::ManagedSsh && target.provider_node_id.is_none() {
            "Runtime"
        } else {
            "Provider Node"
        };
    Ok(crate::permission::ApprovalRequirement {
        action: ApprovalAction::ToolOperation {
            tool: tool_name.to_string(),
            operation: "execute_on_remote_target".to_string(),
            target: path,
        },
        requested,
        justification: format!(
            "the current Thread is using physical capability '{tool_name}' on non-local Execution Target '{}' ({}) for the first time; {execution_location} will execute through the frozen Route and still requires existing automatic or human approval",
            target.id, target.name
        ),
    })
}

pub fn remote_artifact_transfer_approval_requirement(
    source: &ExecutionTargetRecord,
    destination: &ExecutionTargetRecord,
    request: &crate::artifact::ArtifactTransferRequest,
) -> Result<Option<crate::permission::ApprovalRequirement>, TargetExecutionError> {
    let mut requested = CapabilityDelta::default();
    if source.kind != ExecutionTargetKind::InProcessLocal {
        requested
            .read_roots
            .push(PathBuf::from(&request.source.path));
        extend_transfer_transport_capability(source, &mut requested)?;
    }
    if destination.kind != ExecutionTargetKind::InProcessLocal {
        requested
            .write_roots
            .push(PathBuf::from(&request.destination.path));
        extend_transfer_transport_capability(destination, &mut requested)?;
    }
    if requested.is_empty() {
        return Ok(None);
    }
    Ok(Some(crate::permission::ApprovalRequirement {
        action: ApprovalAction::ToolOperation {
            tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
            operation: "transfer".to_string(),
            target: None,
        },
        requested,
        justification: format!(
            "Artifact Transfer will read '{}' from Target '{}' and write '{}' to Target '{}'; source and destination remain subject to each Target's local PermissionProfile",
            request.source.path,
            source.id,
            request.destination.path,
            destination.id,
        ),
    }))
}

fn extend_transfer_transport_capability(
    target: &ExecutionTargetRecord,
    requested: &mut CapabilityDelta,
) -> Result<(), TargetExecutionError> {
    if target.kind == ExecutionTargetKind::ManagedSsh {
        requested.network = true;
        if target.provider_node_id.is_none() {
            for alias in managed_ssh_target_secret_aliases(target)? {
                if !requested.secret_env.contains(&alias) {
                    requested.secret_env.push(alias);
                }
            }
        }
    }
    Ok(())
}

fn managed_ssh_target_auth_mode(
    target: &ExecutionTargetRecord,
) -> Result<ManagedSshAuthMode, TargetExecutionError> {
    match target.metadata.get("auth_mode") {
        None | Some(serde_json::Value::Null) => Ok(ManagedSshAuthMode::KeyOnly),
        Some(value) => Ok(serde_json::from_value(value.clone()).map_err(|_| {
            format!(
                "Runtime Managed SSH Target '{}' has an invalid auth_mode",
                target.id
            )
        })?),
    }
}

fn managed_ssh_target_secret_aliases(
    target: &ExecutionTargetRecord,
) -> Result<Vec<String>, TargetExecutionError> {
    let mode = managed_ssh_target_auth_mode(target)?;
    let mut aliases = Vec::new();
    if mode.uses_keys() {
        if let Some(alias) = target
            .metadata
            .get("private_key_secret")
            .and_then(serde_json::Value::as_str)
        {
            validate_managed_ssh_secret_alias("private_key_secret", alias)?;
            aliases.push(alias.to_string());
            if let Some(passphrase_alias) = target
                .metadata
                .get("private_key_passphrase_secret")
                .and_then(serde_json::Value::as_str)
            {
                validate_managed_ssh_secret_alias(
                    "private_key_passphrase_secret",
                    passphrase_alias,
                )?;
                aliases.push(passphrase_alias.to_string());
            }
        } else if std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty()) {
            aliases.push("SSH_AUTH_SOCK".to_string());
        }
    }
    if mode.uses_password() {
        let alias = target
            .metadata
            .get("password_secret")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Runtime Managed SSH Target '{}' is missing its password Secret binding",
                    target.id
                )
            })?;
        validate_managed_ssh_secret_alias("password_secret", alias)?;
        aliases.push(alias.to_string());
    }
    Ok(aliases)
}

fn json_string_array(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
}

#[async_trait::async_trait]
pub trait ExecutionTargetBackend: Send + Sync {
    fn kind(&self) -> ExecutionTargetKind;

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, TargetExecutionError>;
}

/// Route-pair transport selected by Runtime for cross-Target Artifact
/// movement. It is separate from the model Tool registry: callers cannot name
/// one of these implementations or supply credentials.
#[async_trait::async_trait]
pub trait ArtifactTransferExecutionBackend: Send + Sync {
    fn name(&self) -> &'static str;

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool;

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError>;
}

#[derive(Debug, Clone)]
pub struct TargetExecutionContext {
    pub target: ExecutionTargetRecord,
    pub job: ExecutionJobRecord,
}

/// Existing single-process tool implementation exposed through the same
/// backend contract future Edge/SSH/managed workers use.
pub struct InProcessLocalBackend;

#[async_trait::async_trait]
impl ExecutionTargetBackend for InProcessLocalBackend {
    fn kind(&self) -> ExecutionTargetKind {
        ExecutionTargetKind::InProcessLocal
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, TargetExecutionError> {
        if context.target.id != DEFAULT_EXECUTION_TARGET_ID {
            return Err(format!(
                "InProcessLocal Backend can execute only '{}' and cannot implicitly proxy '{}'",
                DEFAULT_EXECUTION_TARGET_ID, context.target.id
            )
            .into());
        }
        tool.execute_result(arguments).await
    }
}

/// Durable outbound transport used by user-owned Edge Nodes. The cloud-side
/// evaluator never opens an inbound connection to a user's computer: it
/// materializes one idempotent command and waits for an authenticated Node to
/// claim and fence the result.
pub struct EdgeNodeBackend {
    store: Arc<dyn EdgeExecutionStore>,
    kind: ExecutionTargetKind,
    poll_interval: std::time::Duration,
}

impl EdgeNodeBackend {
    pub fn new(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            kind: ExecutionTargetKind::EdgeNode,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    pub fn managed_ssh(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            kind: ExecutionTargetKind::ManagedSsh,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    pub fn with_poll_interval(mut self, interval: std::time::Duration) -> Self {
        self.poll_interval = interval.max(std::time::Duration::from_millis(25));
        self
    }
}

#[async_trait::async_trait]
impl ExecutionTargetBackend for EdgeNodeBackend {
    fn kind(&self) -> ExecutionTargetKind {
        self.kind
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, TargetExecutionError> {
        let provider_node_id = context.target.provider_node_id.as_deref().ok_or_else(|| {
            format!(
                "Edge Target '{}' has no authoritative provider_node_id",
                context.target.id
            )
        })?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: context.job.id.clone(),
                target_id: context.target.id.clone(),
                provider_node_id: provider_node_id.to_string(),
                tool_name: tool.name().to_string(),
                arguments: arguments.to_string(),
                route: edge_command_route_from_job(&context.job)?,
            })
            .await?;
        loop {
            let command = self
                .store
                .get_edge_command(&context.job.id)
                .await?
                .ok_or("Edge Command disappeared while waiting")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(ToolExecutionResult::decode_transport(
                        command.output.unwrap_or_else(|| {
                            serde_json::json!({
                                "status": "success",
                                "output": null,
                                "message": "Edge tool completed without output"
                            })
                            .to_string()
                        }),
                    ));
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge tool failed".to_string())
                        .into());
                }
                EdgeCommandStatus::Cancelled => return Err("Edge tool was cancelled".into()),
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge tool outcome is unknown".to_string())
                        .into());
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    self.store
                        .wait_for_edge_command_change(self.poll_interval)
                        .await;
                }
            }
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeNodeBackend {
    fn name(&self) -> &'static str {
        "edge_local_copy"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        self.kind == ExecutionTargetKind::EdgeNode
            && source.backend_kind == ExecutionTargetKind::EdgeNode
            && destination.backend_kind == ExecutionTargetKind::EdgeNode
            && source.target_id == destination.target_id
            && source.provider_node_id.is_some()
            && source.provider_node_id == destination.provider_node_id
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        if !self.supports(&routes.source, &routes.destination) {
            return Err(
                "Edge-local Artifact transport accepts only transfers within the same Edge Target"
                    .into(),
            );
        }
        let provider_node_id = routes
            .source
            .provider_node_id
            .as_deref()
            .ok_or("Edge Artifact Route is missing provider_node_id")?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: routes.source.target_id.clone(),
                provider_node_id: provider_node_id.to_string(),
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: edge_artifact_transfer_route_from_job(job, routes)?,
            })
            .await?;

        loop {
            let command = self
                .store
                .get_edge_command(&job.id)
                .await?
                .ok_or("Edge Artifact Command disappeared while waiting")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    let output = command
                        .output
                        .as_deref()
                        .ok_or("Edge Artifact Command succeeded without a Receipt")?;
                    let mut receipt: crate::artifact::ArtifactTransferReceipt =
                        serde_json::from_str(output)?;
                    // The Edge worker localizes both endpoints to its own
                    // `target-default` before physical execution. Restore the
                    // cloud-authoritative locations in the public receipt.
                    receipt.source.location = request.source.clone();
                    receipt.destination.location = request.destination.clone();
                    receipt.transport = "edge_local_copy".to_string();
                    receipt.validate_against(request)?;
                    return Ok(receipt);
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer outcome is unknown".to_string())
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    self.store
                        .wait_for_edge_command_change(self.poll_interval)
                        .await;
                }
            }
        }
    }
}

/// Executes a transfer wholly inside one user-owned Provider Node, while one
/// or both logical endpoints are Managed SSH Targets proxied by that Node.
/// The cloud never opens SSH and never receives credentials or payload bytes;
/// it only persists the frozen dual Route and waits for the Node-side Runtime
/// to apply its own PermissionBroker at the physical boundary.
pub struct EdgeProxyArtifactTransferBackend {
    store: Arc<dyn EdgeExecutionStore>,
    poll_interval: std::time::Duration,
}

impl EdgeProxyArtifactTransferBackend {
    pub fn new(store: Arc<dyn EdgeExecutionStore>) -> Self {
        Self {
            store,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeProxyArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "edge_proxy_managed_ssh"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        let supported = |route: &ExecutionRouteSnapshot| {
            matches!(
                route.backend_kind,
                ExecutionTargetKind::EdgeNode | ExecutionTargetKind::ManagedSsh
            ) && route.provider_node_id.is_some()
        };
        supported(source)
            && supported(destination)
            && source.provider_node_id == destination.provider_node_id
            && (source.backend_kind == ExecutionTargetKind::ManagedSsh
                || destination.backend_kind == ExecutionTargetKind::ManagedSsh)
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        if !self.supports(&routes.source, &routes.destination) {
            return Err("Edge-proxy Artifact transport accepts only Edge/Managed SSH Routes within the same Provider Node".into());
        }
        let provider_node_id = routes
            .source
            .provider_node_id
            .clone()
            .ok_or("Edge-proxy Artifact Route is missing provider_node_id")?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: routes.destination.target_id.clone(),
                provider_node_id,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: edge_artifact_transfer_route_from_job(job, routes)?,
            })
            .await?;

        loop {
            let command = self
                .store
                .get_edge_command(&job.id)
                .await?
                .ok_or("Edge-proxy Artifact Command disappeared while waiting")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    let mut receipt: crate::artifact::ArtifactTransferReceipt =
                        serde_json::from_str(
                            command
                                .output
                                .as_deref()
                                .ok_or("Edge-proxy Artifact Command succeeded without a Receipt")?,
                        )?;
                    receipt.source.location = request.source.clone();
                    receipt.destination.location = request.destination.clone();
                    receipt.transport = "edge_proxy_managed_ssh".to_string();
                    receipt.validate_against(request)?;
                    return Ok(receipt);
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge proxy Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| {
                            "Edge proxy Artifact transfer outcome is unknown".to_string()
                        })
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    self.store
                        .wait_for_edge_command_change(self.poll_interval)
                        .await;
                }
            }
        }
    }
}

/// Runtime↔Edge byte channel. Runtime-owned staging is not a user-visible
/// Target and never weakens endpoint policy: the Runtime endpoint is checked
/// here, while the Edge endpoint is checked again by the Node's own
/// PermissionBroker before local publication/read.
pub struct RuntimeEdgeArtifactTransferBackend {
    store: Arc<dyn EdgeExecutionStore>,
    jobs: Arc<dyn ExecutionJobStore>,
    stages: crate::artifact::ArtifactTransferStageStore,
    permissions: Arc<crate::permission::PermissionBroker>,
    poll_interval: std::time::Duration,
}

impl RuntimeEdgeArtifactTransferBackend {
    pub fn new(
        store: Arc<dyn EdgeExecutionStore>,
        jobs: Arc<dyn ExecutionJobStore>,
        stages: crate::artifact::ArtifactTransferStageStore,
        permissions: Arc<crate::permission::PermissionBroker>,
    ) -> Self {
        Self {
            store,
            jobs,
            stages,
            permissions,
            poll_interval: std::time::Duration::from_millis(250),
        }
    }

    async fn wait_for_edge_receipt(
        &self,
        job_id: &str,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        loop {
            if self
                .jobs
                .get_execution_job(job_id)
                .await?
                .is_some_and(|job| job.cancel_requested_at.is_some())
            {
                let _ = self.store.request_edge_command_cancel(job_id).await?;
            }
            let command = self
                .store
                .get_edge_command(job_id)
                .await?
                .ok_or("Edge Artifact Command disappeared while waiting")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(serde_json::from_str(command.output.as_deref().ok_or(
                        "Edge Artifact Command succeeded without an ArtifactTransferReceipt",
                    )?)?)
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge Artifact transfer outcome is unknown".to_string())
                        .into())
                }
                EdgeCommandStatus::Queued
                | EdgeCommandStatus::Claimed
                | EdgeCommandStatus::CancelRequested => {
                    self.store
                        .wait_for_edge_command_change(self.poll_interval)
                        .await;
                }
            }
        }
    }

    async fn authorize_runtime_endpoint(
        &self,
        request: &crate::artifact::ArtifactTransferRequest,
        access: crate::permission::FilesystemAccess,
    ) -> Result<PathBuf, TargetExecutionError> {
        let location = if access == crate::permission::FilesystemAccess::Read {
            &request.source
        } else {
            &request.destination
        };
        let mut requested = CapabilityDelta::default();
        let path = match self
            .permissions
            .profile()
            .inspect_path(&location.path, access)?
        {
            crate::permission::PathDecision::Allowed(path) => path,
            crate::permission::PathDecision::Denied(reason) => return Err(reason.into()),
            crate::permission::PathDecision::NeedsApproval {
                candidate,
                resolved_anchor,
            } => {
                match access {
                    crate::permission::FilesystemAccess::Read => {
                        requested.read_roots.push(resolved_anchor)
                    }
                    crate::permission::FilesystemAccess::Write => {
                        requested.write_roots.push(resolved_anchor)
                    }
                }
                candidate
            }
        };
        self.permissions
            .authorize_delta(
                ApprovalAction::ToolOperation {
                    tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                    operation: "transfer".to_string(),
                    target: Some(path.clone()),
                },
                requested,
                format!(
                    "Artifact Transfer accesses Runtime path '{}'",
                    location.path
                ),
                crate::tool::current_approval_context(),
            )
            .await?;
        Ok(path)
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for RuntimeEdgeArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "runtime_edge_channel"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        matches!(
            (source.backend_kind, destination.backend_kind),
            (
                ExecutionTargetKind::InProcessLocal,
                ExecutionTargetKind::EdgeNode
            ) | (
                ExecutionTargetKind::EdgeNode,
                ExecutionTargetKind::InProcessLocal
            )
        ) && (source.backend_kind != ExecutionTargetKind::EdgeNode
            || source.provider_node_id.is_some())
            && (destination.backend_kind != ExecutionTargetKind::EdgeNode
                || destination.provider_node_id.is_some())
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        let (direction, channel, command_target, provider_node_id) =
            if routes.source.backend_kind == ExecutionTargetKind::InProcessLocal {
                let source = self
                    .authorize_runtime_endpoint(request, crate::permission::FilesystemAccess::Read)
                    .await?;
                let stage = self
                    .stages
                    .prepare_stage_path(
                        &job.id,
                        crate::artifact::ArtifactTransferStageKind::RuntimeSource,
                    )
                    .await?;
                let staged = spool_local_artifact(&source, &stage).await?;
                if request
                    .expected_source_digest
                    .as_deref()
                    .is_some_and(|expected| expected != staged.logical_digest())
                {
                    return Err(format!(
                        "Artifact source digest conflict: expected '{}', actual '{}'",
                        request
                            .expected_source_digest
                            .as_deref()
                            .unwrap_or_default(),
                        staged.logical_digest()
                    )
                    .into());
                }
                let edge = &routes.destination;
                (
                    EdgeArtifactDataDirection::RuntimeToEdge,
                    EdgeArtifactDataChannel {
                        direction: EdgeArtifactDataDirection::RuntimeToEdge,
                        payload_kind: staged.kind.into(),
                        expected_digest: Some(staged.payload_digest),
                        size_bytes: Some(staged.payload_size_bytes),
                    },
                    edge.target_id.clone(),
                    edge.provider_node_id
                        .clone()
                        .ok_or("Edge destination Route is missing provider_node_id")?,
                )
            } else {
                let edge = &routes.source;
                (
                    EdgeArtifactDataDirection::EdgeToRuntime,
                    EdgeArtifactDataChannel {
                        direction: EdgeArtifactDataDirection::EdgeToRuntime,
                        payload_kind: EdgeArtifactPayloadKind::Detect,
                        // The target-local Artifact digest is not necessarily
                        // the digest of its wire representation (directories
                        // use a canonical archive), so it is validated from
                        // the Tool Receipt after materialization.
                        expected_digest: None,
                        size_bytes: None,
                    },
                    edge.target_id.clone(),
                    edge.provider_node_id
                        .clone()
                        .ok_or("Edge source Route is missing provider_node_id")?,
                )
            };
        let mut route = edge_artifact_transfer_route_from_job(job, routes)?;
        attach_edge_artifact_data_channel(&mut route, &channel)?;
        self.store
            .create_edge_command(NewEdgeCommand {
                job_id: job.id.clone(),
                target_id: command_target,
                provider_node_id,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route,
            })
            .await?;
        let mut receipt = self.wait_for_edge_receipt(&job.id).await?;

        if direction == EdgeArtifactDataDirection::EdgeToRuntime {
            let logical_digest = receipt
                .source
                .content_digest
                .clone()
                .ok_or("Edge Artifact Receipt is missing the source digest")?;
            let logical_size = receipt
                .source
                .size_bytes
                .ok_or("Edge Artifact Receipt is missing the size")?;
            let stage = self.stages.stage_path(
                &job.id,
                crate::artifact::ArtifactTransferStageKind::EdgeUpload,
            );
            let kind = if receipt.source.media_type.as_deref()
                == Some("application/vnd.morphz.directory")
            {
                StagedArtifactKind::DirectoryArchive
            } else {
                StagedArtifactKind::File
            };
            let destination = self
                .authorize_runtime_endpoint(request, crate::permission::FilesystemAccess::Write)
                .await?;
            let mut publish_request = request.clone();
            // The exact upload bytes are separately verified by the Edge data
            // channel. A directory's logical digest describes the tree, not
            // its canonical archive, so publication must not compare those
            // two different representations.
            publish_request.expected_source_digest = None;
            publish_spooled_local_artifact(&publish_request, &stage, &destination, kind).await?;
            receipt.source.location = request.source.clone();
            receipt.destination.location = request.destination.clone();
            receipt.source.content_digest = Some(logical_digest.clone());
            receipt.destination.content_digest = Some(logical_digest);
            receipt.source.size_bytes = Some(logical_size);
            receipt.destination.size_bytes = Some(logical_size);
        } else {
            receipt.source.location = request.source.clone();
            receipt.destination.location = request.destination.clone();
        }
        receipt.transport = "runtime_edge_channel".to_string();
        receipt.validate_against(request)?;
        let _ = self.stages.remove_job(&job.id).await;
        Ok(receipt)
    }
}

/// Edge A→Edge B relay. Each physical leg is a durable child Execution Job
/// under the caller-visible parent transfer, so command identity, cancellation
/// and restart reconciliation remain explicit instead of overloading one Edge
/// command row with two owners.
pub struct EdgeRelayArtifactTransferBackend {
    edges: Arc<dyn EdgeExecutionStore>,
    jobs: Arc<dyn ExecutionJobStore>,
    stages: crate::artifact::ArtifactTransferStageStore,
    poll_interval: std::time::Duration,
    claimant_id: String,
}

impl EdgeRelayArtifactTransferBackend {
    pub fn new(
        edges: Arc<dyn EdgeExecutionStore>,
        jobs: Arc<dyn ExecutionJobStore>,
        stages: crate::artifact::ArtifactTransferStageStore,
    ) -> Self {
        Self {
            edges,
            jobs,
            stages,
            poll_interval: std::time::Duration::from_millis(250),
            claimant_id: new_artifact_relay_claimant_id(),
        }
    }

    async fn create_and_claim_leg(
        &self,
        parent: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
        leg: &str,
        target_id: &str,
    ) -> Result<(ExecutionJobRecord, String), TargetExecutionError> {
        let id = crate::artifact::artifact_transfer_relay_leg_job_id(&parent.id, leg);
        let mut request_value = serde_json::to_value(request)?;
        attach_artifact_transfer_routes(&mut request_value, routes)?;
        let job = self
            .jobs
            .create_execution_job(NewExecutionJob {
                id,
                activation_id: parent.activation_id.clone(),
                thread_id: parent.thread_id.clone(),
                agent_id: parent.agent_id.clone(),
                context_id: parent.context_id.clone(),
                session_id: parent.session_id.clone(),
                initiating_principal_id: parent.initiating_principal_id.clone(),
                target_id: target_id.to_string(),
                tool_call_id: format!("{}:{leg}", parent.tool_call_id),
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                request: request_value,
                retry_safety: ExecutionRetrySafety::Idempotent,
                // Keeps the generic Runtime worker from claiming this private
                // relay leg between materialization and the relay claim.
                requires_approval: true,
            })
            .await?;
        if job.status.is_terminal() {
            return if job.status == ExecutionJobStatus::Succeeded {
                Ok((job, String::new()))
            } else {
                Err(format!(
                    "Artifact relay leg '{}' terminated with {}: {}",
                    job.id,
                    job.status.as_str(),
                    job.error.as_deref().unwrap_or("no error details")
                )
                .into())
            };
        }
        let mut job = job;
        if job.status == ExecutionJobStatus::Running
            && job
                .lease_expires_at
                .is_some_and(|expires_at| expires_at <= Utc::now())
            && job.retry_safety == ExecutionRetrySafety::Idempotent
        {
            job = match self
                .jobs
                .requeue_execution_job(&job.id, job.revision)
                .await?
            {
                ExecutionJobMutation::Updated(job) | ExecutionJobMutation::Existing(job) => job,
                ExecutionJobMutation::Conflict { current } => current,
                ExecutionJobMutation::Rejected { reason, .. } => return Err(reason.into()),
                ExecutionJobMutation::NotFound => {
                    return Err("Artifact relay leg disappeared before recovery".into())
                }
            };
        }
        let claim_token = format!(
            "relay-claim-{}-{:x}",
            self.claimant_id,
            Sha256::digest(format!("{}\0r{}", job.id, job.revision).as_bytes())
        );
        let claimed = self
            .jobs
            .claim_execution_job(
                &job.id,
                job.revision,
                &self.claimant_id,
                &claim_token,
                Utc::now() + chrono::Duration::minutes(10),
                Some("runtime-internal-artifact-relay"),
            )
            .await?;
        match claimed {
            ExecutionJobMutation::Updated(job) | ExecutionJobMutation::Existing(job) => {
                Ok((job, claim_token))
            }
            ExecutionJobMutation::Conflict { current } => Err(format!(
                "Artifact relay leg '{}' claim conflict: current {} r{}",
                current.id,
                current.status.as_str(),
                current.revision
            )
            .into()),
            ExecutionJobMutation::Rejected { reason, .. } => Err(reason.into()),
            ExecutionJobMutation::NotFound => {
                Err("Artifact relay leg disappeared before claim".into())
            }
        }
    }

    async fn finish_leg(
        &self,
        job: &ExecutionJobRecord,
        claim_token: &str,
        status: ExecutionJobStatus,
        error: Option<String>,
    ) -> Result<(), TargetExecutionError> {
        let current = self
            .jobs
            .get_execution_job(&job.id)
            .await?
            .ok_or("Artifact relay leg disappeared before finish")?;
        if current.status == status && current.status.is_terminal() {
            return Ok(());
        }
        let terminal = ExecutionJobTerminal {
            status,
            result_event_id: None,
            result_refs: Vec::new(),
            error,
            exit_code: None,
        };
        match self
            .jobs
            .finish_execution_job(
                &current.id,
                current.revision,
                (!claim_token.is_empty()).then_some(claim_token),
                terminal,
            )
            .await?
        {
            ExecutionJobMutation::Updated(_) | ExecutionJobMutation::Existing(_) => Ok(()),
            ExecutionJobMutation::Conflict { current } => Err(format!(
                "Artifact relay leg '{}' finish conflict: current {} r{}",
                current.id,
                current.status.as_str(),
                current.revision
            )
            .into()),
            ExecutionJobMutation::Rejected { reason, .. } => Err(reason.into()),
            ExecutionJobMutation::NotFound => {
                Err("Artifact relay leg disappeared before finish".into())
            }
        }
    }

    async fn run_edge_leg(
        &self,
        parent_job_id: &str,
        leg_job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
        route: &ExecutionRouteSnapshot,
        channel: EdgeArtifactDataChannel,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        let mut command_route = edge_artifact_transfer_route_from_job(leg_job, routes)?;
        attach_edge_artifact_data_channel(&mut command_route, &channel)?;
        self.edges
            .create_edge_command(NewEdgeCommand {
                job_id: leg_job.id.clone(),
                target_id: route.target_id.clone(),
                provider_node_id: route
                    .provider_node_id
                    .clone()
                    .ok_or("Artifact-relay Edge Route is missing provider_node_id")?,
                tool_name: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                arguments: crate::artifact::execution_arguments_from_transfer_request(request)?,
                route: command_route,
            })
            .await?;
        loop {
            if self
                .jobs
                .get_execution_job(parent_job_id)
                .await?
                .is_some_and(|job| job.cancel_requested_at.is_some())
            {
                let _ = self.edges.request_edge_command_cancel(&leg_job.id).await?;
            }
            let command = self
                .edges
                .get_edge_command(&leg_job.id)
                .await?
                .ok_or("Artifact-relay Edge Command disappeared")?;
            match command.status {
                EdgeCommandStatus::Succeeded => {
                    return Ok(serde_json::from_str(
                        command
                            .output
                            .as_deref()
                            .ok_or("Artifact relay leg is missing a Receipt")?,
                    )?)
                }
                EdgeCommandStatus::Failed => {
                    return Err(command
                        .error
                        .unwrap_or_else(|| "Edge relay failed".to_string())
                        .into())
                }
                EdgeCommandStatus::Cancelled => {
                    return Err(crate::artifact::ArtifactTransferCancelled.into())
                }
                EdgeCommandStatus::Lost => return Err("Edge relay leg outcome lost".into()),
                _ => {
                    self.edges
                        .wait_for_edge_command_change(self.poll_interval)
                        .await
                }
            }
        }
    }
}

fn new_artifact_relay_claimant_id() -> String {
    static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);
    let instance = NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed);
    let mut random = [0_u8; 16];
    let nonce = if getrandom::fill(&mut random).is_ok() {
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    } else {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos().to_string())
            .unwrap_or_default()
    };
    format!("artifact-relay:{}:{nonce}:{instance}", std::process::id())
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for EdgeRelayArtifactTransferBackend {
    fn name(&self) -> &'static str {
        "edge_relay_channel"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        source.backend_kind == ExecutionTargetKind::EdgeNode
            && destination.backend_kind == ExecutionTargetKind::EdgeNode
            && source.provider_node_id.is_some()
            && destination.provider_node_id.is_some()
            && (source.provider_node_id != destination.provider_node_id
                || source.target_id != destination.target_id)
    }

    async fn execute_transfer(
        &self,
        parent: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        crate::artifact::report_artifact_bytes("edge_source", 0, None);
        let (source_leg, source_claim) = self
            .create_and_claim_leg(parent, routes, request, "source", &routes.source.target_id)
            .await?;
        let source_result = self
            .run_edge_leg(
                &parent.id,
                &source_leg,
                routes,
                request,
                &routes.source,
                EdgeArtifactDataChannel {
                    direction: EdgeArtifactDataDirection::EdgeToRuntime,
                    payload_kind: EdgeArtifactPayloadKind::Detect,
                    expected_digest: None,
                    size_bytes: None,
                },
            )
            .await;
        let source_receipt = match source_result {
            Ok(receipt) => {
                self.finish_leg(
                    &source_leg,
                    &source_claim,
                    ExecutionJobStatus::Succeeded,
                    None,
                )
                .await?;
                receipt
            }
            Err(error) => {
                let status = if crate::artifact::is_artifact_transfer_cancelled(error.as_ref()) {
                    ExecutionJobStatus::Cancelled
                } else {
                    ExecutionJobStatus::Failed
                };
                let message = error.to_string();
                let _ = self
                    .finish_leg(&source_leg, &source_claim, status, Some(message.clone()))
                    .await;
                return Err(error);
            }
        };
        source_receipt
            .source
            .content_digest
            .as_deref()
            .ok_or("Artifact-relay source Receipt is missing digest")?;
        let logical_size = source_receipt
            .source
            .size_bytes
            .ok_or("Artifact-relay source Receipt is missing size")?;
        let payload_kind = if source_receipt.source.media_type.as_deref()
            == Some("application/vnd.morphz.directory")
        {
            EdgeArtifactPayloadKind::DirectoryArchive
        } else {
            EdgeArtifactPayloadKind::File
        };
        crate::artifact::report_artifact_bytes("edge_relay", 0, Some(logical_size));

        let (destination_leg, destination_claim) = self
            .create_and_claim_leg(
                parent,
                routes,
                request,
                "destination",
                &routes.destination.target_id,
            )
            .await?;
        let source_stage = self.stages.stage_path(
            &source_leg.id,
            crate::artifact::ArtifactTransferStageKind::EdgeUpload,
        );
        let (payload_size, payload_digest) = hash_file(&source_stage).await?;
        let destination_stage = self
            .stages
            .prepare_stage_path(
                &destination_leg.id,
                crate::artifact::ArtifactTransferStageKind::RuntimeSource,
            )
            .await?;
        let mut source_file = tokio::fs::File::open(&source_stage).await?;
        let mut destination_file = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&destination_stage)
            .await?;
        let mut relayed = 0_u64;
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let count = source_file.read(&mut buffer).await?;
            if count == 0 {
                break;
            }
            destination_file.write_all(&buffer[..count]).await?;
            relayed = relayed.saturating_add(count as u64);
            crate::artifact::report_artifact_bytes("edge_relay", relayed, Some(payload_size));
        }
        destination_file.flush().await?;
        destination_file.sync_data().await?;
        crate::artifact::report_artifact_bytes("edge_destination", 0, Some(payload_size));
        let destination_result = self
            .run_edge_leg(
                &parent.id,
                &destination_leg,
                routes,
                request,
                &routes.destination,
                EdgeArtifactDataChannel {
                    direction: EdgeArtifactDataDirection::RuntimeToEdge,
                    payload_kind,
                    expected_digest: Some(payload_digest),
                    size_bytes: Some(payload_size),
                },
            )
            .await;
        let mut receipt = match destination_result {
            Ok(receipt) => {
                self.finish_leg(
                    &destination_leg,
                    &destination_claim,
                    ExecutionJobStatus::Succeeded,
                    None,
                )
                .await?;
                receipt
            }
            Err(error) => {
                let status = if crate::artifact::is_artifact_transfer_cancelled(error.as_ref()) {
                    ExecutionJobStatus::Cancelled
                } else {
                    ExecutionJobStatus::Failed
                };
                let message = error.to_string();
                let _ = self
                    .finish_leg(
                        &destination_leg,
                        &destination_claim,
                        status,
                        Some(message.clone()),
                    )
                    .await;
                return Err(error);
            }
        };
        receipt.source.location = request.source.clone();
        receipt.destination.location = request.destination.clone();
        receipt.transport = "edge_relay_channel".to_string();
        receipt.validate_against(request)?;
        let _ = self.stages.remove_job(&source_leg.id).await;
        let _ = self.stages.remove_job(&destination_leg.id).await;
        Ok(receipt)
    }
}

/// Routes Managed SSH either through the owning Edge Node or through the
/// current Runtime. A Target with `provider_node_id` is always remote; a
/// Runtime-local Target must name an endpoint loaded from host-owned config.
pub struct ManagedSshBackend {
    edge: EdgeNodeBackend,
    local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
    stages: crate::artifact::ArtifactTransferStageStore,
    permissions: Arc<crate::permission::PermissionBroker>,
    secret_store: Arc<crate::secret_store::SecretStore>,
    permission_policy_digest: String,
    approval_required: bool,
}

impl ManagedSshBackend {
    pub fn new(
        store: Arc<dyn EdgeExecutionStore>,
        local_endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        stages: crate::artifact::ArtifactTransferStageStore,
        permissions: Arc<crate::permission::PermissionBroker>,
        secret_store: Arc<crate::secret_store::SecretStore>,
        permission_policy_digest: String,
        approval_required: bool,
    ) -> Self {
        Self {
            edge: EdgeNodeBackend::managed_ssh(store),
            local_endpoints,
            stages,
            permissions,
            secret_store,
            permission_policy_digest,
            approval_required,
        }
    }

    async fn authentication_for(
        &self,
        endpoint: &ManagedSshEndpoint,
        job: &ExecutionJobRecord,
        target_id: &str,
    ) -> Result<ManagedSshAuthentication, TargetExecutionError> {
        if endpoint.private_key_secret.is_none()
            && endpoint.private_key_passphrase_secret.is_none()
            && endpoint.password_secret.is_none()
        {
            return Ok(ManagedSshAuthentication::default());
        }
        let private_key_alias = endpoint.private_key_secret.clone();
        let key_passphrase_alias = endpoint.private_key_passphrase_secret.clone();
        let password_alias = endpoint.password_secret.clone();
        let secret_store = Arc::clone(&self.secret_store);
        let context_id = job.context_id.clone();
        let session_id = job.session_id.clone();
        let objective_id = crate::tool::CURRENT_OBJECTIVE_ID
            .try_with(Clone::clone)
            .ok()
            .flatten();
        let target_id = target_id.to_string();
        let resolved = tokio::task::spawn_blocking(move || {
            let resolve = |alias: Option<&str>, label: &str| -> Result<Option<String>, String> {
                let Some(alias) = alias else {
                    return Ok(None);
                };
                secret_store
                    .resolve(
                        alias,
                        crate::secret_store::SecretUseContext {
                            context_id: Some(&context_id),
                            session_id: Some(&session_id),
                            objective_id: objective_id.as_deref(),
                            target_id: Some(&target_id),
                        },
                    )?
                    .map(Some)
                    .ok_or_else(|| {
                        format!("Managed SSH {label} Secret '{alias}' does not exist in the current scope")
                    })
            };
            Ok::<_, String>((
                resolve(private_key_alias.as_deref(), "private key")?,
                resolve(key_passphrase_alias.as_deref(), "private key passphrase")?,
                resolve(password_alias.as_deref(), "password")?,
            ))
        })
        .await
        .map_err(|error| format!("Managed SSH Secret Store worker failed: {error}"))??;
        Ok(ManagedSshAuthentication {
            private_key: resolved.0.map(|value| Arc::new(Zeroizing::new(value))),
            private_key_passphrase: resolved.1.map(|value| Arc::new(Zeroizing::new(value))),
            password: resolved.2.map(|value| Arc::new(Zeroizing::new(value))),
        })
    }
}

#[async_trait::async_trait]
impl ExecutionTargetBackend for ManagedSshBackend {
    fn kind(&self) -> ExecutionTargetKind {
        ExecutionTargetKind::ManagedSsh
    }

    async fn execute(
        &self,
        context: &TargetExecutionContext,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, TargetExecutionError> {
        if context.target.provider_node_id.is_some() {
            return self.edge.execute(context, tool, arguments).await;
        }
        if managed_ssh_target_uses_host_openssh(&context.target)
            && managed_ssh_target_runtime_host_id(&context.target)
                .is_some_and(|owner| owner != runtime_managed_ssh_host_id())
        {
            return Err(format!(
                "Runtime Managed SSH Target '{}' belongs to a different Runtime host's system OpenSSH environment",
                context.target.id
            )
            .into());
        }
        if context.target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Runtime Managed SSH Target '{}' is currently {} and cannot execute",
                context.target.id,
                context.target.status.as_str()
            )
            .into());
        }
        if !matches!(
            tool.name(),
            "exec" | "read" | "write" | "edit" | "list_files" | "search"
        ) {
            return Err(format!(
                "Managed SSH Target '{}' does not implement the remote execution protocol for tool '{}'",
                context.target.id,
                tool.name()
            )
            .into());
        }
        let route = route_snapshot_from_job(&context.job)?;
        let endpoint_ref = route
            .endpoint_ref
            .as_deref()
            .ok_or("Runtime Managed SSH Route is missing endpoint_ref")?;
        let endpoint = self
            .local_endpoints
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(endpoint_ref)
            .cloned()
            .ok_or_else(|| {
                format!("Runtime has no Managed SSH endpoint '{endpoint_ref}' configured")
            })?;
        if self.approval_required {
            let required_secret_aliases = managed_ssh_endpoint_secret_aliases(&endpoint);
            let approved = crate::permission::CURRENT_DURABLE_APPROVAL
                .try_with(|grant| {
                    grant.as_ref().is_some_and(|grant| {
                        grant.policy_digest == self.permission_policy_digest
                            && grant.requested.network
                            && required_secret_aliases.iter().all(|required| {
                                grant
                                    .requested
                                    .secret_env
                                    .iter()
                                    .any(|name| name == required)
                            })
                            && matches!(
                                &grant.action,
                                ApprovalAction::ToolOperation {
                                    tool,
                                    operation,
                                    ..
                                } if tool == context.job.tool_name.as_str()
                                    && operation == "execute_on_remote_target"
                            )
                    })
                })
                .unwrap_or(false);
            if !approved {
                return Err(
                    "Runtime Managed SSH lacks valid approval or a Capability Lease for the current Target; connection rejected"
                        .into(),
                );
            }
        }
        let authentication = self
            .authentication_for(&endpoint, &context.job, &context.target.id)
            .await?;
        match tool.name() {
            "exec" => {
                let credentials = managed_ssh_credentials(&endpoint, &authentication)?;
                let prepared = build_managed_ssh_exec_arguments(
                    endpoint_ref,
                    &endpoint,
                    &context.target.id,
                    arguments,
                    &credentials,
                )?;
                let result = crate::tool::CURRENT_RUNTIME_MANAGED_SSH
                    .scope(true, tool.execute_result(&prepared))
                    .await;
                if tool_result_is_background(&result) {
                    tokio::spawn(async move {
                        // Password/passphrase authentication uses a 30 second
                        // connect timeout. Keep all ephemeral credential
                        // material alive through the synchronous/background
                        // handoff so a slow connection cannot lose it midway.
                        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
                        drop(credentials);
                    });
                }
                result
            }
            "read" | "write" | "edit" | "list_files" | "search" => {
                execute_managed_ssh_file_tool(
                    &endpoint,
                    &authentication,
                    context.target.workspace_root.as_deref(),
                    tool.name(),
                    arguments,
                    tool.max_model_input_attachment_bytes(),
                )
                .await
            }
            _ => unreachable!("Managed SSH tool support is checked above"),
        }
    }
}

#[async_trait::async_trait]
impl ArtifactTransferExecutionBackend for ManagedSshBackend {
    fn name(&self) -> &'static str {
        "runtime_managed_ssh"
    }

    fn supports(
        &self,
        source: &ExecutionRouteSnapshot,
        destination: &ExecutionRouteSnapshot,
    ) -> bool {
        let supported = |route: &ExecutionRouteSnapshot| {
            route.backend_kind == ExecutionTargetKind::InProcessLocal
                || (route.backend_kind == ExecutionTargetKind::ManagedSsh
                    && route.provider_node_id.is_none())
        };
        supported(source)
            && supported(destination)
            && (source.backend_kind == ExecutionTargetKind::ManagedSsh
                || destination.backend_kind == ExecutionTargetKind::ManagedSsh)
    }

    async fn execute_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        self.authorize_artifact_transfer(routes, request).await?;

        let spool_path = self
            .stages
            .prepare_stage_path(
                &job.id,
                crate::artifact::ArtifactTransferStageKind::RuntimeSource,
            )
            .await?;
        let staged = match routes.source.backend_kind {
            ExecutionTargetKind::InProcessLocal => {
                let source = self.local_transfer_path(
                    &request.source.path,
                    crate::permission::FilesystemAccess::Read,
                )?;
                spool_local_artifact(&source, &spool_path).await?
            }
            ExecutionTargetKind::ManagedSsh => {
                let endpoint = self.endpoint_for_route(&routes.source)?;
                let authentication = self
                    .authentication_for(&endpoint, job, &routes.source.target_id)
                    .await?;
                download_managed_ssh_artifact(
                    &endpoint,
                    &authentication,
                    &request.source.path,
                    &spool_path,
                )
                .await?
            }
            _ => {
                return Err(
                    "Runtime Managed SSH transport received an unsupported source Route".into(),
                )
            }
        };
        if request
            .expected_source_digest
            .as_deref()
            .is_some_and(|expected| expected != staged.logical_digest())
        {
            return Err(format!(
                "Artifact source digest conflict: expected '{}', actual '{}'",
                request
                    .expected_source_digest
                    .as_deref()
                    .unwrap_or_default(),
                staged.logical_digest()
            )
            .into());
        }

        match routes.destination.backend_kind {
            ExecutionTargetKind::InProcessLocal => {
                let destination = self.local_transfer_path(
                    &request.destination.path,
                    crate::permission::FilesystemAccess::Write,
                )?;
                publish_spooled_local_artifact(request, &spool_path, &destination, staged.kind)
                    .await?;
            }
            ExecutionTargetKind::ManagedSsh => {
                let endpoint = self.endpoint_for_route(&routes.destination)?;
                let authentication = self
                    .authentication_for(&endpoint, job, &routes.destination.target_id)
                    .await?;
                upload_managed_ssh_artifact(
                    &endpoint,
                    &authentication,
                    &spool_path,
                    &request.destination.path,
                    request.overwrite,
                    &request.transfer_id,
                    &staged.payload_digest,
                    staged.logical_digest(),
                    staged.kind,
                )
                .await?;
            }
            _ => {
                return Err(
                    "Runtime Managed SSH transport received an unsupported destination Route"
                        .into(),
                )
            }
        }

        let artifact_id = format!("artifact:{}", staged.logical_digest());
        let descriptor =
            |location: crate::artifact::ArtifactLocation| crate::artifact::ArtifactDescriptor {
                artifact_id: artifact_id.clone(),
                location,
                content_digest: Some(staged.logical_digest().to_string()),
                size_bytes: Some(staged.logical_size_bytes()),
                media_type: request.media_type.clone().or_else(|| {
                    (staged.kind == StagedArtifactKind::DirectoryArchive)
                        .then(|| "application/vnd.morphz.directory".to_string())
                }),
                origin: request.origin.clone(),
            };
        let receipt = crate::artifact::ArtifactTransferReceipt {
            transfer_id: request.transfer_id.clone(),
            source: descriptor(request.source.clone()),
            destination: descriptor(request.destination.clone()),
            transport: "runtime_managed_ssh".to_string(),
            bytes_transferred: staged.logical_size_bytes(),
        };
        let _ = self.stages.remove_job(&job.id).await;
        Ok(receipt)
    }
}

impl ManagedSshBackend {
    async fn authorize_artifact_transfer(
        &self,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<(), TargetExecutionError> {
        let mut requested = CapabilityDelta::default();
        if routes.source.backend_kind == ExecutionTargetKind::InProcessLocal {
            extend_local_transfer_delta(
                self.permissions.as_ref(),
                &request.source.path,
                crate::permission::FilesystemAccess::Read,
                &mut requested,
            )?;
        } else {
            requested.network = true;
            requested
                .read_roots
                .push(PathBuf::from(&request.source.path));
        }
        if routes.destination.backend_kind == ExecutionTargetKind::InProcessLocal {
            extend_local_transfer_delta(
                self.permissions.as_ref(),
                &request.destination.path,
                crate::permission::FilesystemAccess::Write,
                &mut requested,
            )?;
        } else {
            requested.network = true;
            requested
                .write_roots
                .push(PathBuf::from(&request.destination.path));
        }
        for route in [&routes.source, &routes.destination] {
            if route.backend_kind != ExecutionTargetKind::ManagedSsh
                || route.provider_node_id.is_some()
            {
                continue;
            }
            let endpoint = self.endpoint_for_route(route)?;
            for alias in managed_ssh_endpoint_secret_aliases(&endpoint) {
                if !requested.secret_env.contains(&alias) {
                    requested.secret_env.push(alias);
                }
            }
        }
        self.permissions
            .authorize_delta(
                ApprovalAction::ToolOperation {
                    tool: crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
                    operation: "transfer".to_string(),
                    target: None,
                },
                requested,
                format!(
                    "Artifact Transfer reads '{}' from Target '{}' and writes '{}' to Target '{}'",
                    request.source.path,
                    request.source.target_id,
                    request.destination.path,
                    request.destination.target_id
                ),
                crate::tool::current_approval_context(),
            )
            .await?;
        Ok(())
    }

    fn local_transfer_path(
        &self,
        path: &str,
        access: crate::permission::FilesystemAccess,
    ) -> Result<PathBuf, TargetExecutionError> {
        match self.permissions.profile().inspect_path(path, access)? {
            crate::permission::PathDecision::Allowed(path)
            | crate::permission::PathDecision::NeedsApproval {
                candidate: path, ..
            } => Ok(path),
            crate::permission::PathDecision::Denied(reason) => Err(reason.into()),
        }
    }

    fn endpoint_for_route(
        &self,
        route: &ExecutionRouteSnapshot,
    ) -> Result<ManagedSshEndpoint, TargetExecutionError> {
        if route.backend_kind != ExecutionTargetKind::ManagedSsh || route.provider_node_id.is_some()
        {
            return Err("Route is not a Runtime Managed SSH endpoint".into());
        }
        let endpoint_ref = route
            .endpoint_ref
            .as_deref()
            .ok_or("Runtime Managed SSH Route is missing endpoint_ref")?;
        let endpoint = self
            .local_endpoints
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(endpoint_ref)
            .cloned()
            .ok_or_else(|| {
                format!("Runtime has no Managed SSH endpoint '{endpoint_ref}' configured")
            })?;
        validate_managed_ssh_endpoint_for_transfer(endpoint_ref, &endpoint)?;
        Ok(endpoint)
    }
}

fn extend_local_transfer_delta(
    permissions: &crate::permission::PermissionBroker,
    path: &str,
    access: crate::permission::FilesystemAccess,
    requested: &mut CapabilityDelta,
) -> Result<(), TargetExecutionError> {
    match permissions.profile().inspect_path(path, access)? {
        crate::permission::PathDecision::Allowed(_) => {}
        crate::permission::PathDecision::Denied(reason) => return Err(reason.into()),
        crate::permission::PathDecision::NeedsApproval {
            resolved_anchor, ..
        } => match access {
            crate::permission::FilesystemAccess::Read => requested.read_roots.push(resolved_anchor),
            crate::permission::FilesystemAccess::Write => {
                requested.write_roots.push(resolved_anchor)
            }
        },
    }
    Ok(())
}

fn validate_managed_ssh_endpoint_for_transfer(
    endpoint_ref: &str,
    endpoint: &ManagedSshEndpoint,
) -> Result<(), TargetExecutionError> {
    validate_endpoint_ref(endpoint_ref)?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!(
            "Managed SSH endpoint '{endpoint_ref}' has not been explicitly approved"
        )
        .into());
    }
    Ok(())
}

fn validate_remote_artifact_path(path: &str) -> Result<(), TargetExecutionError> {
    if path.trim().is_empty() {
        return Err("Remote Artifact path must not be empty".into());
    }
    if path.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r')) {
        return Err("Remote Artifact path must not contain NUL or newline characters".into());
    }
    Ok(())
}

struct PreparedManagedSshCommand {
    command: tokio::process::Command,
    _credentials: ManagedSshCredentialMaterial,
}

fn managed_ssh_posix_remote_command(remote_command: &str) -> String {
    // The SSH server always gives the command string to the account's login
    // shell first. Runtime-generated commands use POSIX syntax, while the
    // account may use fish/csh. Keep the outer command deliberately minimal
    // and enter `sh` explicitly before interpreting any Runtime or user
    // command.
    format!("exec sh -c {}", shell_quote(remote_command))
}

fn managed_ssh_command(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    remote_command: &str,
) -> Result<PreparedManagedSshCommand, TargetExecutionError> {
    endpoint.validate()?;
    let credentials = managed_ssh_credentials(endpoint, authentication)?;
    let mut command = tokio::process::Command::new("ssh");
    if endpoint.destination.is_none() {
        command.arg("-F").arg("/dev/null");
        if credentials.identity.is_none() {
            command.arg("-o").arg("IdentitiesOnly=no");
        }
    }
    credentials.append_identity_to_command(&mut command);
    let mut auth_arguments = Vec::new();
    append_managed_ssh_auth_options(
        &mut auth_arguments,
        endpoint.auth_mode,
        endpoint.private_key_passphrase_secret.is_some(),
    );
    command
        .args(auth_arguments)
        .arg("-o")
        .arg("StrictHostKeyChecking=yes");
    credentials.apply_to_command(&mut command);
    let destination = match endpoint.destination.as_deref() {
        Some(host) => {
            if let Some(user) = endpoint.user.as_deref() {
                command.arg("-l").arg(user);
            }
            command.arg("-p").arg(endpoint.port.to_string());
            host.to_string()
        }
        None => {
            command
                .arg("-o")
                .arg(format!(
                    "UserKnownHostsFile={}",
                    endpoint.known_hosts_file.display()
                ))
                .arg("-p")
                .arg(endpoint.port.to_string());
            endpoint
                .user
                .as_deref()
                .map(|user| format!("{user}@{}", endpoint.host))
                .unwrap_or_else(|| endpoint.host.clone())
        }
    };
    command
        .arg("--")
        .arg(destination)
        .arg(managed_ssh_posix_remote_command(remote_command))
        .kill_on_drop(true);
    Ok(PreparedManagedSshCommand {
        command,
        _credentials: credentials,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum StagedArtifactKind {
    File,
    DirectoryArchive,
}

impl From<StagedArtifactKind> for EdgeArtifactPayloadKind {
    fn from(value: StagedArtifactKind) -> Self {
        match value {
            StagedArtifactKind::File => Self::File,
            StagedArtifactKind::DirectoryArchive => Self::DirectoryArchive,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct StagedArtifact {
    #[serde(alias = "bytes_transferred")]
    payload_size_bytes: u64,
    #[serde(alias = "digest")]
    payload_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logical_size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    logical_digest: Option<String>,
    kind: StagedArtifactKind,
}

impl StagedArtifact {
    fn logical_size_bytes(&self) -> u64 {
        self.logical_size_bytes.unwrap_or(self.payload_size_bytes)
    }

    fn logical_digest(&self) -> &str {
        self.logical_digest
            .as_deref()
            .unwrap_or(&self.payload_digest)
    }
}

fn staged_artifact_metadata_path(spool: &Path) -> PathBuf {
    spool.with_extension("metadata.json")
}

async fn persist_staged_artifact_metadata(
    spool: &Path,
    artifact: &StagedArtifact,
) -> Result<(), TargetExecutionError> {
    let path = staged_artifact_metadata_path(spool);
    let partial = path.with_extension("json.partial");
    tokio::fs::write(&partial, serde_json::to_vec(artifact)?).await?;
    tokio::fs::rename(partial, path).await?;
    Ok(())
}

async fn reusable_staged_artifact(
    spool: &Path,
) -> Result<Option<StagedArtifact>, TargetExecutionError> {
    if !tokio::fs::try_exists(spool).await? {
        return Ok(None);
    }
    let metadata_path = staged_artifact_metadata_path(spool);
    if !tokio::fs::try_exists(&metadata_path).await? {
        // Stages written by an older Runtime did not record their content
        // kind. They cannot be safely interpreted as a directory archive.
        tokio::fs::remove_file(spool).await?;
        return Ok(None);
    }
    let artifact: StagedArtifact = serde_json::from_slice(&tokio::fs::read(&metadata_path).await?)?;
    let (size, digest) = hash_file(spool).await?;
    let directory_identity_available = artifact.kind != StagedArtifactKind::DirectoryArchive
        || (artifact.logical_size_bytes.is_some() && artifact.logical_digest.is_some());
    if size == artifact.payload_size_bytes
        && digest == artifact.payload_digest
        && directory_identity_available
    {
        Ok(Some(artifact))
    } else {
        let _ = tokio::fs::remove_file(spool).await;
        let _ = tokio::fs::remove_file(metadata_path).await;
        Ok(None)
    }
}

async fn spool_local_artifact(
    source: &std::path::Path,
    spool: &std::path::Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    if let Some(artifact) = reusable_staged_artifact(spool).await? {
        return Ok(artifact);
    }
    let metadata = tokio::fs::symlink_metadata(source).await?;
    if metadata.is_dir() {
        return create_canonical_directory_archive(source, spool).await;
    }
    if !metadata.is_file() {
        return Err(format!(
            "Artifact source '{}' is neither a regular file nor a directory",
            source.display()
        )
        .into());
    }
    // A completed deterministic stage is reusable after Runtime restart. The
    // digest check below also protects against partial/foreign contents.
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    let mut reader = tokio::fs::File::open(source).await?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await?;
    crate::artifact::report_artifact_bytes("staging_source", 0, Some(metadata.len()));
    let (size, digest) = copy_and_hash(
        &mut reader,
        &mut writer,
        Some("staging_source"),
        Some(metadata.len()),
    )
    .await?;
    writer.flush().await?;
    writer.sync_data().await?;
    drop(writer);
    tokio::fs::rename(&partial, spool).await?;
    let artifact = StagedArtifact {
        payload_size_bytes: size,
        payload_digest: digest.clone(),
        logical_size_bytes: Some(size),
        logical_digest: Some(digest),
        kind: StagedArtifactKind::File,
    };
    persist_staged_artifact_metadata(spool, &artifact).await?;
    Ok(artifact)
}

async fn download_managed_ssh_artifact(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    remote_path: &str,
    spool: &std::path::Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    validate_remote_artifact_path(remote_path)?;
    if let Some(artifact) = reusable_staged_artifact(spool).await? {
        return Ok(artifact);
    }
    let probe = format!(
        "if test -f {path}; then printf file; elif test -d {path}; then printf directory; else exit 44; fi",
        path = shell_quote_remote_path(remote_path)
    );
    let probe_output = run_managed_ssh_output(endpoint, authentication, &probe).await?;
    if !probe_output.status.success() {
        return Err(format!(
            "Managed SSH Artifact source '{}' does not exist or has an unsupported type",
            remote_path
        )
        .into());
    }
    let kind = match String::from_utf8(probe_output.stdout)?.as_str() {
        "file" => StagedArtifactKind::File,
        "directory" => StagedArtifactKind::DirectoryArchive,
        _ => return Err("Managed SSH Artifact type probe returned an unknown result".into()),
    };
    let remote = match kind {
        StagedArtifactKind::File => {
            format!(
                "set -eu; cat -- {path}",
                path = shell_quote_remote_path(remote_path)
            )
        }
        StagedArtifactKind::DirectoryArchive => format!(
            "set -eu; command -v tar >/dev/null 2>&1; tar -C {path} -cf - .",
            path = shell_quote_remote_path(remote_path)
        ),
    };
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    let mut prepared = managed_ssh_command(endpoint, authentication, &remote)?;
    prepared
        .command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = prepared.command.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("SSH download is missing stdout")?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await?;
    let (size, digest) = copy_and_hash(&mut stdout, &mut writer, Some("downloading"), None).await?;
    writer.flush().await?;
    writer.sync_data().await?;
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "Managed SSH failed to read '{}': {}",
            remote_path,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    match kind {
        StagedArtifactKind::File => {
            tokio::fs::rename(&partial, spool).await?;
            let artifact = StagedArtifact {
                payload_size_bytes: size,
                payload_digest: digest.clone(),
                logical_size_bytes: Some(size),
                logical_digest: Some(digest),
                kind,
            };
            persist_staged_artifact_metadata(spool, &artifact).await?;
            Ok(artifact)
        }
        StagedArtifactKind::DirectoryArchive => {
            // A remote tar stream may contain host-specific metadata/order.
            // Normalize it into the same canonical representation used for a
            // local directory before assigning the Artifact digest.
            let normalized = normalize_directory_archive(&partial, spool).await;
            let _ = tokio::fs::remove_file(&partial).await;
            normalized
        }
    }
}

async fn create_canonical_directory_archive(
    source: &Path,
    spool: &Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    let (logical_size_bytes, logical_digest) =
        crate::artifact::inspect_local_directory_artifact(source).await?;
    let source = source.to_path_buf();
    let partial = spool.with_extension("partial");
    let _ = tokio::fs::remove_file(&partial).await;
    crate::artifact::report_artifact_bytes("archiving_directory", 0, None);
    let build_path = partial.clone();
    tokio::task::spawn_blocking(move || build_canonical_directory_archive(&source, &build_path))
        .await
        .map_err(|error| format!("Artifact-directory archive worker failed: {error}"))??;
    tokio::fs::rename(&partial, spool).await?;
    let (size, digest) = hash_file(spool).await?;
    crate::artifact::report_artifact_bytes("archiving_directory", size, Some(size));
    let artifact = StagedArtifact {
        payload_size_bytes: size,
        payload_digest: digest,
        logical_size_bytes: Some(logical_size_bytes),
        logical_digest: Some(logical_digest),
        kind: StagedArtifactKind::DirectoryArchive,
    };
    persist_staged_artifact_metadata(spool, &artifact).await?;
    Ok(artifact)
}

/// Build the deterministic byte-channel representation of a target-local
/// directory. The returned digest/size describe the archive bytes only; the
/// logical directory digest remains the one produced by the local transfer
/// Tool Receipt.
pub(crate) async fn stage_edge_directory_archive(
    source: &Path,
    spool: &Path,
) -> Result<(u64, String), TargetExecutionError> {
    let artifact = create_canonical_directory_archive(source, spool).await?;
    Ok((artifact.payload_size_bytes, artifact.payload_digest))
}

/// Safely materialize a canonical directory payload before the ordinary
/// target-local transfer Tool runs. Archive entries and symlink targets are
/// validated by `extract_directory_archive`; the caller must still run the
/// normal PermissionBroker for the final source/destination paths.
pub(crate) async fn materialize_edge_directory_archive(
    archive: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let _ = tokio::fs::remove_dir_all(destination).await;
    tokio::fs::create_dir_all(destination).await?;
    let archive = archive.to_path_buf();
    let destination_for_extract = destination.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        extract_directory_archive(&archive, &destination_for_extract)
    })
    .await
    .map_err(|error| format!("Artifact-directory extract worker failed: {error}"))?;
    if let Err(error) = result {
        let _ = tokio::fs::remove_dir_all(destination).await;
        return Err(error);
    }
    Ok(())
}

async fn normalize_directory_archive(
    input: &Path,
    spool: &Path,
) -> Result<StagedArtifact, TargetExecutionError> {
    let tree = spool.with_extension("normalize-tree");
    let _ = tokio::fs::remove_dir_all(&tree).await;
    tokio::fs::create_dir(&tree).await?;
    let input = input.to_path_buf();
    let tree_for_extract = tree.clone();
    let extracted =
        tokio::task::spawn_blocking(move || extract_directory_archive(&input, &tree_for_extract))
            .await
            .map_err(|error| format!("Artifact-directory normalization worker failed: {error}"))?;
    if let Err(error) = extracted {
        let _ = tokio::fs::remove_dir_all(&tree).await;
        return Err(error);
    }
    let result = create_canonical_directory_archive(&tree, spool).await;
    let _ = tokio::fs::remove_dir_all(&tree).await;
    result
}

fn build_canonical_directory_archive(
    source: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let mut entries = walkdir::WalkDir::new(source)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path().cmp(right.path()));
    let output = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut archive = tar::Builder::new(output);
    archive.mode(tar::HeaderMode::Deterministic);
    for entry in entries {
        let relative = entry.path().strip_prefix(source)?;
        validate_archive_relative_path(relative)?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let mut header = tar::Header::new_gnu();
        header.set_path(relative)?;
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        if metadata.is_dir() {
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_size(0);
            header.set_cksum();
            archive.append(&header, std::io::empty())?;
        } else if metadata.is_file() {
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(canonical_file_mode(&metadata));
            header.set_size(metadata.len());
            header.set_cksum();
            let mut file = std::fs::File::open(entry.path())?;
            archive.append(&header, &mut file)?;
        } else if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(entry.path())?;
            validate_archive_link_target(&target)?;
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_mode(0o777);
            header.set_size(0);
            header.set_link_name(target)?;
            header.set_cksum();
            archive.append(&header, std::io::empty())?;
        } else {
            return Err(format!(
                "Artifact directory contains unsupported file type: '{}'",
                entry.path().display()
            )
            .into());
        }
    }
    archive.finish()?;
    let output = archive.into_inner()?;
    output.sync_all()?;
    Ok(())
}

fn extract_directory_archive(
    source: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let file = std::fs::File::open(source)?;
    let mut archive = tar::Archive::new(file);
    archive.set_preserve_permissions(true);
    archive.set_preserve_mtime(false);
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        validate_archive_relative_path(&path)?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
            return Err(format!(
                "Artifact directory archive contains unsupported entry: '{}'",
                path.display()
            )
            .into());
        }
        if kind.is_symlink() {
            let target = entry
                .link_name()?
                .ok_or("Artifact-directory symlink is missing its target")?;
            validate_archive_link_target(&target)?;
        }
        if !entry.unpack_in(destination)? {
            return Err(format!(
                "Artifact-directory archive entry escapes its boundary: '{}'",
                path.display()
            )
            .into());
        }
    }
    Ok(())
}

fn validate_archive_relative_path(path: &Path) -> Result<(), TargetExecutionError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Artifact directory archive path is unsafe: '{}'",
            path.display()
        )
        .into());
    }
    Ok(())
}

fn validate_archive_link_target(path: &Path) -> Result<(), TargetExecutionError> {
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!(
            "Artifact directory symlink target is unsafe: '{}'",
            path.display()
        )
        .into());
    }
    Ok(())
}

#[cfg(unix)]
fn canonical_file_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o111 != 0 {
        0o755
    } else {
        0o644
    }
}

#[cfg(not(unix))]
fn canonical_file_mode(_metadata: &std::fs::Metadata) -> u32 {
    0o644
}

async fn hash_file(path: &std::path::Path) -> Result<(u64, String), TargetExecutionError> {
    let mut reader = tokio::fs::File::open(path).await?;
    let mut sink = tokio::io::sink();
    copy_and_hash(&mut reader, &mut sink, None, None).await
}

async fn copy_and_hash<R, W>(
    reader: &mut R,
    writer: &mut W,
    progress_phase: Option<&str>,
    total_bytes: Option<u64>,
) -> Result<(u64, String), TargetExecutionError>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut hasher = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        writer.write_all(&buffer[..count]).await?;
        hasher.update(&buffer[..count]);
        size = size.saturating_add(count as u64);
        if let Some(phase) = progress_phase {
            crate::artifact::report_artifact_bytes(phase, size, total_bytes);
        }
    }
    Ok((size, format!("sha256:{:x}", hasher.finalize())))
}

async fn publish_spooled_local_artifact(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &std::path::Path,
    destination: &std::path::Path,
    kind: StagedArtifactKind,
) -> Result<(), TargetExecutionError> {
    match kind {
        StagedArtifactKind::File => publish_spooled_local_file(request, spool, destination).await,
        StagedArtifactKind::DirectoryArchive => {
            publish_spooled_local_directory(request, spool, destination).await
        }
    }
}

async fn publish_spooled_local_file(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), TargetExecutionError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact destination has no parent directory")?;
    if !tokio::fs::metadata(parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination parent path '{}' is not a directory",
            parent.display()
        )
        .into());
    }
    if request.overwrite == crate::artifact::ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(destination).await?
    {
        let (_, staged_digest) = hash_file(spool).await?;
        let (_, destination_digest) = hash_file(destination).await?;
        return if staged_digest == destination_digest {
            Ok(())
        } else {
            Err(format!(
                "Artifact destination '{}' already exists with different content",
                destination.display()
            )
            .into())
        };
    }
    let temporary = parent.join(format!(
        ".morphz-transfer-{}-{}.part",
        sanitize_transfer_id(&request.transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    tokio::fs::copy(spool, &temporary).await?;
    let mut cleanup = LocalTransferStagingGuard::new(temporary.clone());
    crate::artifact::mark_artifact_transfer_side_effect().await?;
    match request.overwrite {
        crate::artifact::ArtifactOverwritePolicy::Deny => {
            tokio::fs::hard_link(&temporary, destination).await?;
            tokio::fs::remove_file(&temporary).await?;
        }
        crate::artifact::ArtifactOverwritePolicy::Replace => {
            if cfg!(windows) && tokio::fs::try_exists(destination).await? {
                tokio::fs::remove_file(destination).await?;
            }
            tokio::fs::rename(&temporary, destination).await?;
        }
    }
    cleanup.disarm();
    Ok(())
}

async fn publish_spooled_local_directory(
    request: &crate::artifact::ArtifactTransferRequest,
    spool: &Path,
    destination: &Path,
) -> Result<(), TargetExecutionError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or("Artifact-directory destination has no parent directory")?;
    tokio::fs::create_dir_all(parent).await?;
    if !tokio::fs::metadata(parent).await?.is_dir() {
        return Err(format!(
            "Artifact destination parent path '{}' is not a directory",
            parent.display()
        )
        .into());
    }
    if request.overwrite == crate::artifact::ArtifactOverwritePolicy::Deny
        && tokio::fs::try_exists(destination).await?
    {
        if !tokio::fs::metadata(destination).await?.is_dir() {
            return Err(format!(
                "Artifact destination '{}' already exists and is not a directory",
                destination.display()
            )
            .into());
        }
        let (_, expected) = hash_file(spool).await?;
        let actual = canonical_directory_digest(destination).await?;
        return if actual == expected {
            Ok(())
        } else {
            Err(format!(
                "Artifact directory destination '{}' already exists with different content",
                destination.display()
            )
            .into())
        };
    }

    let temporary = parent.join(format!(
        ".morphz-transfer-{}-{}.tree",
        sanitize_transfer_id(&request.transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    tokio::fs::create_dir(&temporary).await?;
    let mut cleanup = LocalTransferStagingGuard::directory(temporary.clone());
    let archive = spool.to_path_buf();
    let tree = temporary.clone();
    tokio::task::spawn_blocking(move || extract_directory_archive(&archive, &tree))
        .await
        .map_err(|error| format!("Artifact-directory extract worker failed: {error}"))??;
    crate::artifact::report_artifact_bytes("publishing_directory", 1, Some(1));

    crate::artifact::mark_artifact_transfer_side_effect().await?;
    match request.overwrite {
        crate::artifact::ArtifactOverwritePolicy::Deny => {
            tokio::fs::rename(&temporary, destination).await?;
        }
        crate::artifact::ArtifactOverwritePolicy::Replace => {
            if tokio::fs::try_exists(destination).await? {
                let backup = parent.join(format!(
                    ".morphz-transfer-{}-{}.backup",
                    sanitize_transfer_id(&request.transfer_id),
                    Utc::now().timestamp_nanos_opt().unwrap_or_default()
                ));
                tokio::fs::rename(destination, &backup).await?;
                match tokio::fs::rename(&temporary, destination).await {
                    Ok(()) => tokio::fs::remove_dir_all(backup).await?,
                    Err(error) => {
                        let _ = tokio::fs::rename(&backup, destination).await;
                        return Err(error.into());
                    }
                }
            } else {
                tokio::fs::rename(&temporary, destination).await?;
            }
        }
    }
    cleanup.disarm();
    Ok(())
}

async fn canonical_directory_digest(path: &Path) -> Result<String, TargetExecutionError> {
    let parent = path
        .parent()
        .ok_or("Artifact directory has no parent directory")?;
    let archive = parent.join(format!(
        ".morphz-directory-digest-{}.tar",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let source = path.to_path_buf();
    let output = archive.clone();
    tokio::task::spawn_blocking(move || build_canonical_directory_archive(&source, &output))
        .await
        .map_err(|error| format!("Artifact-directory digest worker failed: {error}"))??;
    let result = hash_file(&archive).await.map(|(_, digest)| digest);
    let _ = tokio::fs::remove_file(archive).await;
    result
}

struct LocalTransferStagingGuard {
    path: PathBuf,
    directory: bool,
    armed: bool,
}

impl LocalTransferStagingGuard {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            directory: false,
            armed: true,
        }
    }

    fn directory(path: PathBuf) -> Self {
        Self {
            path,
            directory: true,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for LocalTransferStagingGuard {
    fn drop(&mut self) {
        if self.armed {
            if self.directory {
                let _ = std::fs::remove_dir_all(&self.path);
            } else {
                let _ = std::fs::remove_file(&self.path);
            }
        }
    }
}

// The explicit transfer invariants are deliberately kept visible at this protocol boundary.
#[allow(clippy::too_many_arguments)]
async fn upload_managed_ssh_artifact(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    spool: &std::path::Path,
    remote_path: &str,
    overwrite: crate::artifact::ArtifactOverwritePolicy,
    transfer_id: &str,
    expected_payload_digest: &str,
    logical_digest: &str,
    kind: StagedArtifactKind,
) -> Result<(), TargetExecutionError> {
    validate_remote_artifact_path(remote_path)?;
    let (parent, name) = remote_parent_and_name(remote_path)?;
    let digest_marker = format!("{parent}/.{name}.morphz-artifact-digest");
    if overwrite == crate::artifact::ArtifactOverwritePolicy::Deny {
        let probe = match kind {
            StagedArtifactKind::File => format!(
                "if test -f {path}; then if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; else shasum -a 256 -- {path}; fi; elif test -e {path}; then printf wrong-type; fi",
                path = shell_quote_remote_path(remote_path)
            ),
            StagedArtifactKind::DirectoryArchive => format!(
                "if test -d {path}; then if test -f {marker}; then cat -- {marker}; else printf unknown-directory; fi; elif test -e {path}; then printf wrong-type; fi",
                path = shell_quote_remote_path(remote_path),
                marker = shell_quote_remote_path(&digest_marker)
            ),
        };
        let output = run_managed_ssh_output(endpoint, authentication, &probe).await?;
        if !output.status.success() {
            return Err(format!(
                "Managed SSH failed to inspect destination '{}': {}",
                remote_path,
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        if let Some(value) = String::from_utf8(output.stdout)?.split_whitespace().next() {
            let actual = if kind == StagedArtifactKind::File {
                format!("sha256:{}", value.to_ascii_lowercase())
            } else {
                value.to_string()
            };
            return if actual == logical_digest {
                Ok(())
            } else {
                Err(format!(
                    "Managed SSH destination '{}' already exists with different content",
                    remote_path
                )
                .into())
            };
        }
    }
    let temporary = format!(
        "{parent}/.morphz-transfer-{}-{}.part",
        sanitize_transfer_id(transfer_id),
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let upload = format!(
        "set -eu; test -d {parent}; umask 077; trap 'rm -f -- {tmp}' EXIT HUP INT TERM; cat > {tmp}; trap - EXIT HUP INT TERM",
        parent = shell_quote_remote_path(parent),
        tmp = shell_quote_remote_path(&temporary),
    );
    let mut prepared = managed_ssh_command(endpoint, authentication, &upload)?;
    prepared
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = prepared.command.spawn()?;
    let mut stdin = child.stdin.take().ok_or("SSH upload is missing stdin")?;
    let mut reader = tokio::fs::File::open(spool).await?;
    let total_bytes = tokio::fs::metadata(spool).await?.len();
    crate::artifact::report_artifact_bytes("uploading", 0, Some(total_bytes));
    let mut sent = 0_u64;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        stdin.write_all(&buffer[..count]).await?;
        sent = sent.saturating_add(count as u64);
        crate::artifact::report_artifact_bytes("uploading", sent, Some(total_bytes));
    }
    stdin.shutdown().await?;
    drop(stdin);
    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH failed to write temporary Artifact '{}': {}",
            remote_path,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let mut cleanup = RemoteTransferStagingGuard::new(
        endpoint.clone(),
        authentication.clone(),
        temporary.clone(),
    );
    let verified = remote_file_digest(endpoint, authentication, &temporary).await?;
    if verified != expected_payload_digest {
        return Err(format!(
            "Managed SSH destination digest validation failed: expected '{}', actual '{}'",
            expected_payload_digest, verified
        )
        .into());
    }
    let publish = match (kind, overwrite) {
        (StagedArtifactKind::File, crate::artifact::ArtifactOverwritePolicy::Deny) => format!(
            "set -eu; ln -- {tmp} {dest}; rm -f -- {tmp}",
            tmp = shell_quote_remote_path(&temporary),
            dest = shell_quote_remote_path(remote_path)
        ),
        (StagedArtifactKind::File, crate::artifact::ArtifactOverwritePolicy::Replace) => format!(
            "set -eu; mv -f -- {tmp} {dest}",
            tmp = shell_quote_remote_path(&temporary),
            dest = shell_quote_remote_path(remote_path)
        ),
        (StagedArtifactKind::DirectoryArchive, overwrite) => {
            let temporary_tree = format!("{temporary}.tree");
            let marker_partial = format!("{temporary}.digest");
            let backup = format!("{temporary}.backup");
            let prepublish = format!(
                "command -v tar >/dev/null 2>&1; rm -rf -- {tree} {backup}; mkdir -- {tree}; tar -xf {tmp} -C {tree}; printf '%s\\n' {digest} > {marker_partial}",
                tree = shell_quote_remote_path(&temporary_tree),
                backup = shell_quote_remote_path(&backup),
                tmp = shell_quote_remote_path(&temporary),
                digest = shell_quote(logical_digest),
                marker_partial = shell_quote_remote_path(&marker_partial),
            );
            match overwrite {
                crate::artifact::ArtifactOverwritePolicy::Deny => format!(
                    "set -eu; test ! -e {dest}; {prepublish}; trap 'rm -rf -- {tree} {backup}; rm -f -- {tmp} {marker_partial}; if test ! -d {dest}; then rm -f -- {marker}; fi' EXIT HUP INT TERM; mv -- {marker_partial} {marker}; mv -- {tree} {dest}; rm -f -- {tmp}; trap - EXIT HUP INT TERM",
                    dest = shell_quote_remote_path(remote_path),
                    tree = shell_quote_remote_path(&temporary_tree),
                    backup = shell_quote_remote_path(&backup),
                    tmp = shell_quote_remote_path(&temporary),
                    marker_partial = shell_quote_remote_path(&marker_partial),
                    marker = shell_quote_remote_path(&digest_marker),
                ),
                crate::artifact::ArtifactOverwritePolicy::Replace => format!(
                    "set -eu; {prepublish}; trap 'rm -rf -- {tree}; rm -f -- {tmp} {marker_partial}; if test -e {backup} && test ! -e {dest}; then mv -- {backup} {dest}; fi' EXIT HUP INT TERM; if test -e {dest}; then mv -- {dest} {backup}; fi; mv -- {marker_partial} {marker}; mv -- {tree} {dest}; rm -rf -- {backup}; rm -f -- {tmp}; trap - EXIT HUP INT TERM",
                    tree = shell_quote_remote_path(&temporary_tree),
                    tmp = shell_quote_remote_path(&temporary),
                    marker_partial = shell_quote_remote_path(&marker_partial),
                    backup = shell_quote_remote_path(&backup),
                    dest = shell_quote_remote_path(remote_path),
                    marker = shell_quote_remote_path(&digest_marker),
                ),
            }
        }
    };
    crate::artifact::mark_artifact_transfer_side_effect().await?;
    let output = run_managed_ssh_output(endpoint, authentication, &publish).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH failed to atomically publish '{}' (parent '{}', file '{}'): {}",
            remote_path,
            parent,
            name,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    cleanup.disarm();
    Ok(())
}

fn remote_parent_and_name(path: &str) -> Result<(&str, &str), TargetExecutionError> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Remote Artifact destination cannot be the root directory".into());
    }
    match trimmed.rsplit_once('/') {
        Some(("", name)) if !name.is_empty() => Ok(("/", name)),
        Some((parent, name)) if !parent.is_empty() && !name.is_empty() => Ok((parent, name)),
        None => Ok((".", trimmed)),
        _ => Err("Remote Artifact destination has no valid file name".into()),
    }
}

fn sanitize_transfer_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(96)
        .collect()
}

async fn remote_file_digest(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    path: &str,
) -> Result<String, TargetExecutionError> {
    let command = format!(
        "set -eu; if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {path}; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -- {path}; else exit 127; fi",
        path = shell_quote_remote_path(path)
    );
    let output = run_managed_ssh_output(endpoint, authentication, &command).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH remote has no usable SHA-256 tool or digest computation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let hex = String::from_utf8(output.stdout)?
        .split_whitespace()
        .next()
        .ok_or("Managed SSH SHA-256 output is empty")?
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Managed SSH SHA-256 output has an invalid format".into());
    }
    Ok(format!("sha256:{hex}"))
}

async fn run_managed_ssh_output(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    remote_command: &str,
) -> Result<std::process::Output, TargetExecutionError> {
    let mut prepared = managed_ssh_command(endpoint, authentication, remote_command)?;
    prepared
        .command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(prepared.command.output().await?)
}

/// Small provider-side protocol for the core file tools. The program is sent
/// as an OpenSSH command while the model-authored arguments travel over stdin
/// as JSON, so paths and file contents never become shell syntax.
const MANAGED_SSH_FILE_TOOL_SCRIPT: &str = r#"
import fnmatch
import base64
import hashlib
import json
import os
import pathlib
import sys
import tempfile

def emit(ok, output=None, error=None):
    print(json.dumps({"ok": ok, "output": output, "error": error}, ensure_ascii=False))

def resolve_path(value, workspace_root):
    path = os.path.expanduser(value)
    if not os.path.isabs(path) and workspace_root:
        path = os.path.join(workspace_root, path)
    return os.path.abspath(path)

def path_matches(relative, pattern):
    relative = relative.replace(os.sep, "/")
    if pattern in ("*", "**/*"):
        return True
    pure = pathlib.PurePosixPath(relative)
    return pure.match(pattern) or fnmatch.fnmatch(relative, pattern) or (
        pattern.startswith("**/") and fnmatch.fnmatch(relative, pattern[3:])
    )

def read_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    if not os.path.exists(path):
        return "System error: read failed because file path '{}' does not exist; verify the path.".format(original)
    with open(path, "rb") as handle:
        header = handle.read(12)
    media_type = None
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        media_type = "image/png"
    elif header.startswith(b"\xff\xd8\xff"):
        media_type = "image/jpeg"
    elif header.startswith(b"GIF87a") or header.startswith(b"GIF89a"):
        media_type = "image/gif"
    elif len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        media_type = "image/webp"
    max_attachment_bytes = request.get("max_model_input_attachment_bytes")
    if media_type is not None and max_attachment_bytes is not None:
        size_bytes = os.path.getsize(path)
        if size_bytes > max_attachment_bytes:
            raise ValueError(
                "image '{}' is {} bytes, exceeding the current per-file model input limit of {} bytes".format(
                    original, size_bytes, max_attachment_bytes
                )
            )
    with open(path, "rb") as handle:
        data = handle.read()
    digest = hashlib.sha256(data).hexdigest()
    if media_type is not None:
        if any(args.get(name) is not None for name in (
            "start_line", "end_line", "query", "context_lines", "max_matches"
        )):
            raise ValueError("image read does not accept line numbers or query; provide path only")
        if max_attachment_bytes is not None and len(data) > max_attachment_bytes:
            raise ValueError(
                "image '{}' is {} bytes, exceeding the current per-file model input limit of {} bytes".format(
                    original, len(data), max_attachment_bytes
                )
            )
        name = os.path.basename(path) or "image"
        result = {
            "kind": "model_visible_artifact",
            "status": "loaded",
            "path": original,
            "name": name,
            "media_type": media_type,
            "size_bytes": len(data),
            "sha256": digest,
        }
        return json.dumps({
            "_morphz_tool_result": {
                "version": 1,
                "text": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
                "model_attachments": [{
                    "name": name,
                    "media_type": media_type,
                    "data_base64": base64.b64encode(data).decode("ascii"),
                }],
            }
        }, ensure_ascii=False, separators=(",", ":"))
    text = data.decode("utf-8")
    header = "[path={}, bytes={}, sha256={}]\n".format(original, len(data), digest)
    if args.get("query") is None and args.get("start_line") is None and args.get("end_line") is None:
        return header + text

    lines = text.splitlines()
    total = len(lines)
    start = args.get("start_line") or 1
    end = min(args.get("end_line") or total, total)
    if start == 0 or (total > 0 and start > total) or end < start:
        raise ValueError("invalid line range: start_line={}, end_line={}, total lines={}".format(start, end, total))
    selected = set()
    query = args.get("query")
    match_count = 0
    shown_matches = 0
    if query is not None:
        query = query.strip()
        if not query:
            raise ValueError("query must not be empty")
        needle = query.lower()
        context = min(args.get("context_lines", 3), 20)
        max_matches = min(max(args.get("max_matches", 20), 1), 100)
        for line_number in range(start, end + 1):
            if needle in lines[line_number - 1].lower():
                match_count += 1
                if shown_matches < max_matches:
                    shown_matches += 1
                    context_start = max(start, line_number - context)
                    context_end = min(end, line_number + context)
                    selected.update(range(context_start, context_end + 1))
        body = "[query={}, matches={}, shown={}, lines={}..{}, total-lines={}]\n".format(
            json.dumps(query, ensure_ascii=False), match_count, shown_matches, start, end, total
        )
    else:
        if total > 0:
            selected.update(range(start, end + 1))
        body = "[lines={}..{}, total-lines={}]\n".format(start, end, total)
    for line_number in sorted(selected):
        body += "{:>6} | {}\n".format(line_number, lines[line_number - 1])
    return header + body

def write_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    content = args["content"]
    data = content.encode("utf-8")
    mode = args["mode"]
    current_mode = None
    if mode == "create":
        if os.path.exists(path):
            raise ValueError("create refuses to overwrite existing file '{}'; read it first, then use edit or overwrite".format(original))
        operation = "create"
    elif mode == "overwrite":
        if not os.path.exists(path):
            raise ValueError("overwrite target '{}' does not exist; use mode=create for a new file".format(original))
        with open(path, "rb") as handle:
            before = handle.read()
        current = hashlib.sha256(before).hexdigest()
        expected = args.get("expected_sha256")
        if not expected:
            raise ValueError("overwrite requires expected_sha256 from the most recent read")
        if expected != current:
            raise ValueError("file version conflict: '{}' current sha256={}, expected_sha256={}. Read the file again before modifying it".format(original, current, expected))
        current_mode = os.stat(path).st_mode & 0o7777
        operation = "overwrite"
    else:
        raise ValueError("write.mode supports only create or overwrite; received '{}'".format(mode))

    parent = os.path.dirname(path) or "."
    if not os.path.isdir(parent):
        raise ValueError("parent directory '{}' does not exist".format(parent))
    descriptor, temporary = tempfile.mkstemp(prefix=".morphz-write-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if current_mode is not None:
            os.chmod(temporary, current_mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    digest = hashlib.sha256(data).hexdigest()
    return "file written: operation={} path={} bytes={} sha256={}".format(operation, original, len(data), digest)

def edit_tool(args, workspace_root):
    original = args["path"]
    path = resolve_path(original, workspace_root)
    if not os.path.isfile(path):
        raise ValueError("edit target '{}' does not exist or is not a file".format(original))
    with open(path, "rb") as handle:
        before = handle.read()
    digest = hashlib.sha256(before).hexdigest()
    expected = args.get("expected_sha256")
    if expected != digest:
        raise ValueError("file version conflict: '{}' current sha256={}, expected_sha256={}. Read the file again before editing it".format(original, digest, expected))
    text = before.decode("utf-8")
    edits = args.get("edits") or []
    if not edits:
        raise ValueError("edit.edits requires at least one item")
    replacements = []
    for index, edit in enumerate(edits):
        old = edit.get("old_text", "")
        new = edit.get("new_text", "")
        if not old:
            raise ValueError("edit.edits[{}].old_text must not be empty".format(index))
        starts = []
        cursor = 0
        while True:
            found = text.find(old, cursor)
            if found < 0:
                break
            starts.append(found)
            cursor = found + len(old)
        if not starts:
            raise ValueError("edit.edits[{}].old_text has no exact match in '{}'; read the file again with more context".format(index, original))
        replace_all = bool(edit.get("replace_all", False))
        if not replace_all and len(starts) != 1:
            raise ValueError("edit.edits[{}].old_text matches {} times; provide more context or set replace_all=true".format(index, len(starts)))
        for start in starts if replace_all else starts[:1]:
            replacements.append((start, start + len(old), new))
    replacements.sort(key=lambda item: item[0])
    for left, right in zip(replacements, replacements[1:]):
        if left[1] > right[0]:
            raise ValueError("two edit replacement ranges overlap; merge them into one larger exact replacement")
    parts = []
    cursor = 0
    for start, end, new in replacements:
        parts.append(text[cursor:start])
        parts.append(new)
        cursor = end
    parts.append(text[cursor:])
    updated = "".join(parts)
    if updated == text:
        raise ValueError("edit produced no content change")
    data = updated.encode("utf-8")
    parent = os.path.dirname(path) or "."
    descriptor, temporary = tempfile.mkstemp(prefix=".morphz-edit-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, os.stat(path).st_mode & 0o7777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    after_digest = hashlib.sha256(data).hexdigest()
    return "file edited: path={} replacements={} bytes={} sha256={}".format(original, len(replacements), len(data), after_digest)

def list_files_tool(args, workspace_root):
    original = args.get("path", ".")
    root = resolve_path(original, workspace_root)
    if not os.path.isdir(root):
        raise ValueError("list_files.path '{}' is not a directory".format(original))
    pattern = args.get("glob", "**/*")
    limit = min(max(args.get("max_results", 500), 1), 2000)
    include_hidden = bool(args.get("include_hidden", False))
    include_directories = bool(args.get("include_directories", False))
    entries = []
    truncated = False
    for directory, directories, files in os.walk(root, followlinks=False):
        if not include_hidden:
            directories[:] = sorted(name for name in directories if not name.startswith("."))
            files = [name for name in files if not name.startswith(".")]
        else:
            directories.sort()
        candidates = []
        if include_directories:
            candidates.extend((os.path.join(directory, name), "dir") for name in directories)
        candidates.extend((os.path.join(directory, name), "file") for name in sorted(files))
        for path, kind in candidates:
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            if not path_matches(relative, pattern):
                continue
            if len(entries) == limit:
                truncated = True
                break
            size = os.path.getsize(path) if kind == "file" else None
            entries.append({"path": relative, "kind": kind, "bytes": size})
        if truncated:
            break
    return json.dumps({"root": original, "glob": pattern, "count": len(entries), "truncated": truncated, "entries": entries}, ensure_ascii=False, indent=2)

def search_tool(args, workspace_root):
    query = args["query"].strip()
    if not query:
        raise ValueError("search.query must not be empty")
    inputs = args.get("paths") or []
    if not inputs:
        raise ValueError("search.paths requires at least one path")
    pattern = args.get("glob", "**/*")
    limit = min(max(args.get("max_matches", 100), 1), 1000)
    context_lines = min(max(args.get("context_lines", 2), 0), 20)
    case_sensitive = bool(args.get("case_sensitive", False))
    include_hidden = bool(args.get("include_hidden", False))
    needle = query if case_sensitive else query.lower()
    matches = []
    truncated = False

    for original in inputs:
        root = resolve_path(original, workspace_root)
        if os.path.isfile(root):
            candidates = [(root, os.path.basename(root))]
        elif os.path.isdir(root):
            candidates = []
            for directory, directories, files in os.walk(root, followlinks=False):
                if not include_hidden:
                    directories[:] = sorted(name for name in directories if not name.startswith("."))
                    files = [name for name in files if not name.startswith(".")]
                else:
                    directories.sort()
                for name in sorted(files):
                    path = os.path.join(directory, name)
                    candidates.append((path, os.path.relpath(path, root)))
        else:
            raise ValueError("search path '{}' does not exist".format(original))

        for path, relative in candidates:
            if not path_matches(relative, pattern):
                continue
            try:
                if os.path.getsize(path) > 2 * 1024 * 1024:
                    continue
                with open(path, "r", encoding="utf-8") as handle:
                    lines = handle.read().splitlines()
            except (OSError, UnicodeError):
                continue
            for index, line in enumerate(lines):
                haystack = line if case_sensitive else line.lower()
                if needle not in haystack:
                    continue
                if len(matches) == limit:
                    truncated = True
                    break
                number = index + 1
                start = max(1, number - context_lines)
                end = min(len(lines), number + context_lines)
                display_path = original if os.path.isfile(root) else original.rstrip("/") + "/" + relative.replace(os.sep, "/")
                matches.append({
                    "path": display_path,
                    "line": number,
                    "context": [{"line": row, "text": lines[row - 1]} for row in range(start, end + 1)],
                })
            if truncated:
                break
        if truncated:
            break
    return json.dumps({"query": args["query"], "count": len(matches), "truncated": truncated, "matches": matches}, ensure_ascii=False, indent=2)

try:
    request = json.load(sys.stdin)
    operation = request["operation"]
    arguments = request["arguments"]
    workspace_root = request.get("workspace_root")
    if operation == "read":
        result = read_tool(arguments, workspace_root)
    elif operation == "write":
        result = write_tool(arguments, workspace_root)
    elif operation == "edit":
        result = edit_tool(arguments, workspace_root)
    elif operation == "list_files":
        result = list_files_tool(arguments, workspace_root)
    elif operation == "search":
        result = search_tool(arguments, workspace_root)
    else:
        raise ValueError("unsupported Managed SSH core tool '{}'".format(operation))
    emit(True, output=result)
except Exception as error:
    emit(False, error="{}: {}".format(type(error).__name__, error))
"#;

async fn execute_managed_ssh_file_tool(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    workspace_root: Option<&str>,
    operation: &str,
    arguments: &str,
    max_model_input_attachment_bytes: Option<usize>,
) -> Result<Box<ToolExecutionResult>, TargetExecutionError> {
    let arguments: serde_json::Value = serde_json::from_str(arguments)?;
    let request = serde_json::to_vec(&serde_json::json!({
        "operation": operation,
        "arguments": arguments,
        "workspace_root": workspace_root,
        "max_model_input_attachment_bytes": max_model_input_attachment_bytes,
    }))?;
    let command = managed_ssh_file_tool_command();
    let output =
        run_managed_ssh_output_with_input(endpoint, authentication, &command, &request).await?;
    if !output.status.success() {
        return Err(format!(
            "Managed SSH tool '{}' failed: {}",
            operation,
            String::from_utf8_lossy(&output.stderr).trim()
        )
        .into());
    }
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "Managed SSH tool '{}' returned an invalid protocol envelope: {error}; stdout={}; stderr={}",
            operation,
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    if envelope.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(ToolExecutionResult::decode_transport(
            envelope
                .get("output")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ));
    }
    Err(format!(
        "Managed SSH tool '{}' was rejected by the remote: {}",
        operation,
        envelope
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown error")
    )
    .into())
}

fn managed_ssh_file_tool_command() -> String {
    let script = shell_quote(MANAGED_SSH_FILE_TOOL_SCRIPT);
    format!(
        "if command -v python3 >/dev/null 2>&1; then exec python3 -c {script}; elif command -v python >/dev/null 2>&1; then exec python -c {script}; else echo 'Managed SSH Target requires Python 3 to execute core file tools' >&2; exit 127; fi"
    )
}

async fn run_managed_ssh_output_with_input(
    endpoint: &ManagedSshEndpoint,
    authentication: &ManagedSshAuthentication,
    remote_command: &str,
    input: &[u8],
) -> Result<std::process::Output, TargetExecutionError> {
    let mut prepared = managed_ssh_command(endpoint, authentication, remote_command)?;
    prepared
        .command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = prepared.command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("Failed to open Managed SSH stdin")?;
    stdin.write_all(input).await?;
    stdin.shutdown().await?;
    drop(stdin);
    Ok(child.wait_with_output().await?)
}

struct RemoteTransferStagingGuard {
    endpoint: ManagedSshEndpoint,
    authentication: ManagedSshAuthentication,
    path: String,
    armed: bool,
}

impl RemoteTransferStagingGuard {
    fn new(
        endpoint: ManagedSshEndpoint,
        authentication: ManagedSshAuthentication,
        path: String,
    ) -> Self {
        Self {
            endpoint,
            authentication,
            path,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RemoteTransferStagingGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let endpoint = self.endpoint.clone();
        let authentication = self.authentication.clone();
        let command = format!("rm -f -- {}", shell_quote_remote_path(&self.path));
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = run_managed_ssh_output(&endpoint, &authentication, &command).await;
            });
        }
    }
}

/// Backend-neutral authority used at the physical side-effect boundary.
/// Selection is deterministic by the Target's persisted kind; it never falls
/// back to another Target when the requested destination is unavailable.
pub struct ExecutionTargetDispatcher {
    targets: Arc<dyn ExecutionTargetStore>,
    authorizations: Arc<dyn ExecutionTargetAuthorizationStore>,
    backends: RwLock<HashMap<ExecutionTargetKind, Arc<dyn ExecutionTargetBackend>>>,
    artifact_transfer_backends: RwLock<HashMap<String, Arc<dyn ArtifactTransferExecutionBackend>>>,
}

impl ExecutionTargetDispatcher {
    pub fn new(
        targets: Arc<dyn ExecutionTargetStore>,
        authorizations: Arc<dyn ExecutionTargetAuthorizationStore>,
    ) -> Self {
        Self {
            targets,
            authorizations,
            backends: RwLock::new(HashMap::new()),
            artifact_transfer_backends: RwLock::new(HashMap::new()),
        }
    }

    pub fn register_backend(&self, backend: Arc<dyn ExecutionTargetBackend>) {
        self.backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.kind(), backend);
    }

    pub fn register_artifact_transfer_backend(
        &self,
        backend: Arc<dyn ArtifactTransferExecutionBackend>,
    ) {
        self.artifact_transfer_backends
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(backend.name().to_string(), backend);
    }

    pub async fn execute(
        &self,
        job: &ExecutionJobRecord,
        tool: Arc<dyn Tool>,
        arguments: &str,
    ) -> Result<Box<ToolExecutionResult>, TargetExecutionError> {
        let route = route_snapshot_from_job(job)?;
        if tool.execution_routing() == ToolExecutionRouting::ArtifactTransfer {
            let routes = artifact_transfer_routes_from_job(job)?;
            let transfer = crate::artifact::transfer_request_from_tool_arguments(
                arguments,
                format!("transfer:{}", job.id),
            )?;
            if transfer.source.target_id != routes.source.target_id
                || transfer.destination.target_id != routes.destination.target_id
            {
                return Err("Artifact Transfer arguments do not match the pair of Routes frozen in the Execution Job".into());
            }
            let source = self
                .authorized_target_for_route(
                    &routes.source,
                    job.initiating_principal_id.as_deref(),
                    &job.agent_id,
                    &job.context_id,
                    &job.thread_id,
                )
                .await?;
            let destination = self
                .authorized_target_for_route(
                    &routes.destination,
                    job.initiating_principal_id.as_deref(),
                    &job.agent_id,
                    &job.context_id,
                    &job.thread_id,
                )
                .await?;
            if let Some(backend) = self.artifact_transfer_backend_for(&routes) {
                let receipt = backend.execute_transfer(job, &routes, &transfer).await?;
                receipt.validate_against(&transfer)?;
                return Ok(ToolExecutionResult::text(serde_json::to_string(&receipt)?));
            }
            if routes.source.target_id != routes.destination.target_id {
                return Err(format!(
                    "no Runtime Artifact Transport can handle the frozen Route from '{}' to '{}' ({} -> {})",
                    source.id,
                    destination.id,
                    routes.source.backend_kind.as_str(),
                    routes.destination.backend_kind.as_str()
                )
                .into());
            }
        }
        let mut target = self
            .targets
            .get_execution_target(&job.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' does not exist", job.target_id))?;
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!("Execution Target '{}' is disabled", target.id).into());
        }
        self.ensure_target_authorized(
            &target,
            job.initiating_principal_id.as_deref(),
            &job.agent_id,
            &job.context_id,
            &job.thread_id,
        )
        .await?;
        target.provider_node_id = route.provider_node_id;
        target.kind = route.backend_kind;
        target.policy_digest = route.policy_digest;
        let backend = self.backend_for(&target)?;
        backend
            .execute(
                &TargetExecutionContext {
                    target,
                    job: job.clone(),
                },
                tool,
                arguments,
            )
            .await
    }

    /// Node-local Artifact execution after the cloud's frozen dual Route has
    /// already been authenticated and localized by the Edge control plane.
    /// This deliberately skips the cloud Target registry: a Provider Node may
    /// own private Managed SSH endpoint descriptors which are not materialized
    /// as local Target rows. Backend permission checks still run normally.
    pub(crate) async fn execute_edge_artifact_transfer(
        &self,
        job: &ExecutionJobRecord,
        routes: &ArtifactTransferRouteSnapshot,
        request: &crate::artifact::ArtifactTransferRequest,
    ) -> Result<crate::artifact::ArtifactTransferReceipt, TargetExecutionError> {
        request.validate()?;
        if request.source.target_id != routes.source.target_id
            || request.destination.target_id != routes.destination.target_id
        {
            return Err(
                "Edge-localized Artifact request does not match the frozen pair of Routes".into(),
            );
        }
        let backend = self.artifact_transfer_backend_for(routes).ok_or(
            "Edge Runtime has no Artifact Backend capable of handling the localized pair of Routes",
        )?;
        let receipt = backend.execute_transfer(job, routes, request).await?;
        receipt.validate_against(request)?;
        Ok(receipt)
    }

    // Identity and causal coordinates remain separate so authorization cannot accidentally reuse
    // an ambient route.
    #[allow(clippy::too_many_arguments)]
    pub async fn validate_for_tool(
        &self,
        target_id: &str,
        tool_name: &str,
        arguments: &str,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let target = self
            .targets
            .get_execution_target(target_id)
            .await?
            .ok_or_else(|| -> TargetExecutionError {
                if target_id == DEFAULT_EXECUTION_TARGET_ID {
                    Box::new(ExecutionTargetRequired)
                } else {
                    format!("Execution Target '{target_id}' does not exist").into()
                }
            })?;
        self.ensure_target_authorized(&target, principal_id, agent_id, context_id, thread_id)
            .await?;
        let durable_offline_queue = target.status == ExecutionTargetStatus::Offline
            && (target.kind == ExecutionTargetKind::EdgeNode
                || (target.kind == ExecutionTargetKind::ManagedSsh
                    && target.provider_node_id.is_some()));
        if !target.status.accepts_jobs() && !durable_offline_queue {
            if target.id == DEFAULT_EXECUTION_TARGET_ID {
                return Err(Box::new(ExecutionTargetRequired));
            }
            return Err(format!(
                "Execution Target '{}' is currently {} and cannot execute a new action",
                target.id,
                target.status.as_str()
            )
            .into());
        }
        if !target.capabilities.iter().any(|name| name == tool_name) {
            return Err(format!(
                "Execution Target '{}' has not published tool capability '{}'",
                target.id, tool_name
            )
            .into());
        }
        if target.kind == ExecutionTargetKind::InProcessLocal {
            reject_unmanaged_ssh_invocation(&target.id, tool_name, arguments)?;
        }
        self.backend_for(&target)?;
        Ok(target)
    }

    pub async fn validate_artifact_transfer(
        &self,
        request: &crate::artifact::ArtifactTransferRequest,
        arguments: &str,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<(ExecutionTargetRecord, ExecutionTargetRecord), TargetExecutionError> {
        request.validate()?;
        let source = self
            .validate_for_tool(
                &request.source.target_id,
                crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME,
                arguments,
                principal_id,
                agent_id,
                context_id,
                thread_id,
            )
            .await?;
        let destination = if request.destination.target_id == request.source.target_id {
            source.clone()
        } else {
            self.validate_for_tool(
                &request.destination.target_id,
                crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME,
                arguments,
                principal_id,
                agent_id,
                context_id,
                thread_id,
            )
            .await?
        };
        Ok((source, destination))
    }

    async fn ensure_target_authorized(
        &self,
        target: &ExecutionTargetRecord,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<(), TargetExecutionError> {
        ensure_target_authorized_for_principal(target, principal_id)?;
        let Some(owner) = target.owner_principal_id.as_deref() else {
            return Ok(());
        };
        if !self
            .authorizations
            .has_execution_target_authorization_history(&target.id)
            .await?
        {
            return Ok(());
        }
        let matches = self
            .authorizations
            .has_active_execution_target_authorization(
                &target.id, owner, agent_id, context_id, thread_id,
            )
            .await?;
        if !matches {
            return Err(format!(
                "Execution Target '{}' is in scoped authorization mode, but the current Agent/Context/Thread has no valid authorization",
                target.id
            )
            .into());
        }
        Ok(())
    }

    async fn authorized_target_for_route(
        &self,
        route: &ExecutionRouteSnapshot,
        principal_id: Option<&str>,
        agent_id: &str,
        context_id: &str,
        thread_id: &str,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let mut target = self
            .targets
            .get_execution_target(&route.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' does not exist", route.target_id))?;
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!("Execution Target '{}' is disabled", target.id).into());
        }
        self.ensure_target_authorized(&target, principal_id, agent_id, context_id, thread_id)
            .await?;
        target.provider_node_id = route.provider_node_id.clone();
        target.kind = route.backend_kind;
        target.policy_digest = route.policy_digest.clone();
        Ok(target)
    }

    fn artifact_transfer_backend_for(
        &self,
        routes: &ArtifactTransferRouteSnapshot,
    ) -> Option<Arc<dyn ArtifactTransferExecutionBackend>> {
        let backends = self
            .artifact_transfer_backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut names = backends.keys().cloned().collect::<Vec<_>>();
        names.sort();
        names.into_iter().find_map(|name| {
            backends
                .get(&name)
                .filter(|backend| backend.supports(&routes.source, &routes.destination))
                .cloned()
        })
    }

    fn backend_for(
        &self,
        target: &ExecutionTargetRecord,
    ) -> Result<Arc<dyn ExecutionTargetBackend>, TargetExecutionError> {
        let backend = self
            .backends
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&target.kind)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Backend '{}' for Execution Target '{}' is not registered",
                    target.kind.as_str(),
                    target.id,
                )
            })?;
        Ok(backend)
    }
}

fn exec_arguments_invoke_ssh(arguments: &str) -> Result<bool, TargetExecutionError> {
    let value: serde_json::Value = serde_json::from_str(arguments)?;
    let command = value
        .as_object()
        .and_then(|object| object.get("command"))
        .and_then(serde_json::Value::as_str)
        .ok_or("exec arguments are missing command")?;
    Ok(shell_command_programs(command).iter().any(|program| {
        PathBuf::from(program)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "ssh" | "scp" | "sftp"))
    }))
}

pub fn reject_unmanaged_ssh_invocation(
    target_id: &str,
    tool_name: &str,
    arguments: &str,
) -> Result<(), TargetExecutionError> {
    if target_id == DEFAULT_EXECUTION_TARGET_ID
        && tool_name == "exec"
        && exec_arguments_invoke_ssh(arguments)?
    {
        return Err(
            "Agent may not invoke ssh/scp/sftp directly through local exec; select a managed_ssh Execution Target first"
                .into(),
        );
    }
    Ok(())
}

fn shell_command_programs(command: &str) -> Vec<String> {
    let mut programs = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut command_position = true;
    let mut wrapper = false;
    let mut command_builtin = false;
    let finish_token = |token: &mut String,
                        programs: &mut Vec<String>,
                        command_position: &mut bool,
                        wrapper: &mut bool,
                        command_builtin: &mut bool| {
        if token.is_empty() {
            return;
        }
        if *command_position {
            let value = std::mem::take(token);
            let assignment = value
                .split_once('=')
                .is_some_and(|(name, _)| !name.is_empty() && !name.contains('/'));
            let wrapper_word = matches!(
                value.as_str(),
                "command"
                    | "exec"
                    | "env"
                    | "sudo"
                    | "nohup"
                    | "time"
                    | "if"
                    | "then"
                    | "do"
                    | "while"
                    | "until"
                    | "!"
            );
            if *command_builtin && matches!(value.as_str(), "-v" | "-V") {
                // `command -v ssh` and `command -V ssh` inspect shell command
                // resolution; they do not invoke OpenSSH. End executable
                // discovery for this shell segment so the inspected name is
                // not misclassified as an unmanaged connection attempt.
                *command_position = false;
                *wrapper = false;
                *command_builtin = false;
                return;
            }
            if assignment || wrapper_word || (*wrapper && value.starts_with('-')) {
                *wrapper = wrapper_word || *wrapper;
                *command_builtin =
                    value == "command" || (*command_builtin && value.starts_with('-'));
                return;
            }
            programs.push(value);
            *command_position = false;
            *wrapper = false;
            *command_builtin = false;
        } else {
            token.clear();
        }
    };

    for character in command.chars() {
        if escaped {
            token.push(character);
            escaped = false;
            continue;
        }
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    token.push(character);
                }
            }
            Some('"') => {
                if character == '"' {
                    quote = None;
                } else if character == '\\' {
                    escaped = true;
                } else {
                    token.push(character);
                }
            }
            Some(_) => unreachable!(),
            None => match character {
                '\\' => escaped = true,
                '\'' | '"' => quote = Some(character),
                ';' | '|' | '&' | '(' | ')' | '\n' => {
                    finish_token(
                        &mut token,
                        &mut programs,
                        &mut command_position,
                        &mut wrapper,
                        &mut command_builtin,
                    );
                    command_position = true;
                    wrapper = false;
                    command_builtin = false;
                }
                value if value.is_whitespace() => {
                    finish_token(
                        &mut token,
                        &mut programs,
                        &mut command_position,
                        &mut wrapper,
                        &mut command_builtin,
                    );
                }
                _ => token.push(character),
            },
        }
    }
    finish_token(
        &mut token,
        &mut programs,
        &mut command_position,
        &mut wrapper,
        &mut command_builtin,
    );
    programs
}

fn ensure_target_authorized_for_principal(
    target: &ExecutionTargetRecord,
    principal_id: Option<&str>,
) -> Result<(), TargetExecutionError> {
    if let Some(owner) = target.owner_principal_id.as_deref() {
        if Some(owner) != principal_id {
            return Err(format!(
                "Current Principal is not authorized to use Execution Target '{}'",
                target.id
            )
            .into());
        }
    }
    Ok(())
}

/// Builds the authoritative descriptor for the in-process local execution
/// environment. The caller supplies capability and policy projections so the
/// registry never needs to inspect tool or sandbox implementations directly.
pub fn local_default_registration(
    workspace_root: Option<String>,
    capabilities: Vec<String>,
    policy_digest: String,
) -> ExecutionTargetRegistration {
    ExecutionTargetRegistration {
        id: DEFAULT_EXECUTION_TARGET_ID.to_string(),
        owner_principal_id: None,
        provider_node_id: None,
        kind: ExecutionTargetKind::InProcessLocal,
        name: "Default local execution environment".to_string(),
        status: ExecutionTargetStatus::Online,
        platform: Some(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )),
        workspace_root,
        capabilities,
        metadata: serde_json::json!({
            "backend": "in_process_local",
            "protocol_version": 1
        }),
        policy_digest,
        last_seen_at: Some(Utc::now()),
    }
}

pub fn runtime_managed_ssh_registration(
    config: &ManagedSshTargetConfig,
    endpoint: &ManagedSshEndpoint,
    default_owner_principal_id: &str,
    permission_policy_digest: &str,
) -> Result<ExecutionTargetRegistration, TargetExecutionError> {
    runtime_managed_ssh_registration_for_host(
        config,
        endpoint,
        default_owner_principal_id,
        permission_policy_digest,
        runtime_managed_ssh_host_id(),
    )
}

fn runtime_managed_ssh_registration_for_host(
    config: &ManagedSshTargetConfig,
    endpoint: &ManagedSshEndpoint,
    default_owner_principal_id: &str,
    permission_policy_digest: &str,
    runtime_host_id: &str,
) -> Result<ExecutionTargetRegistration, TargetExecutionError> {
    let id = config.id.trim();
    if id.is_empty() || id == DEFAULT_EXECUTION_TARGET_ID {
        return Err(
            "Runtime Managed SSH Target id must not be empty or use 'target-default'".into(),
        );
    }
    let name = config.name.trim();
    if name.is_empty() {
        return Err(format!("Runtime Managed SSH Target '{id}' name must not be empty").into());
    }
    validate_endpoint_ref(config.endpoint_ref.trim())?;
    endpoint.validate()?;
    if !endpoint.approved {
        return Err(format!(
            "Runtime Managed SSH Target '{}' endpoint '{}' has not been explicitly approved",
            id, config.endpoint_ref
        )
        .into());
    }
    let owner_principal_id = config
        .owner_principal_id
        .as_deref()
        .unwrap_or(default_owner_principal_id)
        .trim();
    if owner_principal_id.is_empty() {
        return Err(format!(
            "Runtime Managed SSH Target '{id}' owner_principal_id must not be empty"
        )
        .into());
    }
    if config
        .platform
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(format!("Runtime Managed SSH Target '{id}' platform must not be empty").into());
    }
    if config
        .workspace_root
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(
            format!("Runtime Managed SSH Target '{id}' workspace_root must not be empty").into(),
        );
    }

    let mut digest = Sha256::new();
    digest.update(b"morphz.runtime-managed-ssh-policy.v3\0");
    digest.update(permission_policy_digest.as_bytes());
    digest.update(b"\0");
    digest.update(id.as_bytes());
    digest.update(b"\0");
    digest.update(config.endpoint_ref.as_bytes());
    digest.update(b"\0");
    digest.update(endpoint.host.as_bytes());
    digest.update(b"\0");
    digest.update(endpoint.user.as_deref().unwrap_or_default().as_bytes());
    digest.update(endpoint.port.to_be_bytes());
    digest.update(endpoint.auth_mode.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(
        endpoint
            .private_key_secret
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    digest.update(b"\0");
    digest.update(
        endpoint
            .private_key_passphrase_secret
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    digest.update(b"\0");
    digest.update(
        endpoint
            .password_secret
            .as_deref()
            .unwrap_or_default()
            .as_bytes(),
    );
    digest.update(endpoint.known_hosts_file.to_string_lossy().as_bytes());
    if endpoint.known_hosts_file.is_file() {
        digest.update(std::fs::read(&endpoint.known_hosts_file)?);
    }
    if let Some(config_digest) = endpoint.config_digest.as_deref() {
        digest.update(config_digest.as_bytes());
    }
    if managed_ssh_uses_host_openssh(endpoint) {
        digest.update(b"\0host-openssh\0");
        digest.update(runtime_host_id.as_bytes());
    }

    let credential_source = if managed_ssh_uses_host_openssh(endpoint) {
        "host_openssh"
    } else {
        "secret_store"
    };
    let bound_runtime_host_id =
        managed_ssh_uses_host_openssh(endpoint).then(|| runtime_host_id.to_string());

    Ok(ExecutionTargetRegistration {
        id: id.to_string(),
        owner_principal_id: Some(owner_principal_id.to_string()),
        provider_node_id: None,
        kind: ExecutionTargetKind::ManagedSsh,
        name: name.to_string(),
        status: ExecutionTargetStatus::Online,
        platform: config.platform.clone(),
        workspace_root: config.workspace_root.clone(),
        capabilities: vec![
            "exec".to_string(),
            "read".to_string(),
            "write".to_string(),
            "edit".to_string(),
            "list_files".to_string(),
            "search".to_string(),
            crate::artifact::ARTIFACT_TRANSFER_TOOL_NAME.to_string(),
        ],
        metadata: serde_json::json!({
            "backend": "managed_ssh",
            "execution_location": "runtime",
            "endpoint_ref": config.endpoint_ref,
            "host": endpoint.destination,
            "user": endpoint.destination.as_ref().and(endpoint.user.as_ref()),
            "port": endpoint.destination.as_ref().map(|_| endpoint.port),
            "auth_mode": endpoint.auth_mode,
            "private_key_secret": endpoint.private_key_secret,
            "private_key_passphrase_secret": endpoint.private_key_passphrase_secret,
            "private_key_secret_configured": endpoint.private_key_secret.is_some(),
            "private_key_passphrase_secret_configured": endpoint.private_key_passphrase_secret.is_some(),
            "password_secret": endpoint.password_secret,
            "password_secret_configured": endpoint.password_secret.is_some(),
            "credential_source": credential_source,
            "runtime_host_id": bound_runtime_host_id,
            "protocol_version": RUNTIME_MANAGED_SSH_PROTOCOL_VERSION
        }),
        policy_digest: format!("sha256:{:x}", digest.finalize()),
        last_seen_at: Some(Utc::now()),
    })
}

fn runtime_managed_ssh_target_id(
    principal_id: &str,
    requested_host: &str,
    endpoint: &ManagedSshEndpoint,
    runtime_host_id: &str,
) -> String {
    let mut identity_material = format!(
        "{principal_id}\0{requested_host}\0{}\0{}",
        endpoint.user.as_deref().unwrap_or_default(),
        endpoint.port
    );
    if managed_ssh_uses_host_openssh(endpoint) {
        identity_material.push('\0');
        identity_material.push_str(runtime_host_id);
    }
    let identity_hash = format!("{:x}", Sha256::digest(identity_material.as_bytes()));
    format!("target-ssh-{}", &identity_hash[..24])
}

fn target_visible_to_active_principal(target: &ExecutionTargetRecord) -> bool {
    let principal = CURRENT_PRINCIPAL_ID.try_with(Clone::clone).ok().flatten();
    target.owner_principal_id.is_none() || target.owner_principal_id == principal
}

pub struct ListTargetsTool {
    targets: Arc<dyn ExecutionTargetStore>,
}

impl ListTargetsTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self { targets }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListTargetsArgs {
    status: Option<ExecutionTargetStatus>,
    limit: Option<usize>,
}

#[async_trait::async_trait]
impl Tool for ListTargetsTool {
    fn name(&self) -> &str {
        "list_targets"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "List a compact index of Execution Targets available to the current identity. Use the stable IDs returned here in physical-tool target parameters. Runtime-managed SSH dials per command and holds no persistent SSH lease: offline may mean only that the current Runtime route needs rehydration, not that the remote host is physically offline. Follow recommended_action and call resolve_target to restore it.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["online", "offline", "disabled"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100}
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: ListTargetsArgs = serde_json::from_str(arguments)?;
        let targets = self
            .targets
            .list_execution_targets(ExecutionTargetFilter {
                status: args.status,
                limit: Some(args.limit.unwrap_or(32).min(100)),
                ..Default::default()
            })
            .await?
            .into_iter()
            .filter(target_visible_to_active_principal)
            .map(|target| {
                let runtime_availability = target_runtime_availability(&target);
                serde_json::json!({
                    "target_id": target.id,
                    "name": target.name,
                    "kind": target.kind,
                    "status": target.status,
                    "platform": target.platform,
                    "capabilities": target.capabilities,
                    "provider_node_id": target.provider_node_id,
                    "workspace_root": target.workspace_root,
                    "auth_mode": target.metadata.get("auth_mode"),
                    "private_key_secret_configured": target.metadata.get("private_key_secret_configured"),
                    "private_key_passphrase_secret_configured": target.metadata.get("private_key_passphrase_secret_configured"),
                    "password_secret_configured": target.metadata.get("password_secret_configured"),
                    "runtime_availability": runtime_availability,
                })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({
            "default_target_id": DEFAULT_EXECUTION_TARGET_ID,
            "targets": targets
        })
        .to_string())
    }
}

pub struct InspectTargetTool {
    targets: Arc<dyn ExecutionTargetStore>,
}

pub struct ResolveTargetTool {
    targets: Arc<dyn ExecutionTargetStore>,
    runtime_managed_ssh: Option<RuntimeManagedSshProvisioner>,
}

#[derive(Clone, Copy, Default)]
struct ManagedSshAuthBinding<'a> {
    mode: Option<ManagedSshAuthMode>,
    private_key_secret: Option<&'a str>,
    private_key_passphrase_secret: Option<&'a str>,
    password_secret: Option<&'a str>,
}

fn configure_managed_ssh_auth(
    endpoint: &mut ManagedSshEndpoint,
    requested: ManagedSshAuthBinding<'_>,
    fallback: ManagedSshAuthBinding<'_>,
) -> Result<(), TargetExecutionError> {
    let requested_mode = requested.mode;
    let requested_private_key_secret = requested.private_key_secret;
    let requested_private_key_passphrase_secret = requested.private_key_passphrase_secret;
    let requested_password_secret = requested.password_secret;
    if requested_mode == Some(ManagedSshAuthMode::KeyOnly) && requested_password_secret.is_some() {
        return Err("Managed SSH key_only cannot also specify password_secret".into());
    }
    if requested_mode == Some(ManagedSshAuthMode::PasswordOnly)
        && (requested_private_key_secret.is_some()
            || requested_private_key_passphrase_secret.is_some())
    {
        return Err(
            "Managed SSH password_only cannot also specify private_key_secret or private_key_passphrase_secret"
                .into(),
        );
    }
    let mode = requested_mode.unwrap_or_else(|| {
        if requested_password_secret.is_some() && requested_private_key_secret.is_some() {
            ManagedSshAuthMode::KeyThenPassword
        } else if requested_password_secret.is_some() {
            ManagedSshAuthMode::PasswordOnly
        } else if requested_private_key_secret.is_some()
            || requested_private_key_passphrase_secret.is_some()
        {
            ManagedSshAuthMode::KeyOnly
        } else {
            fallback.mode.unwrap_or_default()
        }
    });
    let private_key_secret = if mode.uses_keys() {
        requested_private_key_secret.or(fallback.private_key_secret)
    } else {
        None
    };
    let private_key_passphrase_secret = if mode.uses_keys() {
        requested_private_key_passphrase_secret.or(fallback.private_key_passphrase_secret)
    } else {
        None
    };
    let password_secret = if mode.uses_password() {
        requested_password_secret.or(fallback.password_secret)
    } else {
        None
    };
    endpoint.auth_mode = mode;
    endpoint.private_key_secret = private_key_secret.map(str::to_string);
    endpoint.private_key_passphrase_secret = private_key_passphrase_secret.map(str::to_string);
    endpoint.password_secret = password_secret.map(str::to_string);
    endpoint.validate()
}

#[derive(Clone)]
pub struct RuntimeManagedSshProvisioner {
    targets: Arc<dyn ExecutionTargetStore>,
    endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
    secret_store: Arc<crate::secret_store::SecretStore>,
    default_principal_id: String,
    permission_policy_digest: String,
    runtime_host_id: String,
    availability_probe: Arc<dyn ManagedSshAvailabilityProbe>,
}

#[async_trait::async_trait]
trait ManagedSshAvailabilityProbe: Send + Sync {
    async fn authenticate(&self, endpoint: &ManagedSshEndpoint)
        -> Result<(), TargetExecutionError>;
}

struct SystemOpenSshAvailabilityProbe;

#[async_trait::async_trait]
impl ManagedSshAvailabilityProbe for SystemOpenSshAvailabilityProbe {
    async fn authenticate(
        &self,
        endpoint: &ManagedSshEndpoint,
    ) -> Result<(), TargetExecutionError> {
        let authentication = ManagedSshAuthentication::default();
        let check = run_managed_ssh_output(endpoint, &authentication, "exit 0");
        let output = tokio::time::timeout(Duration::from_secs(12), check)
            .await
            .map_err(|_| {
                format!(
                    "Timed out while verifying system OpenSSH authentication for '{}'",
                    endpoint.destination.as_deref().unwrap_or(&endpoint.host)
                )
            })??;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "System OpenSSH on this Runtime host cannot authenticate to '{}': {}",
            endpoint.destination.as_deref().unwrap_or(&endpoint.host),
            detail.trim()
        )
        .into())
    }
}

struct RuntimeManagedSshProvisionRequest<'a> {
    host: &'a str,
    user: Option<&'a str>,
    port: Option<u16>,
    auth_mode: Option<ManagedSshAuthMode>,
    private_key_secret: Option<&'a str>,
    private_key_passphrase_secret: Option<&'a str>,
    password_secret: Option<&'a str>,
    platform: Option<String>,
    workspace_root: Option<String>,
}

impl RuntimeManagedSshProvisioner {
    pub fn new(
        targets: Arc<dyn ExecutionTargetStore>,
        endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        secret_store: Arc<crate::secret_store::SecretStore>,
        default_principal_id: String,
        permission_policy_digest: String,
    ) -> Self {
        Self {
            targets,
            endpoints,
            secret_store,
            default_principal_id,
            permission_policy_digest,
            runtime_host_id: runtime_managed_ssh_host_id().to_string(),
            availability_probe: Arc::new(SystemOpenSshAvailabilityProbe),
        }
    }

    #[cfg(test)]
    fn with_test_host_and_probe(
        mut self,
        runtime_host_id: &str,
        availability_probe: Arc<dyn ManagedSshAvailabilityProbe>,
    ) -> Self {
        self.runtime_host_id = runtime_host_id.to_string();
        self.availability_probe = availability_probe;
        self
    }

    pub fn belongs_to_current_runtime_host(&self, target: &ExecutionTargetRecord) -> bool {
        !managed_ssh_target_uses_host_openssh(target)
            || managed_ssh_target_runtime_host_id(target)
                .is_none_or(|owner| owner == self.runtime_host_id.as_str())
    }

    async fn verify_availability(
        &self,
        endpoint: &ManagedSshEndpoint,
    ) -> Result<(), TargetExecutionError> {
        if managed_ssh_uses_host_openssh(endpoint) {
            self.availability_probe.authenticate(endpoint).await?;
        }
        Ok(())
    }

    pub async fn register_configured_target(
        &self,
        config: &ManagedSshTargetConfig,
        endpoint: ManagedSshEndpoint,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        self.validate_secret_bindings(&endpoint)?;
        // A configured Managed SSH Target is a durable, dial-on-demand route.
        // Registering its descriptor must not turn Runtime startup into a
        // serial network health check. Authentication still happens when the
        // route is explicitly resolved or first used.
        let registration = runtime_managed_ssh_registration_for_host(
            config,
            &endpoint,
            &self.default_principal_id,
            &self.permission_policy_digest,
            &self.runtime_host_id,
        )?;
        let target = self.targets.register_execution_target(registration).await?;
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(config.endpoint_ref.clone(), endpoint);
        Ok(target)
    }

    async fn provision(
        &self,
        request: RuntimeManagedSshProvisionRequest<'_>,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let RuntimeManagedSshProvisionRequest {
            host,
            user,
            port,
            auth_mode,
            private_key_secret,
            private_key_passphrase_secret,
            password_secret,
            platform,
            workspace_root,
        } = request;
        validate_ssh_host(host)?;
        let mut endpoint = resolve_runtime_ssh_host(host, user, port).await?;
        configure_managed_ssh_auth(
            &mut endpoint,
            ManagedSshAuthBinding {
                mode: auth_mode,
                private_key_secret,
                private_key_passphrase_secret,
                password_secret,
            },
            ManagedSshAuthBinding::default(),
        )?;
        self.validate_secret_bindings(&endpoint)?;
        let principal_id = CURRENT_PRINCIPAL_ID
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .unwrap_or_else(|| self.default_principal_id.clone());
        if principal_id.trim().is_empty() {
            return Err(
                "On-demand Managed SSH Target creation is missing the current Principal".into(),
            );
        }
        self.verify_availability(&endpoint).await?;
        let target_id =
            runtime_managed_ssh_target_id(&principal_id, host, &endpoint, &self.runtime_host_id);
        let endpoint_ref = target_id.replacen("target-ssh-", "runtime_ssh_", 1);
        let display_destination = endpoint
            .user
            .as_deref()
            .map(|user| format!("{user}@{host}:{}", endpoint.port))
            .unwrap_or_else(|| format!("{host}:{}", endpoint.port));
        let config = ManagedSshTargetConfig {
            id: target_id,
            name: format!("SSH {display_destination}"),
            endpoint_ref: endpoint_ref.clone(),
            owner_principal_id: Some(principal_id.clone()),
            platform,
            workspace_root,
        };
        let registration = runtime_managed_ssh_registration_for_host(
            &config,
            &endpoint,
            &principal_id,
            &self.permission_policy_digest,
            &self.runtime_host_id,
        )?;
        let target = self.targets.register_execution_target(registration).await?;
        if target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Managed SSH Target '{}' was disabled by an administrator and must be explicitly enabled before use",
                target.id
            )
            .into());
        }
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(endpoint_ref, endpoint);
        Ok(target)
    }

    fn validate_secret_bindings(
        &self,
        endpoint: &ManagedSshEndpoint,
    ) -> Result<(), TargetExecutionError> {
        for (label, alias) in [
            ("private key", endpoint.private_key_secret.as_deref()),
            (
                "private key passphrase",
                endpoint.private_key_passphrase_secret.as_deref(),
            ),
            ("password", endpoint.password_secret.as_deref()),
        ] {
            let Some(alias) = alias else {
                continue;
            };
            if !self.secret_store.contains_alias(alias)? {
                return Err(format!(
                    "Managed SSH {label} Secret '{}' does not exist in the Secret Store",
                    alias
                )
                .into());
            }
        }
        Ok(())
    }

    /// Rebuilds the process-local OpenSSH route for a durable Runtime-managed
    /// target. Runtime-managed SSH has no persistent connection or heartbeat:
    /// an `offline` record after restart means the route has not been
    /// rehydrated, not that the remote machine was observed offline.
    pub async fn rehydrate(
        &self,
        target: &ExecutionTargetRecord,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        self.rehydrate_with_auth(target, None, None, None, None)
            .await
    }

    /// Restores only the process-local route descriptor for a durable Target.
    /// This is the startup path: it deliberately performs no remote network
    /// or authentication probe. Managed SSH is dial-on-demand, so remote
    /// availability is established by an actual resolve or execution.
    pub async fn restore_route(
        &self,
        target: &ExecutionTargetRecord,
    ) -> Result<(), TargetExecutionError> {
        let (endpoint, config, _) = self
            .recover_route_descriptor(target, None, None, None, None)
            .await?;
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(config.endpoint_ref, endpoint);
        Ok(())
    }

    async fn rehydrate_with_auth(
        &self,
        target: &ExecutionTargetRecord,
        auth_mode: Option<ManagedSshAuthMode>,
        private_key_secret: Option<&str>,
        private_key_passphrase_secret: Option<&str>,
        password_secret: Option<&str>,
    ) -> Result<ExecutionTargetRecord, TargetExecutionError> {
        let (endpoint, config, owner_principal_id) = self
            .recover_route_descriptor(
                target,
                auth_mode,
                private_key_secret,
                private_key_passphrase_secret,
                password_secret,
            )
            .await?;
        self.verify_availability(&endpoint).await?;
        let registration = runtime_managed_ssh_registration_for_host(
            &config,
            &endpoint,
            &owner_principal_id,
            &self.permission_policy_digest,
            &self.runtime_host_id,
        )?;
        let target = self.targets.register_execution_target(registration).await?;
        if target.status != ExecutionTargetStatus::Online {
            return Err(format!(
                "Managed SSH Target '{}' remains {} after route recovery",
                target.id,
                target.status.as_str()
            )
            .into());
        }
        self.endpoints
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(config.endpoint_ref, endpoint);
        Ok(target)
    }

    async fn recover_route_descriptor(
        &self,
        target: &ExecutionTargetRecord,
        auth_mode: Option<ManagedSshAuthMode>,
        private_key_secret: Option<&str>,
        private_key_passphrase_secret: Option<&str>,
        password_secret: Option<&str>,
    ) -> Result<(ManagedSshEndpoint, ManagedSshTargetConfig, String), TargetExecutionError> {
        if target.kind != ExecutionTargetKind::ManagedSsh
            || target.provider_node_id.is_some()
            || target
                .metadata
                .get("execution_location")
                .and_then(serde_json::Value::as_str)
                != Some("runtime")
        {
            return Err(format!(
                "Execution Target '{}' is not a Runtime-managed SSH route",
                target.id
            )
            .into());
        }
        if target.status == ExecutionTargetStatus::Disabled {
            return Err(format!(
                "Managed SSH Target '{}' was disabled by an administrator and must be explicitly enabled before use",
                target.id
            )
            .into());
        }
        let host = target
            .metadata
            .get("host")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Runtime Managed SSH Target '{}' is missing recoverable host metadata",
                    target.id
                )
            })?;
        let user = target
            .metadata
            .get("user")
            .and_then(serde_json::Value::as_str);
        let port = target
            .metadata
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .map(u16::try_from)
            .transpose()
            .map_err(|_| format!("Managed SSH Target '{}' has an invalid port", target.id))?;
        let endpoint_ref = target
            .metadata
            .get("endpoint_ref")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                format!(
                    "Runtime Managed SSH Target '{}' is missing endpoint_ref metadata",
                    target.id
                )
            })?;
        validate_endpoint_ref(endpoint_ref)?;
        let owner_principal_id = target.owner_principal_id.as_deref().ok_or_else(|| {
            format!(
                "Runtime Managed SSH Target '{}' is missing owner_principal_id",
                target.id
            )
        })?;
        let fallback_auth_mode = managed_ssh_target_auth_mode(target)?;
        let fallback_password_secret = target
            .metadata
            .get("password_secret")
            .and_then(serde_json::Value::as_str);
        let fallback_private_key_secret = target
            .metadata
            .get("private_key_secret")
            .and_then(serde_json::Value::as_str);
        let fallback_private_key_passphrase_secret = target
            .metadata
            .get("private_key_passphrase_secret")
            .and_then(serde_json::Value::as_str);
        let mut endpoint = resolve_runtime_ssh_host(host, user, port).await?;
        configure_managed_ssh_auth(
            &mut endpoint,
            ManagedSshAuthBinding {
                mode: auth_mode,
                private_key_secret,
                private_key_passphrase_secret,
                password_secret,
            },
            ManagedSshAuthBinding {
                mode: Some(fallback_auth_mode),
                private_key_secret: fallback_private_key_secret,
                private_key_passphrase_secret: fallback_private_key_passphrase_secret,
                password_secret: fallback_password_secret,
            },
        )?;
        self.validate_secret_bindings(&endpoint)?;
        if managed_ssh_uses_host_openssh(&endpoint) {
            if let Some(owner_runtime_host_id) = managed_ssh_target_runtime_host_id(target) {
                if owner_runtime_host_id != self.runtime_host_id.as_str() {
                    return Err(format!(
                        "Managed SSH Target '{}' uses system OpenSSH owned by Runtime host '{}'; current Runtime host '{}' must not rehydrate it",
                        target.id, owner_runtime_host_id, self.runtime_host_id
                    )
                    .into());
                }
            }
        }
        let config = ManagedSshTargetConfig {
            id: target.id.clone(),
            name: target.name.clone(),
            endpoint_ref: endpoint_ref.to_string(),
            owner_principal_id: Some(owner_principal_id.to_string()),
            platform: target.platform.clone(),
            workspace_root: target.workspace_root.clone(),
        };
        Ok((endpoint, config, owner_principal_id.to_string()))
    }
}

fn target_runtime_availability(target: &ExecutionTargetRecord) -> serde_json::Value {
    if target.status == ExecutionTargetStatus::Disabled {
        return serde_json::json!({
            "availability": "disabled",
            "usable_now": false,
            "recoverable": false,
            "connection_model": if target.provider_node_id.is_some() {
                "provider_heartbeat"
            } else if target.kind == ExecutionTargetKind::ManagedSsh {
                "dial_on_demand"
            } else {
                "local"
            },
            "status_explanation": "Target was explicitly disabled; this is not a transient offline state",
            "recommended_action": "only an administrator can explicitly enable this Target"
        });
    }
    if target.kind == ExecutionTargetKind::ManagedSsh && target.provider_node_id.is_none() {
        if managed_ssh_target_uses_host_openssh(target)
            && managed_ssh_target_runtime_host_id(target)
                .is_some_and(|owner| owner != runtime_managed_ssh_host_id())
        {
            return serde_json::json!({
                "availability": "owned_by_another_runtime_host",
                "usable_now": false,
                "recoverable": true,
                "connection_model": "host_openssh",
                "status_explanation": "this Target depends on system OpenSSH state owned by another Runtime host",
                "recommended_action": "execute through the owning Runtime host, or explicitly bind a portable Secret Store credential"
            });
        }
        if target.status == ExecutionTargetStatus::Online {
            return serde_json::json!({
                "availability": "ready_on_demand",
                "usable_now": true,
                "recoverable": true,
                "connection_model": "dial_on_demand",
                "status_explanation": "Runtime has configured the SSH route; SSH connections are established only while executing commands and there is no persistent connection to renew",
                "recommended_action": "use target_id directly for exec; do not interpret the absence of a persistent SSH connection as the node being offline"
            });
        }
        return serde_json::json!({
            "availability": "route_needs_rehydration",
            "usable_now": false,
            "recoverable": true,
            "connection_model": "dial_on_demand",
            "status_explanation": "the current Runtime has not rebuilt this on-demand SSH route; this does not mean the remote host was detected as offline",
            "recommended_action": "call resolve_target with this target_id to resolve the route again, then continue"
        });
    }
    if target.provider_node_id.is_some() {
        if target.status == ExecutionTargetStatus::Online {
            return serde_json::json!({
                "availability": "provider_connected",
                "usable_now": true,
                "recoverable": true,
                "connection_model": "provider_heartbeat",
                "status_explanation": "the Edge Node providing this Target has a healthy heartbeat",
                "recommended_action": "execute directly"
            });
        }
        return serde_json::json!({
            "availability": "provider_temporarily_disconnected",
            "usable_now": false,
            "recoverable": true,
            "connection_model": "provider_heartbeat",
            "status_explanation": "the heartbeat of the Edge Node providing this Target is temporarily stale; the Target has not been deleted",
            "recommended_action": "wait for the Provider Node to recover, or choose durable offline queuing when allowed"
        });
    }
    serde_json::json!({
        "availability": if target.status == ExecutionTargetStatus::Online {
            "ready"
        } else {
            "unavailable"
        },
        "usable_now": target.status == ExecutionTargetStatus::Online,
        "recoverable": target.status != ExecutionTargetStatus::Disabled,
        "connection_model": "local",
        "status_explanation": if target.status == ExecutionTargetStatus::Online {
            "Target is currently available"
        } else {
            "Target is currently unavailable"
        },
        "recommended_action": if target.status == ExecutionTargetStatus::Online {
            "execute directly"
        } else {
            "wait for Runtime to recover the Target"
        }
    })
}

impl ResolveTargetTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self {
            targets,
            runtime_managed_ssh: None,
        }
    }

    pub fn with_runtime_managed_ssh(mut self, provisioner: RuntimeManagedSshProvisioner) -> Self {
        self.runtime_managed_ssh = Some(provisioner);
        self
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveTargetArgs {
    target_id: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    platform: Option<String>,
    kind: Option<ExecutionTargetKind>,
    host: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    auth_mode: Option<ManagedSshAuthMode>,
    private_key_secret: Option<String>,
    private_key_passphrase_secret: Option<String>,
    password_secret: Option<String>,
    workspace_root: Option<String>,
    #[serde(default)]
    allow_offline_queue: bool,
}

#[async_trait::async_trait]
impl Tool for ResolveTargetTool {
    fn name(&self) -> &str {
        "resolve_target"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Deterministically resolve an Execution Target available to the current identity by stable ID or by capabilities, platform, and backend. Runtime-managed SSH has no persistent connection lease: when list_targets reports route_needs_rehydration, pass target_id to rebuild the route; that report does not mean the remote host is offline. Managed SSH may also register an existing host OpenSSH alias on demand. SSH credentials bind Secret Store aliases to the Target; never place a private key, passphrase, or password value in tool arguments. Explicitly use the returned stable target_id in subsequent non-local physical tool calls.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {
                        "type": "string",
                        "description": "Optional stable Target ID. Pass it to rebuild a Runtime Managed SSH route in place; do not combine it with host, user, or port"
                    },
                    "capabilities": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "All physical tool names the Target must provide; Managed SSH v1 requires exec, not ssh"
                    },
                    "platform": {"type": "string"},
                    "kind": {
                        "type": "string",
                        "enum": ["in_process_local", "edge_node", "managed_ssh", "managed_worker"]
                    },
                    "host": {
                        "type": "string",
                        "description": "An SSH config Host, DNS hostname, or IPv4 address. Used only for managed_ssh; the Runtime creates a Target on demand when none exists"
                    },
                    "user": {
                        "type": "string",
                        "description": "Optional SSH username; omission uses OpenSSH config or the host default"
                    },
                    "port": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 65535,
                        "description": "Optional SSH port; omission uses OpenSSH config or port 22"
                    },
                    "auth_mode": {
                        "type": "string",
                        "enum": ["key_only", "password_only", "key_then_password"],
                        "description": "Managed SSH authentication mode. password modes require password_secret; key modes may bind private_key_secret or use host OpenSSH discovery; key_only is the default"
                    },
                    "private_key_secret": {
                        "type": "string",
                        "description": "Secret Store alias containing an OpenSSH private key. The key value is never accepted here or persisted in the Target. May be combined with target_id to bind or rotate an existing Runtime Managed SSH Target"
                    },
                    "private_key_passphrase_secret": {
                        "type": "string",
                        "description": "Optional Secret Store alias containing the passphrase for private_key_secret. It is invalid without a private-key binding"
                    },
                    "password_secret": {
                        "type": "string",
                        "description": "Secret Store alias containing the SSH password. The value is never accepted here. May be combined with target_id to bind or rotate an existing Runtime Managed SSH Target"
                    },
                    "workspace_root": {
                        "type": "string",
                        "description": "Optional remote Workspace hint recorded when a managed_ssh Target is created on demand"
                    },
                    "allow_offline_queue": {
                        "type": "boolean",
                        "description": "Whether to allow an Edge Target with durable offline queueing or a Managed SSH Target backed by an Edge Provider"
                    }
                },
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: ResolveTargetArgs = serde_json::from_str(arguments)?;
        if args.target_id.is_some()
            && (args.host.is_some() || args.user.is_some() || args.port.is_some())
        {
            return Err("resolve_target.target_id cannot be used with host/user/port".into());
        }
        if (args.host.is_some() || args.user.is_some() || args.port.is_some())
            && args
                .kind
                .is_some_and(|kind| kind != ExecutionTargetKind::ManagedSsh)
        {
            return Err(
                "resolve_target.host/user/port can be used only with kind=managed_ssh".into(),
            );
        }
        if let Some(host) = args.host.as_deref() {
            validate_ssh_host(host)?;
        }
        if args.host.is_none() && (args.user.is_some() || args.port.is_some()) {
            return Err("resolve_target.user/port must be used with host".into());
        }
        if let Some(user) = args.user.as_deref() {
            validate_ssh_user(user)?;
        }
        for (field, alias) in [
            ("private_key_secret", args.private_key_secret.as_deref()),
            (
                "private_key_passphrase_secret",
                args.private_key_passphrase_secret.as_deref(),
            ),
            ("password_secret", args.password_secret.as_deref()),
        ] {
            if let Some(alias) = alias {
                validate_managed_ssh_secret_alias(field, alias)?;
            }
        }
        if args.target_id.is_none()
            && args.host.is_none()
            && (args.auth_mode.is_some()
                || args.private_key_secret.is_some()
                || args.private_key_passphrase_secret.is_some()
                || args.password_secret.is_some())
        {
            return Err(
                "resolve_target SSH authentication arguments must be used with target_id or a Managed SSH host"
                    .into(),
            );
        }
        if args.auth_mode == Some(ManagedSshAuthMode::KeyOnly) && args.password_secret.is_some() {
            return Err("resolve_target.key_only cannot also specify password_secret".into());
        }
        if args.auth_mode == Some(ManagedSshAuthMode::PasswordOnly)
            && (args.private_key_secret.is_some() || args.private_key_passphrase_secret.is_some())
        {
            return Err(
                "resolve_target.password_only cannot also specify private_key_secret or private_key_passphrase_secret"
                    .into(),
            );
        }
        if args.private_key_passphrase_secret.is_some()
            && args.private_key_secret.is_none()
            && args.target_id.is_none()
        {
            return Err(
                "resolve_target.private_key_passphrase_secret must be used with private_key_secret"
                    .into(),
            );
        }
        if args.port == Some(0) {
            return Err("resolve_target.port must be greater than 0".into());
        }
        if args
            .workspace_root
            .as_deref()
            .is_some_and(|root| root.trim().is_empty())
        {
            return Err("resolve_target.workspace_root must not be empty".into());
        }
        let selected = if let Some(target_id) = args.target_id.as_deref() {
            let target = self
                .targets
                .get_execution_target(target_id)
                .await?
                .ok_or_else(|| format!("Execution Target '{target_id}' does not exist"))?;
            if !target_visible_to_active_principal(&target) {
                return Err(format!(
                    "Current identity cannot use Execution Target '{}'",
                    target.id
                )
                .into());
            }
            let has_auth_override = args.auth_mode.is_some()
                || args.private_key_secret.is_some()
                || args.private_key_passphrase_secret.is_some()
                || args.password_secret.is_some();
            if !has_auth_override
                && self
                    .runtime_managed_ssh
                    .as_ref()
                    .is_some_and(|provisioner| {
                        !provisioner.belongs_to_current_runtime_host(&target)
                    })
            {
                return Err(format!(
                    "Execution Target '{}' uses system OpenSSH owned by another Runtime host and cannot be selected here",
                    target.id
                )
                .into());
            }
            if has_auth_override {
                self.runtime_managed_ssh
                    .as_ref()
                    .ok_or("Current Runtime has not enabled on-demand Managed SSH Targets")?
                    .rehydrate_with_auth(
                        &target,
                        args.auth_mode,
                        args.private_key_secret.as_deref(),
                        args.private_key_passphrase_secret.as_deref(),
                        args.password_secret.as_deref(),
                    )
                    .await?
            } else if target.status == ExecutionTargetStatus::Offline
                && target.kind == ExecutionTargetKind::ManagedSsh
                && target.provider_node_id.is_none()
            {
                self.runtime_managed_ssh
                    .as_ref()
                    .ok_or("Current Runtime has not enabled on-demand Managed SSH Targets")?
                    .rehydrate(&target)
                    .await?
            } else if target.status == ExecutionTargetStatus::Online
                || (args.allow_offline_queue
                    && target.status == ExecutionTargetStatus::Offline
                    && (target.kind == ExecutionTargetKind::EdgeNode
                        || (target.kind == ExecutionTargetKind::ManagedSsh
                            && target.provider_node_id.is_some())))
            {
                target
            } else {
                return Err(format!(
                    "Execution Target '{}' currently has status {} and cannot be selected under the current policy",
                    target.id,
                    target.status.as_str()
                )
                .into());
            }
        } else if let Some(host) = args.host.as_deref() {
            let provisioner = self
                .runtime_managed_ssh
                .as_ref()
                .ok_or("Current Runtime has not enabled on-demand Managed SSH Targets")?;
            provisioner
                .provision(RuntimeManagedSshProvisionRequest {
                    host,
                    user: args.user.as_deref(),
                    port: args.port,
                    auth_mode: args.auth_mode,
                    private_key_secret: args.private_key_secret.as_deref(),
                    private_key_passphrase_secret: args.private_key_passphrase_secret.as_deref(),
                    password_secret: args.password_secret.as_deref(),
                    platform: args.platform.clone(),
                    workspace_root: args.workspace_root.clone(),
                })
                .await?
        } else {
            let mut targets = self
                .targets
                .list_execution_targets(ExecutionTargetFilter {
                    limit: Some(256),
                    ..Default::default()
                })
                .await?
                .into_iter()
                .filter(target_visible_to_active_principal)
                .filter(|target| {
                    self.runtime_managed_ssh.as_ref().is_none_or(|provisioner| {
                        provisioner.belongs_to_current_runtime_host(target)
                    })
                })
                .filter(|target| {
                    target.status == ExecutionTargetStatus::Online
                        || (args.allow_offline_queue
                            && target.status == ExecutionTargetStatus::Offline
                            && (target.kind == ExecutionTargetKind::EdgeNode
                                || (target.kind == ExecutionTargetKind::ManagedSsh
                                    && target.provider_node_id.is_some())))
                })
                .filter(|target| args.kind.is_none_or(|kind| target.kind == kind))
                .filter(|target| {
                    args.platform.as_ref().is_none_or(|platform| {
                        target.platform.as_ref().is_some_and(|candidate| {
                            candidate.eq_ignore_ascii_case(platform)
                                || candidate
                                    .to_ascii_lowercase()
                                    .contains(&platform.to_ascii_lowercase())
                        })
                    })
                })
                .filter(|target| {
                    args.workspace_root.as_ref().is_none_or(|workspace_root| {
                        target.workspace_root.as_deref() == Some(workspace_root.as_str())
                    })
                })
                .filter(|target| {
                    args.capabilities
                        .iter()
                        .all(|required| target.capabilities.iter().any(|actual| actual == required))
                })
                .collect::<Vec<_>>();
            targets.sort_by(|left, right| {
                let left_offline = left.status != ExecutionTargetStatus::Online;
                let right_offline = right.status != ExecutionTargetStatus::Online;
                left_offline
                    .cmp(&right_offline)
                    .then_with(|| left.id.cmp(&right.id))
            });
            targets
                .into_iter()
                .next()
                .ok_or("No Execution Target satisfies the current Principal, availability, platform, and capability constraints")?
        };
        if !args.capabilities.iter().all(|required| {
            selected
                .capabilities
                .iter()
                .any(|actual| actual == required)
        }) {
            return Err(format!(
                "Execution Target '{}' does not provide all requested capabilities",
                selected.id
            )
            .into());
        }
        Ok(serde_json::json!({
            "target_id": selected.id,
            "name": selected.name,
            "kind": selected.kind,
            "status": selected.status,
            "platform": selected.platform,
            "capabilities": selected.capabilities,
            "provider_node_id": selected.provider_node_id,
            "host": selected.metadata.get("host"),
            "user": selected.metadata.get("user"),
            "port": selected.metadata.get("port"),
            "auth_mode": selected.metadata.get("auth_mode"),
            "private_key_secret_configured": selected.metadata.get("private_key_secret_configured"),
            "private_key_passphrase_secret_configured": selected.metadata.get("private_key_passphrase_secret_configured"),
            "password_secret_configured": selected.metadata.get("password_secret_configured"),
            "runtime_availability": target_runtime_availability(&selected),
            "selection": "deterministic_online_then_target_id"
        })
        .to_string())
    }
}

impl InspectTargetTool {
    pub fn new(targets: Arc<dyn ExecutionTargetStore>) -> Self {
        Self { targets }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InspectTargetArgs {
    target_id: String,
}

#[async_trait::async_trait]
impl Tool for InspectTargetTool {
    fn name(&self) -> &str {
        "inspect_target"
    }

    fn execution_class(&self) -> ToolExecutionClass {
        ToolExecutionClass::LogicalInline
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: "Inspect an Execution Target's capabilities, platform, Workspace, Provider, and policy summary by stable ID. Credentials are never returned.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "target_id": {"type": "string"}
                },
                "required": ["target_id"],
                "additionalProperties": false
            }),
        }
    }

    async fn execute(&self, arguments: &str) -> Result<String, TargetExecutionError> {
        let args: InspectTargetArgs = serde_json::from_str(arguments)?;
        let target = self
            .targets
            .get_execution_target(&args.target_id)
            .await?
            .ok_or_else(|| format!("Execution Target '{}' does not exist", args.target_id))?;
        if !target_visible_to_active_principal(&target) {
            return Err(format!(
                "Current identity cannot inspect Execution Target '{}'",
                target.id
            )
            .into());
        }
        let runtime_availability = target_runtime_availability(&target);
        let mut output = serde_json::to_value(target)?;
        let output_object = output
            .as_object_mut()
            .ok_or("Serialized Execution Target is not an object")?;
        if let Some(metadata) = output_object
            .get_mut("metadata")
            .and_then(serde_json::Value::as_object_mut)
        {
            metadata.remove("private_key_secret");
            metadata.remove("private_key_passphrase_secret");
            metadata.remove("password_secret");
        }
        output_object.insert("runtime_availability".to_string(), runtime_availability);
        Ok(output.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;
    use crate::memory::{ExecutionJobStatus, ExecutionRetrySafety};
    use crate::secret_store::{SecretScopeKind, SecretStore, SecretValueBackend};
    use std::sync::Mutex;

    #[cfg(windows)]
    fn decode_windows_managed_ssh_arguments(command: &str) -> Vec<String> {
        let encoded = command
            .strip_prefix("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ")
            .expect("Windows Managed SSH command must use PowerShell EncodedCommand");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(bytes.len() % 2, 0);
        let units = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&units).unwrap();
        for value in script.split("(D '").skip(1) {
            let Some(encoded) = value.split_once("')").map(|(encoded, _)| encoded) else {
                continue;
            };
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
                continue;
            };
            if let Ok(arguments) = serde_json::from_slice::<Vec<String>>(&bytes) {
                return arguments;
            }
        }
        panic!("Windows Managed SSH EncodedCommand did not contain an SSH argument array");
    }

    struct AlwaysAvailableManagedSshProbe;

    #[async_trait::async_trait]
    impl ManagedSshAvailabilityProbe for AlwaysAvailableManagedSshProbe {
        async fn authenticate(
            &self,
            _endpoint: &ManagedSshEndpoint,
        ) -> Result<(), TargetExecutionError> {
            Ok(())
        }
    }

    struct UnavailableManagedSshProbe;

    #[async_trait::async_trait]
    impl ManagedSshAvailabilityProbe for UnavailableManagedSshProbe {
        async fn authenticate(
            &self,
            _endpoint: &ManagedSshEndpoint,
        ) -> Result<(), TargetExecutionError> {
            Err("test authentication failure".into())
        }
    }

    fn test_runtime_managed_ssh_provisioner(
        store: Arc<dyn ExecutionTargetStore>,
        endpoints: Arc<RwLock<HashMap<String, ManagedSshEndpoint>>>,
        secrets: Arc<SecretStore>,
    ) -> RuntimeManagedSshProvisioner {
        RuntimeManagedSshProvisioner::new(
            store,
            endpoints,
            secrets,
            "principal-default".to_string(),
            "policy-a".to_string(),
        )
        .with_test_host_and_probe(
            runtime_managed_ssh_host_id(),
            Arc::new(AlwaysAvailableManagedSshProbe),
        )
    }

    #[test]
    fn unmanaged_ssh_detection_distinguishes_command_lookup_from_invocation() {
        let invokes_ssh = |command: &str| {
            exec_arguments_invoke_ssh(&serde_json::json!({"command": command}).to_string()).unwrap()
        };

        assert!(!invokes_ssh("command -v ssh"));
        assert!(!invokes_ssh("command -V scp"));
        assert!(!invokes_ssh("env command -v sftp"));
        assert!(!invokes_ssh("type ssh; which scp; command -v sftp"));

        assert!(invokes_ssh("ssh root@example.invalid"));
        assert!(invokes_ssh("command ssh root@example.invalid"));
        assert!(invokes_ssh("command -p ssh root@example.invalid"));
        assert!(invokes_ssh("command -- sftp example.invalid"));
    }

    #[test]
    fn artifact_relay_claimants_are_unique_inside_one_process() {
        let first = new_artifact_relay_claimant_id();
        let second = new_artifact_relay_claimant_id();
        assert_ne!(first, second);
        assert!(first.starts_with("artifact-relay:"));
    }

    #[derive(Default)]
    struct TestSecretBackend {
        values: Mutex<HashMap<String, String>>,
    }

    impl SecretValueBackend for TestSecretBackend {
        fn backend_id(&self) -> &'static str {
            "managed_ssh_test"
        }

        fn storage_kind(&self) -> &'static str {
            "memory"
        }

        fn put(&self, locator: &str, value: &str) -> Result<(), String> {
            self.values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .insert(locator.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, locator: &str) -> Result<Option<String>, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .get(locator)
                .cloned())
        }

        fn delete(&self, locator: &str) -> Result<bool, String> {
            Ok(self
                .values
                .lock()
                .map_err(|_| "test secret backend poisoned".to_string())?
                .remove(locator)
                .is_some())
        }
    }

    fn test_secret_store(path: &Path) -> Arc<SecretStore> {
        Arc::new(
            SecretStore::new(
                path.join("managed-secrets.json"),
                Arc::new(TestSecretBackend::default()),
            )
            .unwrap(),
        )
    }

    #[test]
    fn managed_ssh_artifact_paths_expand_current_user_home_without_shell_injection() {
        assert_eq!(shell_quote_remote_path("~"), "\"$HOME\"");
        assert_eq!(
            shell_quote_remote_path("~/Codes/miao-social/exports/recent 3d.pdf"),
            "\"$HOME\"/'Codes/miao-social/exports/recent 3d.pdf'"
        );
        assert_eq!(
            shell_quote_remote_path("/srv/data/recent 3d.pdf"),
            "'/srv/data/recent 3d.pdf'"
        );
    }

    #[test]
    fn edge_route_carries_immutable_job_authority_scope() {
        let now = Utc::now();
        let job = ExecutionJobRecord {
            id: "job-a".to_string(),
            revision: 0,
            activation_id: "activation-a".to_string(),
            thread_id: "thread-a".to_string(),
            agent_id: "agent-a".to_string(),
            context_id: "context-a".to_string(),
            session_id: "session-a".to_string(),
            initiating_principal_id: Some("principal-a".to_string()),
            target_id: "target-a".to_string(),
            tool_call_id: "call-a".to_string(),
            tool_name: "exec".to_string(),
            request: serde_json::json!({
                EXECUTION_ROUTE_REQUEST_KEY: {
                    "route_id": "route-a",
                    "target_id": "target-a",
                    "target_revision": 2,
                    "provider_node_id": "node-a",
                    "backend_kind": "edge_node",
                    "endpoint_ref": null,
                    "policy_digest": "target-policy"
                }
            }),
            status: ExecutionJobStatus::Queued,
            retry_safety: ExecutionRetrySafety::AtMostOnce,
            claimed_by: None,
            claim_token: None,
            lease_expires_at: None,
            heartbeat_at: None,
            approval_ref: None,
            side_effect_started_at: None,
            cancel_requested_at: None,
            cancel_reason: None,
            progress_ref: None,
            checkpoint_generation: None,
            checkpoint_due_at: None,
            result_event_id: None,
            result_refs: Vec::new(),
            error: None,
            exit_code: None,
            created_at: now,
            started_at: None,
            updated_at: now,
            finished_at: None,
        };
        let route = edge_command_route_from_job(&job).unwrap();
        let scope = edge_execution_scope_from_route(&route).unwrap();
        assert_eq!(scope.principal_id, "principal-a");
        assert_eq!(scope.thread_id, "thread-a");
        let frozen: ExecutionRouteSnapshot = serde_json::from_value(route).unwrap();
        assert_eq!(frozen.target_id, "target-a");
        assert_eq!(frozen.provider_node_id.as_deref(), Some("node-a"));
    }

    #[test]
    fn remote_preflight_keeps_target_paths_target_local() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-edge".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: Some("node-a".to_string()),
            kind: ExecutionTargetKind::EdgeNode,
            name: "Edge".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["read".to_string()],
            metadata: serde_json::json!({}),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement =
            remote_target_approval_requirement(&target, "read", r#"{"path":"src/lib.rs"}"#)
                .unwrap();
        assert_eq!(
            requirement.requested.read_roots,
            vec![std::path::PathBuf::from("src/lib.rs")]
        );
        assert!(matches!(
            requirement.action,
            ApprovalAction::ToolOperation { ref operation, .. }
                if operation == "execute_on_remote_target"
        ));
        let search = remote_target_approval_requirement(
            &target,
            "search",
            r#"{"query":"needle","paths":["src","tests"]}"#,
        )
        .unwrap();
        assert_eq!(
            search.requested.read_roots,
            vec![
                std::path::PathBuf::from("src"),
                std::path::PathBuf::from("tests")
            ]
        );
    }

    #[test]
    fn runtime_managed_ssh_registration_publishes_core_tools_and_transfer() {
        let temp = tempfile::TempDir::new().unwrap();
        let known_hosts = temp.path().join("known_hosts");
        std::fs::write(&known_hosts, "server.example ssh-ed25519 AAAA\n").unwrap();
        let endpoint = ManagedSshEndpoint {
            destination: None,
            host: "server.example".to_string(),
            user: Some("deploy".to_string()),
            port: 2222,
            known_hosts_file: known_hosts,
            approved: true,
            config_digest: None,
            auth_mode: ManagedSshAuthMode::KeyOnly,
            private_key_secret: None,
            private_key_passphrase_secret: None,
            password_secret: None,
        };
        let config = ManagedSshTargetConfig {
            id: "target-server".to_string(),
            name: "Server".to_string(),
            endpoint_ref: "server".to_string(),
            platform: Some("linux-x86_64".to_string()),
            workspace_root: Some("/srv/app".to_string()),
            ..ManagedSshTargetConfig::default()
        };

        let registration =
            runtime_managed_ssh_registration(&config, &endpoint, "principal-a", "policy-a")
                .unwrap();

        assert_eq!(registration.kind, ExecutionTargetKind::ManagedSsh);
        assert_eq!(registration.status, ExecutionTargetStatus::Online);
        assert_eq!(
            registration.owner_principal_id.as_deref(),
            Some("principal-a")
        );
        assert_eq!(registration.provider_node_id, None);
        assert_eq!(
            registration.capabilities,
            vec![
                "exec",
                "read",
                "write",
                "edit",
                "list_files",
                "search",
                "transfer"
            ]
        );
        assert_eq!(registration.metadata["execution_location"], "runtime");
        assert_eq!(registration.metadata["endpoint_ref"], "server");
        assert_eq!(registration.metadata["auth_mode"], "key_only");
        assert_eq!(registration.metadata["password_secret_configured"], false);
        assert_eq!(
            registration.metadata["private_key_secret_configured"],
            false
        );
        assert_eq!(
            registration.metadata["private_key_passphrase_secret_configured"],
            false
        );
        assert_eq!(registration.metadata["credential_source"], "host_openssh");
        assert!(registration.metadata["runtime_host_id"]
            .as_str()
            .is_some_and(|value| value.starts_with("runtime-host-")));
        assert_eq!(registration.metadata["protocol_version"], 4);
    }

    #[test]
    fn static_managed_ssh_endpoint_accepts_a_password_secret_alias_not_a_value() {
        let temp = tempfile::TempDir::new().unwrap();
        let known_hosts = temp.path().join("known_hosts");
        std::fs::write(&known_hosts, "server.example ssh-ed25519 AAAA\n").unwrap();
        let encoded = serde_json::json!({
            "host": "server.example",
            "user": "deploy",
            "port": 22,
            "known_hosts_file": known_hosts,
            "approved": true,
            "auth_mode": "password_only",
            "password_secret": "PRODUCTION_SSH_PASSWORD"
        });
        let endpoint: ManagedSshEndpoint = serde_json::from_value(encoded.clone()).unwrap();

        endpoint.validate().unwrap();
        assert_eq!(endpoint.auth_mode, ManagedSshAuthMode::PasswordOnly);
        assert_eq!(
            endpoint.password_secret.as_deref(),
            Some("PRODUCTION_SSH_PASSWORD")
        );
        assert!(!encoded.to_string().contains("password-value"));
    }

    #[test]
    fn managed_ssh_arguments_pin_transport_and_ignore_agent_permissions() {
        let temp = tempfile::TempDir::new().unwrap();
        let known_hosts = temp.path().join("known_hosts");
        std::fs::write(&known_hosts, "server.example ssh-ed25519 AAAA\n").unwrap();
        let endpoint = ManagedSshEndpoint {
            destination: None,
            host: "server.example".to_string(),
            user: Some("deploy".to_string()),
            port: 2222,
            known_hosts_file: known_hosts.clone(),
            approved: true,
            config_digest: None,
            auth_mode: ManagedSshAuthMode::KeyOnly,
            private_key_secret: None,
            private_key_passphrase_secret: None,
            password_secret: None,
        };
        validate_managed_ssh_endpoint_for_transfer("server", &endpoint).unwrap();

        let prepared = build_managed_ssh_exec_arguments(
            "server",
            &endpoint,
            "target-server",
            r#"{
                "command":"printf '%s' \"$TOKEN\"",
                "cwd":"/srv/app dir",
                "wait_ms":2500,
                "sandbox_permissions":"use_default",
                "requested_permissions":{"write_paths":["/"]}
            }"#,
            &ManagedSshCredentialMaterial::default(),
        )
        .unwrap();
        let prepared: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared["command"].as_str().unwrap();

        #[cfg(unix)]
        {
            assert!(command.contains("'ssh' '-F' '/dev/null'"));
            assert!(command.contains("'IdentitiesOnly=no'"));
            assert!(command.contains("'ConnectTimeout=30'"));
            assert!(command.contains("'ConnectionAttempts=1'"));
            assert!(command.contains("'ServerAliveInterval=15'"));
            assert!(command.contains("'ServerAliveCountMax=2'"));
            assert!(command.contains("'StrictHostKeyChecking=yes'"));
            assert!(command.contains("'deploy@server.example'"));
            let expected_remote =
                managed_ssh_posix_remote_command("cd -- '/srv/app dir' && printf '%s' \"$TOKEN\"");
            assert!(command.contains(&shell_quote(&expected_remote)));
        }
        #[cfg(windows)]
        {
            let arguments = decode_windows_managed_ssh_arguments(command);
            for expected in [
                "-F",
                "NUL",
                "IdentitiesOnly=no",
                "ConnectTimeout=30",
                "ConnectionAttempts=1",
                "ServerAliveInterval=15",
                "ServerAliveCountMax=2",
                "StrictHostKeyChecking=yes",
                "deploy@server.example",
            ] {
                assert!(arguments.iter().any(|argument| argument == expected));
            }
            let expected_remote =
                managed_ssh_posix_remote_command("cd -- '/srv/app dir' && printf '%s' \"$TOKEN\"");
            assert!(arguments
                .iter()
                .any(|argument| argument == &expected_remote));
        }
        assert_eq!(prepared["sandbox_permissions"], "require_escalated");
        assert_eq!(prepared["requested_permissions"]["network"], true);
        assert_eq!(
            prepared["requested_permissions"]["read_paths"][0],
            known_hosts.to_string_lossy().as_ref()
        );
        let expected_secret_env =
            if std::env::var_os("SSH_AUTH_SOCK").is_some_and(|value| !value.is_empty()) {
                serde_json::json!(["SSH_AUTH_SOCK"])
            } else {
                serde_json::json!([])
            };
        assert_eq!(
            prepared["requested_permissions"]["secret_env"],
            expected_secret_env
        );
        assert!(prepared["requested_permissions"]
            .get("write_paths")
            .is_none());
    }

    #[test]
    fn managed_ssh_password_uses_one_shot_askpass_without_serializing_the_value() {
        let endpoint = ManagedSshEndpoint {
            destination: Some("workspace.featurize.cn".to_string()),
            host: "workspace.featurize.cn".to_string(),
            user: Some("featurize".to_string()),
            port: 47_557,
            known_hosts_file: PathBuf::new(),
            approved: true,
            config_digest: Some("sha256:test".to_string()),
            auth_mode: ManagedSshAuthMode::PasswordOnly,
            private_key_secret: None,
            private_key_passphrase_secret: None,
            password_secret: Some("FEATURIZE_SSH_PASSWORD".to_string()),
        };
        let password = "password-value-that-must-not-be-serialized";
        let authentication = ManagedSshAuthentication {
            password: Some(Arc::new(Zeroizing::new(password.to_string()))),
            ..ManagedSshAuthentication::default()
        };
        let credentials = managed_ssh_credentials(&endpoint, &authentication).unwrap();
        let askpass = credentials.askpass.as_ref().unwrap();
        let prepared = build_managed_ssh_exec_arguments(
            "runtime_ssh_test",
            &endpoint,
            "target-ssh-test",
            r#"{"command":"whoami"}"#,
            &credentials,
        )
        .unwrap();
        let prepared_json: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared_json["command"].as_str().unwrap();

        assert!(!prepared.contains(password));
        #[cfg(unix)]
        assert!(!std::fs::read_to_string(&askpass.helper_path)
            .unwrap()
            .contains(password));
        #[cfg(unix)]
        assert!(command.starts_with("'env' "));
        #[cfg(windows)]
        assert!(command.starts_with("powershell.exe "));
        #[cfg(unix)]
        assert!(command.contains("'PreferredAuthentications=password'"));
        #[cfg(unix)]
        assert!(command.contains("'PubkeyAuthentication=no'"));
        assert_eq!(
            prepared_json["requested_permissions"]["secret_env"],
            serde_json::json!(["FEATURIZE_SSH_PASSWORD"])
        );

        #[cfg(unix)]
        {
            let output = std::process::Command::new(&askpass.helper_path)
                .arg("Enter passphrase for key")
                .env(
                    "MORPHZ_SSH_PASSWORD_FIFO",
                    askpass.password_pipe_path.as_ref().unwrap(),
                )
                .output()
                .unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());

            let output = std::process::Command::new(&askpass.helper_path)
                .arg("featurize@workspace.featurize.cn's password:")
                .env(
                    "MORPHZ_SSH_PASSWORD_FIFO",
                    askpass.password_pipe_path.as_ref().unwrap(),
                )
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{password}\n")
            );
        }
        #[cfg(windows)]
        {
            assert!(read_windows_ssh_askpass_value(
                "Enter passphrase for key",
                askpass.password_pipe_path.as_deref(),
                None,
            )
            .is_err());
            assert_eq!(
                read_windows_ssh_askpass_value(
                    "featurize@workspace.featurize.cn's password:",
                    askpass.password_pipe_path.as_deref(),
                    None,
                )
                .unwrap()
                .as_str(),
                password
            );
        }
    }

    #[test]
    fn managed_ssh_private_key_is_ephemeral_and_passphrase_uses_askpass() {
        let endpoint = ManagedSshEndpoint {
            destination: Some("compute.example".to_string()),
            host: "compute.example".to_string(),
            user: Some("researcher".to_string()),
            port: 22,
            known_hosts_file: PathBuf::new(),
            approved: true,
            config_digest: Some("sha256:test".to_string()),
            auth_mode: ManagedSshAuthMode::KeyOnly,
            private_key_secret: Some("SCNET_SSH_KEY".to_string()),
            private_key_passphrase_secret: Some("SCNET_SSH_KEY_PASSPHRASE".to_string()),
            password_secret: None,
        };
        let private_key =
            "-----BEGIN OPENSSH PRIVATE KEY-----\ntest-material\n-----END OPENSSH PRIVATE KEY-----";
        let passphrase = "private-key-passphrase";
        let authentication = ManagedSshAuthentication {
            private_key: Some(Arc::new(Zeroizing::new(private_key.to_string()))),
            private_key_passphrase: Some(Arc::new(Zeroizing::new(passphrase.to_string()))),
            password: None,
        };
        let credentials = managed_ssh_credentials(&endpoint, &authentication).unwrap();
        let identity_path = credentials.identity.as_ref().unwrap().path.clone();
        assert_eq!(
            std::fs::read_to_string(&identity_path).unwrap(),
            format!("{private_key}\n")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&identity_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let prepared = build_managed_ssh_exec_arguments(
            "runtime_ssh_test",
            &endpoint,
            "target-ssh-test",
            r#"{"command":"hostname"}"#,
            &credentials,
        )
        .unwrap();
        let prepared_json: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared_json["command"].as_str().unwrap();
        assert!(!prepared.contains(private_key));
        assert!(!prepared.contains(passphrase));
        #[cfg(unix)]
        assert!(command.starts_with("'env' "));
        #[cfg(unix)]
        assert!(command.contains("'-u' 'SCNET_SSH_KEY'"));
        #[cfg(unix)]
        assert!(command.contains("'-u' 'SCNET_SSH_KEY_PASSPHRASE'"));
        #[cfg(unix)]
        assert!(command.contains("'-u' 'SSH_AUTH_SOCK'"));
        #[cfg(unix)]
        assert!(command.contains("'IdentityFile=none'"));
        #[cfg(unix)]
        assert!(command.contains("'IdentitiesOnly=yes'"));
        #[cfg(unix)]
        assert!(command.contains(&shell_quote(&identity_path.display().to_string())));
        #[cfg(unix)]
        assert!(command.contains("'BatchMode=no'"));
        #[cfg(unix)]
        assert!(command.contains("'PreferredAuthentications=publickey'"));
        #[cfg(windows)]
        assert!(command.starts_with("powershell.exe "));
        assert_eq!(
            prepared_json["requested_permissions"]["secret_env"],
            serde_json::json!(["SCNET_SSH_KEY", "SCNET_SSH_KEY_PASSPHRASE"])
        );

        let askpass = credentials.askpass.as_ref().unwrap();
        #[cfg(unix)]
        {
            let output = std::process::Command::new(&askpass.helper_path)
                .arg(format!(
                    "Enter passphrase for key '{}':",
                    identity_path.display()
                ))
                .env(
                    "MORPHZ_SSH_KEY_PASSPHRASE_FIFO",
                    askpass.key_passphrase_pipe_path.as_ref().unwrap(),
                )
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{passphrase}\n")
            );
        }
        #[cfg(windows)]
        assert_eq!(
            read_windows_ssh_askpass_value(
                &format!("Enter passphrase for key '{}':", identity_path.display()),
                None,
                askpass.key_passphrase_pipe_path.as_deref(),
            )
            .unwrap()
            .as_str(),
            passphrase
        );

        drop(credentials);
        assert!(!identity_path.exists());
    }

    #[test]
    fn managed_ssh_private_key_preflight_uses_only_target_bound_secrets() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-key".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH compute.example".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({
                "execution_location": "runtime",
                "auth_mode": "key_only",
                "private_key_secret": "SCNET_SSH_KEY",
                "private_key_passphrase_secret": "SCNET_SSH_KEY_PASSPHRASE"
            }),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement = remote_target_approval_requirement(
            &target,
            "exec",
            r#"{"command":"hostname","requested_permissions":{"secret_env":["UNRELATED"]}}"#,
        )
        .unwrap();
        assert_eq!(
            requirement.requested.secret_env,
            vec!["SCNET_SSH_KEY", "SCNET_SSH_KEY_PASSPHRASE"]
        );
    }

    #[test]
    fn managed_ssh_password_preflight_uses_only_the_target_bound_secret() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-password".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH featurize@workspace.featurize.cn:47557".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({
                "execution_location": "runtime",
                "auth_mode": "password_only",
                "password_secret": "FEATURIZE_SSH_PASSWORD"
            }),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement = remote_target_approval_requirement(
            &target,
            "exec",
            r#"{
                "command":"whoami",
                "requested_permissions":{"secret_env":["UNRELATED_SECRET"]}
            }"#,
        )
        .unwrap();

        assert_eq!(
            requirement.requested.secret_env,
            vec!["FEATURIZE_SSH_PASSWORD"]
        );
    }

    #[test]
    fn runtime_host_uses_openssh_config_without_static_endpoint_files() {
        let endpoint = managed_ssh_endpoint_from_expanded(
            "production",
            "host production\nhostname server.example\nuser deploy\nport 2222\n",
        )
        .unwrap();
        assert_eq!(endpoint.destination.as_deref(), Some("production"));
        assert_eq!(endpoint.host, "server.example");
        assert_eq!(endpoint.user.as_deref(), Some("deploy"));
        assert_eq!(endpoint.port, 2222);
        assert!(endpoint.config_digest.is_some());

        let prepared = build_managed_ssh_exec_arguments(
            "runtime_alias",
            &endpoint,
            "target-ssh-runtime",
            r#"{"command":"uname -a","cwd":"/srv/app"}"#,
            &ManagedSshCredentialMaterial::default(),
        )
        .unwrap();
        let prepared: serde_json::Value = serde_json::from_str(&prepared).unwrap();
        let command = prepared["command"].as_str().unwrap();
        #[cfg(unix)]
        {
            assert!(command.starts_with("'ssh' "));
            assert!(!command.contains("'-F' '/dev/null'"));
            assert!(!command.contains("'IdentitiesOnly=no'"));
            assert!(command.contains("'ConnectTimeout=30'"));
            assert!(command.contains("'ConnectionAttempts=1'"));
            assert!(command.contains("'ServerAliveInterval=15'"));
            assert!(command.contains("'ServerAliveCountMax=2'"));
            assert!(command.contains("'StrictHostKeyChecking=yes'"));
            assert!(command.contains("'-l' 'deploy'"));
            assert!(command.contains("'-p' '2222'"));
            assert!(command.contains("'--' 'production'"));
        }
        #[cfg(windows)]
        {
            let arguments = decode_windows_managed_ssh_arguments(command);
            assert!(!arguments.iter().any(|argument| argument == "-F"));
            assert!(!arguments
                .iter()
                .any(|argument| argument == "IdentitiesOnly=no"));
            for expected in [
                "ConnectTimeout=30",
                "ConnectionAttempts=1",
                "ServerAliveInterval=15",
                "ServerAliveCountMax=2",
                "StrictHostKeyChecking=yes",
                "-l",
                "deploy",
                "-p",
                "2222",
                "--",
                "production",
            ] {
                assert!(arguments.iter().any(|argument| argument == expected));
            }
        }
        assert_eq!(prepared["requested_permissions"]["network"], true);
        assert_eq!(
            prepared["requested_permissions"]["read_paths"],
            serde_json::json!([])
        );
    }

    #[test]
    fn system_openssh_target_identity_is_scoped_to_the_runtime_host() {
        let endpoint = managed_ssh_endpoint_from_expanded(
            "mini-m4.local",
            "host mini-m4.local\nhostname mini-m4.local\nuser shafreeck\nport 22\n",
        )
        .unwrap();
        let first = runtime_managed_ssh_target_id(
            "principal-a",
            "mini-m4.local",
            &endpoint,
            "runtime-host-mini-m2",
        );
        let second = runtime_managed_ssh_target_id(
            "principal-a",
            "mini-m4.local",
            &endpoint,
            "runtime-host-mbp",
        );
        assert_ne!(first, second);
    }

    #[test]
    fn secret_backed_ssh_target_identity_is_portable_between_runtime_hosts() {
        let mut endpoint = managed_ssh_endpoint_from_expanded(
            "mini-m4.local",
            "host mini-m4.local\nhostname mini-m4.local\nuser shafreeck\nport 22\n",
        )
        .unwrap();
        endpoint.private_key_secret = Some("SCNET_SSH_KEY".to_string());
        let first = runtime_managed_ssh_target_id(
            "principal-a",
            "mini-m4.local",
            &endpoint,
            "runtime-host-mini-m2",
        );
        let second = runtime_managed_ssh_target_id(
            "principal-a",
            "mini-m4.local",
            &endpoint,
            "runtime-host-mbp",
        );
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn configured_system_openssh_registration_does_not_probe_remote() {
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("configured-ssh.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = RuntimeManagedSshProvisioner::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            test_secret_store(temp.path()),
            "principal-default".to_string(),
            "policy-a".to_string(),
        )
        .with_test_host_and_probe("runtime-host-test-a", Arc::new(UnavailableManagedSshProbe));
        let endpoint = managed_ssh_endpoint_from_expanded(
            "mini-m4.local",
            "host mini-m4.local\nhostname mini-m4.local\nuser shafreeck\nport 22\n",
        )
        .unwrap();
        let config = ManagedSshTargetConfig {
            id: "target-configured-mini-m4".to_string(),
            name: "mini-m4".to_string(),
            endpoint_ref: "runtime_alias".to_string(),
            owner_principal_id: Some("principal-default".to_string()),
            platform: None,
            workspace_root: None,
        };

        let target = provisioner
            .register_configured_target(&config, endpoint)
            .await
            .unwrap();

        // The injected probe always fails. Online proves registration did not
        // invoke it: configured routes are dialed only when actually used.
        assert_eq!(target.status, ExecutionTargetStatus::Online);
        assert_eq!(target.metadata["credential_source"], "host_openssh");
        assert_eq!(target.metadata["runtime_host_id"], "runtime-host-test-a");
        assert!(target.last_seen_at.is_some());
        assert!(endpoints.read().unwrap().contains_key("runtime_alias"));
    }

    #[tokio::test]
    async fn durable_system_openssh_route_restore_does_not_probe_remote() {
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("restored-ssh.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let endpoint = managed_ssh_endpoint_from_expanded(
            "mini-m4.local",
            "host mini-m4.local\nhostname mini-m4.local\nuser shafreeck\nport 22\n",
        )
        .unwrap();
        let config = ManagedSshTargetConfig {
            id: "target-restored-mini-m4".to_string(),
            name: "mini-m4".to_string(),
            endpoint_ref: "runtime_alias".to_string(),
            owner_principal_id: Some("principal-default".to_string()),
            platform: None,
            workspace_root: None,
        };
        let registration = runtime_managed_ssh_registration_for_host(
            &config,
            &endpoint,
            "principal-default",
            "policy-a",
            "runtime-host-test-a",
        )
        .unwrap();
        let target = store.register_execution_target(registration).await.unwrap();
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = RuntimeManagedSshProvisioner::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            test_secret_store(temp.path()),
            "principal-default".to_string(),
            "policy-a".to_string(),
        )
        .with_test_host_and_probe("runtime-host-test-a", Arc::new(UnavailableManagedSshProbe));

        provisioner.restore_route(&target).await.unwrap();

        assert!(endpoints.read().unwrap().contains_key("runtime_alias"));
        let persisted = store
            .get_execution_target(&target.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(persisted.status, ExecutionTargetStatus::Online);
        assert_eq!(persisted.revision, target.revision);
    }

    #[tokio::test]
    async fn system_openssh_target_cannot_be_rehydrated_by_another_runtime_host() {
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("foreign-ssh.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let endpoint = managed_ssh_endpoint_from_expanded(
            "localhost",
            "host localhost\nhostname localhost\nuser shafreeck\nport 22\n",
        )
        .unwrap();
        let config = ManagedSshTargetConfig {
            id: "target-owned-by-a".to_string(),
            name: "localhost".to_string(),
            endpoint_ref: "runtime_alias".to_string(),
            owner_principal_id: Some("principal-default".to_string()),
            platform: None,
            workspace_root: None,
        };
        let registration = runtime_managed_ssh_registration_for_host(
            &config,
            &endpoint,
            "principal-default",
            "policy-a",
            "runtime-host-test-a",
        )
        .unwrap();
        let target = store.register_execution_target(registration).await.unwrap();
        let provisioner = RuntimeManagedSshProvisioner::new(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            endpoints,
            test_secret_store(temp.path()),
            "principal-default".to_string(),
            "policy-a".to_string(),
        )
        .with_test_host_and_probe(
            "runtime-host-test-b",
            Arc::new(AlwaysAvailableManagedSshProbe),
        );

        assert!(!provisioner.belongs_to_current_runtime_host(&target));
        let error = provisioner.rehydrate(&target).await.unwrap_err();
        assert!(error.to_string().contains("must not rehydrate"));
    }

    #[test]
    fn managed_ssh_commands_enter_posix_sh_before_runtime_syntax() {
        let wrapped = managed_ssh_posix_remote_command(
            "if test -f /tmp/example; then printf file; else printf absent; fi",
        );
        assert!(wrapped.starts_with("exec sh -c "));
        if std::process::Command::new("fish")
            .arg("--version")
            .output()
            .is_ok()
        {
            let output = std::process::Command::new("fish")
                .arg("-c")
                .arg(&wrapped)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert_eq!(String::from_utf8(output.stdout).unwrap(), "absent");
        }
    }

    #[test]
    fn managed_ssh_preflight_always_requests_network_approval() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-a".to_string(),
            revision: 1,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH production".to_string(),
            status: ExecutionTargetStatus::Online,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({"host": "production"}),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };
        let requirement =
            remote_target_approval_requirement(&target, "exec", r#"{"command":"uname -a"}"#)
                .unwrap();
        assert!(requirement.requested.network);
        assert!(requirement.justification.contains("Runtime"));
        assert!(requirement.justification.contains("target-ssh-a"));
        assert!(requirement.justification.contains("SSH production"));
    }

    #[tokio::test]
    async fn resolve_target_provisions_a_runtime_ssh_host_without_prior_registration() {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(temp.path().join("runtime-ssh.db").to_str().unwrap())
                .await
                .unwrap(),
        );
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = test_runtime_managed_ssh_provisioner(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            test_secret_store(temp.path()),
        );
        let tool = ResolveTargetTool::new(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
            .with_runtime_managed_ssh(provisioner);

        let output = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"deploy",
                        "port":2222,
                        "capabilities":["exec"],
                        "workspace_root":"/srv/app"
                    }"#,
                ),
            )
            .await
            .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        let target_id = output["target_id"].as_str().unwrap();
        let target = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(output["kind"], "managed_ssh");
        assert_eq!(output["host"], "localhost");
        assert_eq!(output["user"], "deploy");
        assert_eq!(output["port"], 2222);
        assert_eq!(target.owner_principal_id.as_deref(), Some("principal-a"));
        assert_eq!(target.workspace_root.as_deref(), Some("/srv/app"));
        assert_eq!(target.metadata["execution_location"], "runtime");
        assert_eq!(endpoints.read().unwrap().len(), 1);

        let second = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"root",
                        "port":2222,
                        "capabilities":["exec"]
                    }"#,
                ),
            )
            .await
            .unwrap();
        let second: serde_json::Value = serde_json::from_str(&second).unwrap();
        assert_ne!(second["target_id"], output["target_id"]);
        assert_eq!(second["user"], "root");
        assert_eq!(endpoints.read().unwrap().len(), 2);

        let first = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();
        store
            .set_execution_target_status(target_id, first.revision, ExecutionTargetStatus::Offline)
            .await
            .unwrap();
        endpoints.write().unwrap().clear();

        let recovered = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(&format!(r#"{{"target_id":"{target_id}"}}"#)),
            )
            .await
            .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(&recovered).unwrap();
        assert_eq!(recovered["target_id"], target_id);
        assert_eq!(recovered["status"], "online");
        assert_eq!(
            recovered["runtime_availability"]["availability"],
            "ready_on_demand"
        );
        assert_eq!(endpoints.read().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn resolve_target_binds_and_recovers_a_password_secret_without_persisting_its_value() {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(
                temp.path()
                    .join("runtime-ssh-password.db")
                    .to_str()
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        let secrets = test_secret_store(temp.path());
        let password = "runtime-secret-value";
        secrets
            .put(
                "FEATURIZE_SSH_PASSWORD",
                password,
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = test_runtime_managed_ssh_provisioner(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            Arc::clone(&secrets),
        );
        let tool = ResolveTargetTool::new(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
            .with_runtime_managed_ssh(provisioner);

        let output = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"featurize",
                        "port":47557,
                        "password_secret":"FEATURIZE_SSH_PASSWORD"
                    }"#,
                ),
            )
            .await
            .unwrap();
        assert!(!output.contains(password));
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["auth_mode"], "password_only");
        assert_eq!(output["password_secret_configured"], true);
        let target_id = output["target_id"].as_str().unwrap();
        let target = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.metadata["auth_mode"], "password_only");
        assert_eq!(target.metadata["password_secret"], "FEATURIZE_SSH_PASSWORD");
        assert!(!serde_json::to_string(&target).unwrap().contains(password));

        store
            .set_execution_target_status(target_id, target.revision, ExecutionTargetStatus::Offline)
            .await
            .unwrap();
        endpoints.write().unwrap().clear();
        let recovered = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(&format!(r#"{{"target_id":"{target_id}"}}"#)),
            )
            .await
            .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(&recovered).unwrap();
        assert_eq!(recovered["auth_mode"], "password_only");
        let endpoint = endpoints.read().unwrap().values().next().unwrap().clone();
        assert_eq!(endpoint.auth_mode, ManagedSshAuthMode::PasswordOnly);
        assert_eq!(
            endpoint.password_secret.as_deref(),
            Some("FEATURIZE_SSH_PASSWORD")
        );

        let key_only = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(&format!(
                    r#"{{"target_id":"{target_id}","auth_mode":"key_only"}}"#
                )),
            )
            .await
            .unwrap();
        let key_only: serde_json::Value = serde_json::from_str(&key_only).unwrap();
        assert_eq!(key_only["auth_mode"], "key_only");
        assert_eq!(key_only["password_secret_configured"], false);
    }

    #[tokio::test]
    async fn resolve_target_binds_and_recovers_private_key_secrets_without_persisting_values() {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return;
        }
        let temp = tempfile::TempDir::new().unwrap();
        let store = Arc::new(
            SqliteStore::new(
                temp.path()
                    .join("runtime-ssh-private-key.db")
                    .to_str()
                    .unwrap(),
            )
            .await
            .unwrap(),
        );
        let secrets = test_secret_store(temp.path());
        let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-test-value\n-----END OPENSSH PRIVATE KEY-----";
        let passphrase = "secret-passphrase-value";
        secrets
            .put("SCNET_SSH_KEY", private_key, SecretScopeKind::Runtime, None)
            .unwrap();
        secrets
            .put(
                "SCNET_SSH_KEY_PASSPHRASE",
                passphrase,
                SecretScopeKind::Runtime,
                None,
            )
            .unwrap();
        let endpoints = Arc::new(RwLock::new(HashMap::new()));
        let provisioner = test_runtime_managed_ssh_provisioner(
            Arc::clone(&store) as Arc<dyn ExecutionTargetStore>,
            Arc::clone(&endpoints),
            Arc::clone(&secrets),
        );
        let tool = ResolveTargetTool::new(Arc::clone(&store) as Arc<dyn ExecutionTargetStore>)
            .with_runtime_managed_ssh(provisioner);

        let output = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(
                    r#"{
                        "kind":"managed_ssh",
                        "host":"localhost",
                        "user":"researcher",
                        "private_key_secret":"SCNET_SSH_KEY",
                        "private_key_passphrase_secret":"SCNET_SSH_KEY_PASSPHRASE"
                    }"#,
                ),
            )
            .await
            .unwrap();
        assert!(!output.contains(private_key));
        assert!(!output.contains(passphrase));
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["auth_mode"], "key_only");
        assert_eq!(output["private_key_secret_configured"], true);
        assert_eq!(output["private_key_passphrase_secret_configured"], true);
        let target_id = output["target_id"].as_str().unwrap();
        let target = store
            .get_execution_target(target_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(target.metadata["private_key_secret"], "SCNET_SSH_KEY");
        assert_eq!(
            target.metadata["private_key_passphrase_secret"],
            "SCNET_SSH_KEY_PASSPHRASE"
        );
        let serialized_target = serde_json::to_string(&target).unwrap();
        assert!(!serialized_target.contains(private_key));
        assert!(!serialized_target.contains(passphrase));

        store
            .set_execution_target_status(target_id, target.revision, ExecutionTargetStatus::Offline)
            .await
            .unwrap();
        endpoints.write().unwrap().clear();
        let recovered = CURRENT_PRINCIPAL_ID
            .scope(
                Some("principal-a".to_string()),
                tool.execute(&format!(r#"{{"target_id":"{target_id}"}}"#)),
            )
            .await
            .unwrap();
        let recovered: serde_json::Value = serde_json::from_str(&recovered).unwrap();
        assert_eq!(recovered["auth_mode"], "key_only");
        assert_eq!(recovered["private_key_secret_configured"], true);
        let endpoint = endpoints.read().unwrap().values().next().unwrap().clone();
        assert_eq!(
            endpoint.private_key_secret.as_deref(),
            Some("SCNET_SSH_KEY")
        );
        assert_eq!(
            endpoint.private_key_passphrase_secret.as_deref(),
            Some("SCNET_SSH_KEY_PASSPHRASE")
        );
    }

    #[test]
    fn runtime_managed_ssh_offline_is_described_as_recoverable_route_state() {
        let now = Utc::now();
        let target = ExecutionTargetRecord {
            id: "target-ssh-a".to_string(),
            revision: 2,
            owner_principal_id: Some("principal-a".to_string()),
            provider_node_id: None,
            kind: ExecutionTargetKind::ManagedSsh,
            name: "SSH production".to_string(),
            status: ExecutionTargetStatus::Offline,
            platform: None,
            workspace_root: None,
            capabilities: vec!["exec".to_string()],
            metadata: serde_json::json!({
                "execution_location": "runtime",
                "host": "production"
            }),
            policy_digest: "policy-a".to_string(),
            created_at: now,
            updated_at: now,
            last_seen_at: Some(now),
        };

        let availability = target_runtime_availability(&target);
        assert_eq!(availability["availability"], "route_needs_rehydration");
        assert_eq!(availability["recoverable"], true);
        assert!(availability["status_explanation"]
            .as_str()
            .unwrap()
            .contains("does not mean the remote host"));
    }

    #[test]
    fn direct_ssh_programs_are_distinguished_from_ordinary_arguments() {
        assert!(exec_arguments_invoke_ssh(r#"{"command":"ssh server uptime"}"#).unwrap());
        assert!(exec_arguments_invoke_ssh(
            r#"{"command":"cd repo && /usr/bin/scp file server:/tmp"}"#
        )
        .unwrap());
        assert!(exec_arguments_invoke_ssh(
            r#"{"command":"env SSH_AUTH_SOCK=/tmp/agent sftp server"}"#
        )
        .unwrap());
        assert!(!exec_arguments_invoke_ssh(r#"{"command":"echo ssh server"}"#).unwrap());
        assert!(!exec_arguments_invoke_ssh(r#"{"command":"rg ssh docs"}"#).unwrap());
    }

    #[tokio::test]
    async fn canonical_directory_archive_is_stable_and_safely_published() {
        let temp = tempfile::TempDir::new().unwrap();
        let source = temp.path().join("source");
        let first_archive = temp.path().join("first.tar");
        let second_archive = temp.path().join("second.tar");
        let destination = temp.path().join("destination");
        tokio::fs::create_dir_all(source.join("nested"))
            .await
            .unwrap();
        tokio::fs::write(source.join("root.txt"), b"root")
            .await
            .unwrap();
        tokio::fs::write(source.join("nested/leaf.txt"), b"leaf")
            .await
            .unwrap();

        let first = create_canonical_directory_archive(&source, &first_archive)
            .await
            .unwrap();
        let second = create_canonical_directory_archive(&source, &second_archive)
            .await
            .unwrap();
        assert_eq!(first.kind, StagedArtifactKind::DirectoryArchive);
        assert_eq!(first.payload_digest, second.payload_digest);
        assert_eq!(first.payload_size_bytes, second.payload_size_bytes);
        assert_eq!(first.logical_digest, second.logical_digest);
        assert_eq!(first.logical_size_bytes, second.logical_size_bytes);
        let (logical_size, logical_digest) =
            crate::artifact::inspect_local_directory_artifact(&source)
                .await
                .unwrap();
        assert_eq!(first.logical_size_bytes, Some(logical_size));
        assert_eq!(
            first.logical_digest.as_deref(),
            Some(logical_digest.as_str())
        );
        assert_ne!(
            first.payload_digest,
            first.logical_digest.clone().unwrap(),
            "transport envelope and logical directory identity are distinct"
        );

        let request = crate::artifact::ArtifactTransferRequest {
            transfer_id: "directory-cross-target".to_string(),
            source: crate::artifact::ArtifactLocation {
                target_id: "target-source".to_string(),
                workspace_identity: None,
                path: source.display().to_string(),
            },
            destination: crate::artifact::ArtifactLocation {
                target_id: "target-default".to_string(),
                workspace_identity: None,
                path: destination.display().to_string(),
            },
            overwrite: crate::artifact::ArtifactOverwritePolicy::Deny,
            expected_source_digest: first.logical_digest.clone(),
            media_type: None,
            origin: None,
        };
        publish_spooled_local_directory(&request, &first_archive, &destination)
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(destination.join("nested/leaf.txt"))
                .await
                .unwrap(),
            b"leaf"
        );
        // A retry after publication reconciles by canonical content digest.
        publish_spooled_local_directory(&request, &first_archive, &destination)
            .await
            .unwrap();
    }

    #[test]
    fn managed_ssh_file_tool_bootstrap_does_not_depend_on_the_login_shell() {
        let bootstrap = managed_ssh_file_tool_command();
        let command = managed_ssh_posix_remote_command(&bootstrap);
        assert!(bootstrap.starts_with("if "));
        assert!(command.starts_with("exec sh -c "));

        if std::process::Command::new("fish")
            .arg("--version")
            .output()
            .is_err()
            || std::process::Command::new("python3")
                .arg("--version")
                .output()
                .is_err()
        {
            return;
        }

        let temp = tempfile::TempDir::new().unwrap();
        let request = serde_json::json!({
            "operation": "list_files",
            "workspace_root": temp.path().display().to_string(),
            "arguments": {"path": ".", "max_depth": 1}
        });
        let mut child = std::process::Command::new("fish")
            .arg("-c")
            .arg(&command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(
            child.stdin.as_mut().unwrap(),
            serde_json::to_string(&request).unwrap().as_bytes(),
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "fish must be able to hand the bootstrap to sh: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], true);
    }

    #[test]
    fn managed_ssh_protocol_supports_core_file_tools() {
        let python = std::process::Command::new("python3")
            .arg("--version")
            .output();
        if !python.is_ok_and(|output| output.status.success()) {
            return;
        }
        fn invoke(request: serde_json::Value) -> serde_json::Value {
            let mut child = std::process::Command::new("python3")
                .arg("-c")
                .arg(MANAGED_SSH_FILE_TOOL_SCRIPT)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            std::io::Write::write_all(
                child.stdin.as_mut().unwrap(),
                serde_json::to_string(&request).unwrap().as_bytes(),
            )
            .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "Managed SSH file protocol helper failed with status {:?}; stdout={}; stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            serde_json::from_slice(&output.stdout).unwrap()
        }

        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().display().to_string();
        let written = invoke(serde_json::json!({
            "operation": "write",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "content": "pub fn generated() {}\n", "mode": "create"}
        }));
        // The protocol deliberately does not create missing parent directories.
        assert_eq!(written["ok"], false);
        std::fs::create_dir_all(temp.path().join("src")).unwrap();
        let written = invoke(serde_json::json!({
            "operation": "write",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "content": "pub fn generated() {}\n", "mode": "create"}
        }));
        assert_eq!(written["ok"], true);

        let read = invoke(serde_json::json!({
            "operation": "read",
            "workspace_root": &workspace,
            "arguments": {"path": "src/lib.rs", "query": "generated"}
        }));
        assert_eq!(read["ok"], true);
        assert!(read["output"].as_str().unwrap().contains("sha256="));
        assert!(read["output"].as_str().unwrap().contains("generated"));

        std::fs::write(
            temp.path().join("src/pixel.png"),
            b"\x89PNG\r\n\x1a\nmanaged-ssh-image",
        )
        .unwrap();
        let image = invoke(serde_json::json!({
            "operation": "read",
            "workspace_root": &workspace,
            "arguments": {"path": "src/pixel.png"}
        }));
        assert_eq!(image["ok"], true);
        let image_result =
            ToolExecutionResult::decode_transport(image["output"].as_str().unwrap().to_string());
        assert_eq!(image_result.model_attachments.len(), 1);
        assert_eq!(image_result.model_attachments[0].media_type, "image/png");
        assert_eq!(image_result.model_attachments[0].name, "pixel.png");

        let rejected_image = invoke(serde_json::json!({
            "operation": "read",
            "workspace_root": &workspace,
            "max_model_input_attachment_bytes": 8,
            "arguments": {"path": "src/pixel.png"}
        }));
        assert_eq!(rejected_image["ok"], false);
        assert!(rejected_image["error"]
            .as_str()
            .unwrap()
            .contains("per-file model input limit of 8 bytes"));

        let digest = read["output"]
            .as_str()
            .unwrap()
            .split("sha256=")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap();
        let edited = invoke(serde_json::json!({
            "operation": "edit",
            "workspace_root": &workspace,
            "arguments": {
                "path": "src/lib.rs",
                "expected_sha256": digest,
                "edits": [{"old_text": "generated", "new_text": "remote_generated"}]
            }
        }));
        assert_eq!(edited["ok"], true);

        let listed = invoke(serde_json::json!({
            "operation": "list_files",
            "workspace_root": &workspace,
            "arguments": {"path": "src", "glob": "**/*.rs"}
        }));
        assert_eq!(listed["ok"], true);
        let listing: serde_json::Value =
            serde_json::from_str(listed["output"].as_str().unwrap()).unwrap();
        assert_eq!(listing["count"], 1);
        assert_eq!(listing["entries"][0]["path"], "lib.rs");

        let search = invoke(serde_json::json!({
            "operation": "search",
            "workspace_root": &workspace,
            "arguments": {"paths": ["src"], "query": "remote_generated", "glob": "**/*.rs"}
        }));
        assert_eq!(search["ok"], true);
        let payload: serde_json::Value =
            serde_json::from_str(search["output"].as_str().unwrap()).unwrap();
        assert_eq!(payload["count"], 1);
        assert_eq!(payload["matches"][0]["path"], "src/lib.rs");
    }

    #[test]
    fn directory_archive_rejects_escaping_paths_and_links() {
        assert!(validate_archive_relative_path(Path::new("../escape")).is_err());
        assert!(validate_archive_relative_path(Path::new("/absolute")).is_err());
        assert!(validate_archive_link_target(Path::new("../../secret")).is_err());
        assert!(validate_archive_link_target(Path::new("nested/file")).is_ok());
    }
}
