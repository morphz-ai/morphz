use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fmt;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    Deny,
    Allow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPathPattern {
    /// Literal filesystem root. Keeping it separate from the glob prevents
    /// characters in a real pathname from being interpreted as glob syntax.
    pub root: PathBuf,
    /// Slash-separated glob relative to `root`.
    pub glob: String,
}

impl SandboxPathPattern {
    pub fn new(root: impl Into<PathBuf>, glob: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            glob: glob.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxPolicy {
    pub read_roots: Vec<PathBuf>,
    pub write_roots: Vec<PathBuf>,
    pub denied_read_paths: Vec<PathBuf>,
    pub denied_write_paths: Vec<PathBuf>,
    pub denied_read_patterns: Vec<SandboxPathPattern>,
    pub denied_write_patterns: Vec<SandboxPathPattern>,
    pub network: NetworkPolicy,
    pub fail_closed: bool,
}

impl SandboxPolicy {
    pub fn workspace(workspace_root: impl Into<PathBuf>) -> Self {
        let workspace_root = workspace_root.into();
        Self {
            read_roots: vec![workspace_root.clone()],
            write_roots: vec![workspace_root],
            denied_read_paths: Vec::new(),
            denied_write_paths: Vec::new(),
            denied_read_patterns: Vec::new(),
            denied_write_patterns: Vec::new(),
            network: NetworkPolicy::Deny,
            fail_closed: true,
        }
    }

    pub fn add_read_root(&mut self, root: impl Into<PathBuf>) {
        push_unique(&mut self.read_roots, root.into());
    }

    pub fn add_write_root(&mut self, root: impl Into<PathBuf>) {
        let root = root.into();
        push_unique(&mut self.read_roots, root.clone());
        push_unique(&mut self.write_roots, root);
    }

    pub fn deny_path(&mut self, path: impl Into<PathBuf>) {
        let path = path.into();
        push_unique(&mut self.denied_read_paths, path.clone());
        push_unique(&mut self.denied_write_paths, path);
    }

    pub fn deny_pattern(&mut self, pattern: SandboxPathPattern) {
        push_unique_pattern(&mut self.denied_read_patterns, pattern.clone());
        push_unique_pattern(&mut self.denied_write_patterns, pattern);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    MacOsSeatbelt,
    LinuxNative,
    WindowsNative,
    Unsupported,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MacOsSeatbelt => "macos-seatbelt",
            Self::LinuxNative => "linux-native",
            Self::WindowsNative => "windows-native",
            Self::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementStatus {
    Enforced,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendReport {
    pub backend: BackendKind,
    pub status: EnforcementStatus,
    pub notes: Vec<String>,
}

impl BackendReport {
    fn enforced(backend: BackendKind, note: impl Into<String>) -> Self {
        Self {
            backend,
            status: EnforcementStatus::Enforced,
            notes: vec![note.into()],
        }
    }

    fn unavailable(backend: BackendKind, note: impl Into<String>) -> Self {
        Self {
            backend,
            status: EnforcementStatus::Unavailable,
            notes: vec![note.into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellRequest {
    pub command: String,
    pub cwd: PathBuf,
    pub policy: SandboxPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedCommand {
    pub program: OsString,
    pub arguments: Vec<OsString>,
    /// Optional private startup payload consumed by a trusted wrapper before
    /// it launches the untrusted command. This avoids operating-system argv
    /// limits without exposing the payload to the child command line.
    pub startup_stdin: Option<Vec<u8>>,
    pub report: BackendReport,
}

impl PreparedCommand {
    pub fn into_tokio_command(self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(self.program);
        command.args(self.arguments);
        command
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxError {
    message: String,
}

impl SandboxError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SandboxError {}

pub trait SandboxBackend: Send + Sync {
    fn report(&self) -> BackendReport;

    fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError>;
}

#[derive(Clone)]
pub struct NativeSandbox {
    backend: Arc<dyn SandboxBackend>,
}

impl fmt::Debug for NativeSandbox {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeSandbox")
            .field("report", &self.backend.report())
            .finish()
    }
}

impl Default for NativeSandbox {
    fn default() -> Self {
        Self::for_current_platform()
    }
}

impl NativeSandbox {
    pub fn for_current_platform() -> Self {
        Self {
            backend: platform_backend(),
        }
    }

    pub fn with_backend(backend: Arc<dyn SandboxBackend>) -> Self {
        Self { backend }
    }

    pub fn report(&self) -> BackendReport {
        self.backend.report()
    }

    pub fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
        self.backend.prepare_shell(request)
    }

    pub fn prepare_unconfined_shell(&self, command: &str) -> PreparedCommand {
        PreparedCommand {
            program: platform_shell_program(),
            arguments: platform_shell_arguments(command),
            startup_stdin: None,
            report: BackendReport::unavailable(
                self.backend.report().backend,
                "the native sandbox is explicitly disabled by configuration; the command has no operating-system isolation",
            ),
        }
    }
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn push_unique_pattern(patterns: &mut Vec<SandboxPathPattern>, pattern: SandboxPathPattern) {
    if !patterns.iter().any(|existing| existing == &pattern) {
        patterns.push(pattern);
    }
}

fn canonical_roots(paths: &[PathBuf], kind: &str) -> Result<Vec<PathBuf>, SandboxError> {
    let mut roots = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = std::fs::canonicalize(path).map_err(|error| {
            SandboxError::new(format!(
                "failed to resolve sandbox {kind} root '{}': {error}",
                path.display()
            ))
        })?;
        push_unique(&mut roots, canonical);
    }
    Ok(roots)
}

/// Resolve a deny path without weakening the policy when the target disappears between
/// policy construction and sandbox compilation.
///
/// Allow roots must exist and be canonicalized: otherwise we cannot know what is being
/// granted. Deny roots are different. A protected file may legitimately be removed by a
/// concurrent process after discovery, and silently dropping that deny would allow a later
/// recreation at the same path. In that case we retain the normalized absolute pathname.
fn denied_roots(paths: &[PathBuf], kind: &str) -> Result<Vec<PathBuf>, SandboxError> {
    let mut roots = Vec::with_capacity(paths.len());
    for path in paths {
        let resolved = match std::fs::canonicalize(path) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == ErrorKind::NotFound => absolute_lexical_path(path)?,
            Err(error) => {
                return Err(SandboxError::new(format!(
                    "failed to resolve sandbox {kind} root '{}': {error}",
                    path.display()
                )));
            }
        };
        push_unique(&mut roots, resolved);
    }
    Ok(roots)
}

fn absolute_lexical_path(path: &Path) -> Result<PathBuf, SandboxError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| {
                SandboxError::new(format!("failed to read the current directory: {error}"))
            })?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(SandboxError::new(format!(
                        "sandbox deny path cannot be normalized: '{}'",
                        path.display()
                    )));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    Ok(normalized)
}

#[cfg(target_os = "macos")]
fn platform_backend() -> Arc<dyn SandboxBackend> {
    Arc::new(macos::MacOsSeatbeltBackend)
}

#[cfg(target_os = "linux")]
fn platform_backend() -> Arc<dyn SandboxBackend> {
    Arc::new(linux::LinuxBubblewrapBackend)
}

#[cfg(windows)]
fn platform_backend() -> Arc<dyn SandboxBackend> {
    Arc::new(windows::WindowsCodexBackend)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn platform_backend() -> Arc<dyn SandboxBackend> {
    Arc::new(UnsupportedNativeBackend::new(
        BackendKind::Unsupported,
        "the current operating system has no native Morphz sandbox Backend",
    ))
}

#[allow(dead_code)]
struct UnsupportedNativeBackend {
    kind: BackendKind,
    reason: String,
}

#[allow(dead_code)]
impl UnsupportedNativeBackend {
    fn new(kind: BackendKind, reason: impl Into<String>) -> Self {
        Self {
            kind,
            reason: reason.into(),
        }
    }
}

impl SandboxBackend for UnsupportedNativeBackend {
    fn report(&self) -> BackendReport {
        BackendReport::unavailable(self.kind, self.reason.clone())
    }

    fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
        if request.policy.fail_closed {
            return Err(SandboxError::new(format!(
                "{}; fail_closed=true refuses fallback to an unsandboxed Shell",
                self.reason
            )));
        }

        Ok(PreparedCommand {
            program: platform_shell_program(),
            arguments: platform_shell_arguments(&request.command),
            startup_stdin: None,
            report: self.report(),
        })
    }
}

#[cfg(windows)]
fn platform_shell_program() -> OsString {
    OsString::from("cmd.exe")
}

#[cfg(not(windows))]
fn platform_shell_program() -> OsString {
    OsString::from("/bin/sh")
}

#[cfg(windows)]
fn platform_shell_arguments(command: &str) -> Vec<OsString> {
    vec![OsString::from("/C"), OsString::from(command)]
}

#[cfg(not(windows))]
fn platform_shell_arguments(command: &str) -> Vec<OsString> {
    vec![OsString::from("-c"), OsString::from(command)]
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub struct MacOsSeatbeltBackend;

    impl SandboxBackend for MacOsSeatbeltBackend {
        fn report(&self) -> BackendReport {
            let executable = Path::new("/usr/bin/sandbox-exec");
            if executable.is_file() {
                BackendReport::enforced(
                    BackendKind::MacOsSeatbelt,
                    "macOS Seatbelt is available through /usr/bin/sandbox-exec",
                )
            } else {
                BackendReport::unavailable(
                    BackendKind::MacOsSeatbelt,
                    "/usr/bin/sandbox-exec does not exist",
                )
            }
        }

        fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
            let report = self.report();
            if report.status != EnforcementStatus::Enforced {
                if request.policy.fail_closed {
                    return Err(SandboxError::new(format!(
                        "macOS Seatbelt is unavailable and fail_closed=true: {}",
                        report.notes.join("; ")
                    )));
                }
                return Ok(PreparedCommand {
                    program: platform_shell_program(),
                    arguments: platform_shell_arguments(&request.command),
                    startup_stdin: None,
                    report,
                });
            }

            let profile = build_profile(&request.policy)?;
            Ok(PreparedCommand {
                program: OsString::from("/usr/bin/sandbox-exec"),
                arguments: vec![
                    OsString::from("-p"),
                    OsString::from(profile),
                    platform_shell_program(),
                    OsString::from("-c"),
                    OsString::from(&request.command),
                ],
                startup_stdin: None,
                report,
            })
        }
    }

    pub fn build_profile(policy: &SandboxPolicy) -> Result<String, SandboxError> {
        let read_roots = canonical_roots(&policy.read_roots, "read")?;
        let write_roots = canonical_roots(&policy.write_roots, "write")?;
        let protected_reads = denied_roots(&policy.denied_read_paths, "denied read")?;
        let protected_writes = denied_roots(&policy.denied_write_paths, "denied write")?;
        let protected_read_patterns =
            denied_pattern_regexes(&policy.denied_read_patterns, "denied read pattern")?;
        let protected_write_patterns =
            denied_pattern_regexes(&policy.denied_write_patterns, "denied write pattern")?;
        if write_roots.is_empty() {
            return Err(SandboxError::new(
                "macOS Seatbelt policy requires at least one write root",
            ));
        }

        let network_rule = match policy.network {
            NetworkPolicy::Deny => "(deny network*)",
            NetworkPolicy::Allow => "(allow network*)",
        };
        let temp_dir = std::env::temp_dir();
        // Broad baseline denies establish a read allowlist and intentionally
        // precede its narrow exceptions. Protected paths are different: they
        // must follow every workspace/read-root allow so an allowed parent
        // can never override a protected descendant.
        let mut baseline_denied_read_roots =
            vec![std::fs::canonicalize(&temp_dir).unwrap_or(temp_dir)];
        let mut allowed_read_roots = Vec::new();
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            baseline_denied_read_roots
                .push(std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone()));
            allowed_read_roots.push(home.join(".cargo"));
            allowed_read_roots.push(home.join(".rustup"));
        }
        allowed_read_roots.extend(read_roots.iter().cloned());
        allowed_read_roots.extend(write_roots.iter().cloned());
        let baseline_denied_read_rules = baseline_denied_read_roots
            .iter()
            .map(|path| format!("(deny file-read* (subpath {}))", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join("\n");
        let protected_read_rules = protected_reads
            .iter()
            .map(|path| format!("(deny file-read* (subpath {}))", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join("\n");
        let protected_read_pattern_rules = protected_read_patterns
            .iter()
            .map(|pattern| format!("(deny file-read* (regex #\"{}\"))", sbpl_regex(pattern)))
            .collect::<Vec<_>>()
            .join("\n");
        let allowed_read_rules = allowed_read_roots
            .iter()
            .filter(|path| path.exists())
            .map(|path| format!("(subpath {})", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join(" ");
        let write_rules = write_roots
            .iter()
            .map(|path| format!("(subpath {})", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join(" ");
        let denied_write_rules = protected_writes
            .iter()
            .map(|path| format!("(deny file-write* (subpath {}))", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join("\n");
        let denied_write_pattern_rules = protected_write_patterns
            .iter()
            .map(|pattern| format!("(deny file-write* (regex #\"{}\"))", sbpl_regex(pattern)))
            .collect::<Vec<_>>()
            .join("\n");
        let read_rules = read_roots
            .iter()
            .chain(write_roots.iter())
            .map(|path| format!("(subpath {})", sbpl_quote(path)))
            .collect::<Vec<_>>()
            .join(" ");

        Ok(format!(
            "(version 1)\n\
             (allow default)\n\
             {network_rule}\n\
             (deny file-write*)\n\
             (allow file-write* {write_rules} (literal \"/dev/null\"))\n\
             {denied_write_rules}\n\
             {denied_write_pattern_rules}\n\
             {baseline_denied_read_rules}\n\
             (allow file-read* {allowed_read_rules})\n\
             (allow file-read* {read_rules})\n\
             {protected_read_rules}\n\
             {protected_read_pattern_rules}\n"
        ))
    }

    fn sbpl_quote(path: &Path) -> String {
        let value = path.to_string_lossy();
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }

    fn sbpl_regex(value: &str) -> String {
        value.replace('"', "\\\"")
    }

    fn denied_pattern_regexes(
        patterns: &[SandboxPathPattern],
        kind: &str,
    ) -> Result<Vec<String>, SandboxError> {
        let mut regexes = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            let root = std::fs::canonicalize(&pattern.root).map_err(|error| {
                SandboxError::new(format!(
                    "failed to resolve sandbox {kind} root '{}': {error}",
                    pattern.root.display()
                ))
            })?;
            let root = regex_literal(&root.to_string_lossy().replace('\\', "/"));
            let glob = glob_regex(&pattern.glob)?;
            let separator = if root == "/" { "" } else { "/" };
            regexes.push(format!("^{root}{separator}{glob}$"));
        }
        Ok(regexes)
    }

    fn regex_literal(value: &str) -> String {
        let mut escaped = String::with_capacity(value.len());
        for character in value.chars() {
            if matches!(
                character,
                '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\'
            ) {
                escaped.push('\\');
            }
            escaped.push(character);
        }
        escaped
    }

    /// Convert the validated Permission glob vocabulary into the regular
    /// expression accepted by Seatbelt. `**/` may consume zero or more path
    /// components; a lone `*` and `?` never cross a path separator.
    fn glob_regex(glob: &str) -> Result<String, SandboxError> {
        let normalized = glob.replace('\\', "/");
        let characters = normalized.chars().collect::<Vec<_>>();
        let mut index = 0usize;
        let mut regex = String::with_capacity(normalized.len().saturating_mul(2));
        while index < characters.len() {
            match characters[index] {
                '*' if characters.get(index + 1) == Some(&'*') => {
                    index += 2;
                    if characters.get(index) == Some(&'/') {
                        regex.push_str("(.*/)?");
                        index += 1;
                    } else {
                        regex.push_str(".*");
                    }
                }
                '*' => {
                    regex.push_str("[^/]*");
                    index += 1;
                }
                '?' => {
                    regex.push_str("[^/]");
                    index += 1;
                }
                '[' => {
                    let start = index;
                    index += 1;
                    let mut class = String::new();
                    if characters.get(index) == Some(&'!') {
                        class.push('^');
                        index += 1;
                    }
                    while index < characters.len() && characters[index] != ']' {
                        if characters[index] == '\\' {
                            class.push('\\');
                        }
                        class.push(characters[index]);
                        index += 1;
                    }
                    if index == characters.len() {
                        return Err(SandboxError::new(format!(
                            "sandbox protected-path glob contains an unclosed character class: {glob}"
                        )));
                    }
                    regex.push('[');
                    regex.push_str(&class);
                    regex.push(']');
                    index += 1;
                    debug_assert!(index > start);
                }
                character => {
                    if matches!(
                        character,
                        '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '\\'
                    ) {
                        regex.push('\\');
                    }
                    regex.push(character);
                    index += 1;
                }
            }
        }
        Ok(regex)
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use glob::{MatchOptions, Pattern};
    use std::collections::BTreeSet;
    use walkdir::WalkDir;

    const STANDARD_BWRAP_PATHS: &[&str] = &[
        "/usr/bin/bwrap",
        "/bin/bwrap",
        "/usr/local/bin/bwrap",
        "/snap/bin/bwrap",
    ];

    pub struct LinuxBubblewrapBackend;

    impl SandboxBackend for LinuxBubblewrapBackend {
        fn report(&self) -> BackendReport {
            match find_bwrap(None) {
                Some(path) => BackendReport::enforced(
                    BackendKind::LinuxNative,
                    format!(
                        "Linux Bubblewrap is available through '{}'",
                        path.display()
                    ),
                ),
                None => BackendReport::unavailable(
                    BackendKind::LinuxNative,
                    "Bubblewrap (bwrap) is not installed; install the distribution's bubblewrap package before using workspace-write sandboxing",
                ),
            }
        }

        fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
            let Some(bwrap) = find_bwrap(Some(&request.cwd)) else {
                if request.policy.fail_closed {
                    return Err(SandboxError::new(
                        "Linux Bubblewrap is unavailable and fail_closed=true; install the distribution's bubblewrap package instead of running the command without operating-system isolation",
                    ));
                }
                return Ok(PreparedCommand {
                    program: platform_shell_program(),
                    arguments: platform_shell_arguments(&request.command),
                    startup_stdin: None,
                    report: self.report(),
                });
            };
            let arguments = build_bwrap_arguments(request)?;
            Ok(PreparedCommand {
                program: bwrap.into_os_string(),
                arguments,
                startup_stdin: None,
                report: BackendReport::enforced(
                    BackendKind::LinuxNative,
                    "Bubblewrap enforces mount, user, PID, IPC, capability, and optional network-namespace isolation",
                ),
            })
        }
    }

    fn find_bwrap(untrusted_root: Option<&Path>) -> Option<PathBuf> {
        let path_candidates = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();
        for candidate in STANDARD_BWRAP_PATHS.iter().map(PathBuf::from).chain(
            path_candidates
                .into_iter()
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join("bwrap")),
        ) {
            let Ok(candidate) = std::fs::canonicalize(candidate) else {
                continue;
            };
            if !candidate.is_file() {
                continue;
            }
            if untrusted_root.is_some_and(|root| {
                std::fs::canonicalize(root).is_ok_and(|root| candidate.starts_with(root))
            }) {
                continue;
            }
            if !bwrap_is_usable(&candidate) {
                continue;
            }
            return Some(candidate);
        }
        None
    }

    fn bwrap_is_usable(candidate: &Path) -> bool {
        std::process::Command::new(candidate)
            .args([
                "--ro-bind",
                "/",
                "/",
                "--dev",
                "/dev",
                "--unshare-user",
                "--unshare-pid",
                "--proc",
                "/proc",
                "--",
                "/bin/true",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn build_bwrap_arguments(request: &ShellRequest) -> Result<Vec<OsString>, SandboxError> {
        let cwd = std::fs::canonicalize(&request.cwd).map_err(|error| {
            SandboxError::new(format!(
                "failed to resolve Linux sandbox cwd '{}': {error}",
                request.cwd.display()
            ))
        })?;
        let mut read_roots = canonical_roots(&request.policy.read_roots, "read")?;
        let write_roots = canonical_roots(&request.policy.write_roots, "write")?;
        if write_roots.is_empty() {
            return Err(SandboxError::new(
                "Linux Bubblewrap policy requires at least one write root",
            ));
        }
        if !read_roots
            .iter()
            .chain(write_roots.iter())
            .any(|root| cwd.starts_with(root))
        {
            return Err(SandboxError::new(format!(
                "Linux sandbox cwd '{}' is outside every approved read/write root",
                cwd.display()
            )));
        }

        let denied_reads = resolve_denied_paths(
            &request.policy.denied_read_paths,
            &request.policy.denied_read_patterns,
            "read",
        )?;
        let denied_writes = resolve_denied_paths(
            &request.policy.denied_write_paths,
            &request.policy.denied_write_patterns,
            "write",
        )?;

        // Keep the same developer-tool compatibility carve-outs as the
        // macOS backend. The rest of HOME is hidden below.
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .and_then(|path| std::fs::canonicalize(path).ok());
        if let Some(home) = &home {
            for toolchain_root in [home.join(".cargo"), home.join(".rustup")] {
                if let Ok(toolchain_root) = std::fs::canonicalize(toolchain_root) {
                    push_unique(&mut read_roots, toolchain_root);
                }
            }
        }
        let temp_dir = std::fs::canonicalize(std::env::temp_dir()).ok();

        let mut arguments = vec![
            os("--new-session"),
            os("--die-with-parent"),
            os("--ro-bind"),
            os("/"),
            os("/"),
            os("--dev"),
            os("/dev"),
            os("--unshare-user"),
            os("--unshare-pid"),
            os("--unshare-ipc"),
        ];
        if request.policy.network == NetworkPolicy::Deny {
            arguments.push(os("--unshare-net"));
        }
        arguments.extend([os("--proc"), os("/proc"), os("--cap-drop"), os("ALL")]);

        // The host root stays read-only so system toolchains remain usable,
        // but user and temporary data-bearing roots are replaced with empty
        // private filesystems. Approved roots are rebound immediately below.
        for hidden_root in home.iter().chain(temp_dir.iter()) {
            arguments.push(os("--tmpfs"));
            arguments.push(hidden_root.as_os_str().to_owned());
        }

        // Read-only grants are mounted first; a later writable grant for the
        // same or a narrower path intentionally wins.
        for root in sort_paths_by_specificity(read_roots) {
            push_mount_target_dirs(&mut arguments, &root);
            push_mount(&mut arguments, "--ro-bind", &root, &root);
        }

        // The root filesystem starts read-only. Re-open only explicitly
        // writable roots, then layer protected paths over those mounts so a
        // broad workspace grant cannot override a narrower denial.
        for root in sort_paths_by_specificity(write_roots) {
            push_mount_target_dirs(&mut arguments, &root);
            push_mount(&mut arguments, "--bind", &root, &root);
        }

        let denied_read_set = denied_reads.iter().cloned().collect::<BTreeSet<_>>();
        for path in denied_writes {
            if denied_read_set.contains(&path) {
                continue;
            }
            push_mount(&mut arguments, "--ro-bind", &path, &path);
        }
        for path in denied_reads {
            mask_path(&mut arguments, &path)?;
        }

        arguments.extend([
            os("--chdir"),
            cwd.into_os_string(),
            os("--"),
            platform_shell_program(),
            os("-c"),
            OsString::from(&request.command),
        ]);
        Ok(arguments)
    }

    fn resolve_denied_paths(
        literal_paths: &[PathBuf],
        patterns: &[SandboxPathPattern],
        kind: &str,
    ) -> Result<Vec<PathBuf>, SandboxError> {
        let mut paths = denied_roots(literal_paths, kind)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        for rule in patterns {
            let root = std::fs::canonicalize(&rule.root).map_err(|error| {
                SandboxError::new(format!(
                    "failed to resolve sandbox denied {kind} pattern root '{}': {error}",
                    rule.root.display()
                ))
            })?;
            let pattern = Pattern::new(&rule.glob).map_err(|error| {
                SandboxError::new(format!(
                    "invalid sandbox denied {kind} glob '{}': {error}",
                    rule.glob
                ))
            })?;
            let options = MatchOptions {
                require_literal_separator: true,
                require_literal_leading_dot: false,
                case_sensitive: true,
            };
            for entry in WalkDir::new(&root).follow_links(false) {
                let entry = entry.map_err(|error| {
                    SandboxError::new(format!(
                        "failed to enumerate sandbox denied {kind} pattern below '{}': {error}",
                        root.display()
                    ))
                })?;
                let Ok(relative) = entry.path().strip_prefix(&root) else {
                    continue;
                };
                if relative.as_os_str().is_empty() || !pattern.matches_path_with(relative, options)
                {
                    continue;
                }
                let canonical = std::fs::canonicalize(entry.path()).map_err(|error| {
                    SandboxError::new(format!(
                        "failed to resolve sandbox denied {kind} match '{}': {error}",
                        entry.path().display()
                    ))
                })?;
                paths.insert(canonical);
            }
        }
        Ok(sort_paths_by_specificity(paths.into_iter().collect()))
    }

    fn sort_paths_by_specificity(mut paths: Vec<PathBuf>) -> Vec<PathBuf> {
        paths.sort_by(|left, right| {
            left.components()
                .count()
                .cmp(&right.components().count())
                .then_with(|| left.cmp(right))
        });
        paths.dedup();
        paths
    }

    fn mask_path(arguments: &mut Vec<OsString>, path: &Path) -> Result<(), SandboxError> {
        let metadata = std::fs::metadata(path).map_err(|error| {
            SandboxError::new(format!(
                "failed to inspect Linux sandbox protected path '{}': {error}",
                path.display()
            ))
        })?;
        if metadata.is_dir() {
            arguments.extend([os("--perms"), os("000"), os("--tmpfs")]);
            arguments.push(path.as_os_str().to_owned());
            arguments.push(os("--remount-ro"));
            arguments.push(path.as_os_str().to_owned());
        } else {
            // The original bytes become unreachable. `/dev/null` remains
            // readable as an empty file so programs probing optional config do
            // not receive a fabricated copy of the protected content.
            push_mount(arguments, "--ro-bind", Path::new("/dev/null"), path);
        }
        Ok(())
    }

    fn push_mount(arguments: &mut Vec<OsString>, operation: &str, source: &Path, target: &Path) {
        arguments.push(os(operation));
        arguments.push(source.as_os_str().to_owned());
        arguments.push(target.as_os_str().to_owned());
    }

    fn push_mount_target_dirs(arguments: &mut Vec<OsString>, target: &Path) {
        let mut parents = target.ancestors().skip(1).collect::<Vec<_>>();
        parents.reverse();
        for parent in parents {
            if parent == Path::new("/") {
                continue;
            }
            arguments.push(os("--dir"));
            arguments.push(parent.as_os_str().to_owned());
        }
    }

    fn os(value: &str) -> OsString {
        OsString::from(value)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::process::Command;

        fn argument_strings(arguments: Vec<OsString>) -> Vec<String> {
            arguments
                .into_iter()
                .map(|value| value.to_string_lossy().into_owned())
                .collect()
        }

        #[test]
        fn bubblewrap_policy_reopens_only_write_roots_then_masks_protected_paths() {
            let temp = tempfile::TempDir::new().unwrap();
            let workspace = temp.path().join("workspace");
            std::fs::create_dir_all(workspace.join(".git")).unwrap();
            std::fs::write(workspace.join(".env"), "SECRET=value\n").unwrap();
            let mut policy = SandboxPolicy::workspace(&workspace);
            policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.git"));
            policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.git/**"));
            policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env"));
            let arguments = argument_strings(
                build_bwrap_arguments(&ShellRequest {
                    command: "true".to_string(),
                    cwd: workspace.clone(),
                    policy,
                })
                .unwrap(),
            );

            assert!(arguments.windows(3).any(|items| {
                items
                    == [
                        "--bind",
                        workspace.to_string_lossy().as_ref(),
                        workspace.to_string_lossy().as_ref(),
                    ]
            }));
            let write_index = arguments
                .windows(3)
                .position(|items| items.first().is_some_and(|item| item == "--bind"))
                .unwrap();
            let mask_index = arguments
                .iter()
                .rposition(|item| item == "--tmpfs")
                .unwrap();
            assert!(write_index < mask_index);
            assert!(arguments.contains(&"--unshare-net".to_string()));
            assert!(arguments
                .windows(2)
                .any(|items| items == ["--cap-drop", "ALL"]));
            assert!(Pattern::new("**/.env")
                .unwrap()
                .matches_path(Path::new(".env")));
        }

        #[test]
        fn native_bubblewrap_blocks_outside_writes_and_protected_content() {
            let Some(bwrap) = find_bwrap(None) else {
                assert!(
                    std::env::var_os("MORPHZ_REQUIRE_LINUX_SANDBOX_ATTACK_TEST").is_none(),
                    "Bubblewrap is missing or unusable, but the native Linux sandbox attack test is required"
                );
                eprintln!("skipping native Bubblewrap attack test because bwrap is unavailable");
                return;
            };
            let temp = tempfile::TempDir::new().unwrap();
            let workspace = temp.path().join("workspace");
            let outside = temp.path().join("outside.txt");
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::write(workspace.join(".env"), "SECRET=value\n").unwrap();
            let mut policy = SandboxPolicy::workspace(&workspace);
            policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env"));
            let request = ShellRequest {
                command: format!(
                    "printf allowed > allowed.txt; if printf denied > '{}'; then exit 10; fi; test ! -s .env; python3 -c 'import socket; s=socket.socket(); s.settimeout(0.2); s.connect((\"1.1.1.1\", 53))' >/dev/null 2>&1 && exit 11 || true",
                    outside.display()
                ),
                cwd: workspace.clone(),
                policy,
            };
            let arguments = build_bwrap_arguments(&request).unwrap();
            let status = Command::new(bwrap)
                .args(arguments)
                .current_dir(&workspace)
                .status()
                .unwrap();

            assert!(status.success());
            assert_eq!(
                std::fs::read_to_string(workspace.join("allowed.txt")).unwrap(),
                "allowed"
            );
            assert!(!outside.exists());
            assert_eq!(
                std::fs::read_to_string(workspace.join(".env")).unwrap(),
                "SECRET=value\n"
            );
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use codex_protocol::config_types::WindowsSandboxLevel;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::permissions::NetworkSandboxPolicy;
    use codex_utils_absolute_path::AbsolutePathBuf;
    use glob::{MatchOptions, Pattern};
    use serde::{Deserialize, Serialize};
    use std::collections::{BTreeSet, HashMap};
    use walkdir::WalkDir;

    const RUNNER_EXE: &str = "morphz-windows-sandbox-runner.exe";
    const COMMAND_RUNNER_EXE: &str = "codex-command-runner.exe";
    const SETUP_EXE: &str = "codex-windows-sandbox-setup.exe";
    const CODEX_WINDOWS_REVISION: &str = "94cbbddafc1776d5e377bca1b05932c697e82238";

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct WindowsLaunchRequest {
        cwd: PathBuf,
        read_roots: Vec<PathBuf>,
        write_roots: Vec<PathBuf>,
        denied_read_paths: Vec<PathBuf>,
        denied_write_paths: Vec<PathBuf>,
        network: NetworkPolicy,
        command: String,
        morphz_home: PathBuf,
    }

    pub struct WindowsCodexBackend;

    impl SandboxBackend for WindowsCodexBackend {
        fn report(&self) -> BackendReport {
            match helper_bundle(None) {
                Ok(bundle) => BackendReport::enforced(
                    BackendKind::WindowsNative,
                    format!(
                        "Windows restricted-token, ACL, WFP, private-desktop, and Job Object helpers are available at '{}' (Codex revision {CODEX_WINDOWS_REVISION})",
                        bundle.runner.display()
                    ),
                ),
                Err(error) => BackendReport::unavailable(BackendKind::WindowsNative, error),
            }
        }

        fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
            let bundle = helper_bundle(Some(&request.cwd)).map_err(SandboxError::new)?;
            let cwd = std::fs::canonicalize(&request.cwd).map_err(|error| {
                SandboxError::new(format!(
                    "failed to resolve Windows sandbox cwd '{}': {error}",
                    request.cwd.display()
                ))
            })?;
            let read_roots = canonical_roots(&request.policy.read_roots, "read")?;
            let write_roots = canonical_roots(&request.policy.write_roots, "write")?;
            if write_roots.is_empty() {
                return Err(SandboxError::new(
                    "Windows workspace sandbox requires at least one write root",
                ));
            }
            if !read_roots
                .iter()
                .chain(write_roots.iter())
                .any(|root| cwd.starts_with(root))
            {
                return Err(SandboxError::new(format!(
                    "Windows sandbox cwd '{}' is outside every approved read/write root",
                    cwd.display()
                )));
            }

            let denied_read_paths = resolve_denied_paths(
                &request.policy.denied_read_paths,
                &request.policy.denied_read_patterns,
                "read",
            )?;
            let denied_write_paths = resolve_denied_paths(
                &request.policy.denied_write_paths,
                &request.policy.denied_write_patterns,
                "write",
            )?;
            let morphz_home = crate::config::morphz_home_dir().ok_or_else(|| {
                SandboxError::new(
                    "Windows sandbox cannot resolve MORPHZ_HOME; set MORPHZ_HOME or a normal Windows user profile before using workspace-write mode",
                )
            })?;
            let morphz_home = absolute_lexical_path(&morphz_home)?;
            let launch = WindowsLaunchRequest {
                cwd,
                read_roots,
                write_roots,
                denied_read_paths,
                denied_write_paths,
                network: request.policy.network,
                command: request.command.clone(),
                morphz_home,
            };
            let encoded = serde_json::to_string(&launch).map_err(|error| {
                SandboxError::new(format!(
                    "failed to encode Windows sandbox launch request: {error}"
                ))
            })?;
            Ok(PreparedCommand {
                program: bundle.runner.into_os_string(),
                arguments: Vec::new(),
                startup_stdin: Some(encoded.into_bytes()),
                report: BackendReport::enforced(
                    BackendKind::WindowsNative,
                    "Windows command is delegated to a restricted token with ACL/WFP policy and a Job Object process-tree boundary",
                ),
            })
        }
    }

    struct HelperBundle {
        runner: PathBuf,
    }

    fn helper_bundle(untrusted_root: Option<&Path>) -> Result<HelperBundle, String> {
        let current = std::env::current_exe()
            .map_err(|error| format!("failed to resolve the Morphz executable: {error}"))?;
        let directory = current.parent().ok_or_else(|| {
            format!(
                "Morphz executable '{}' has no parent directory",
                current.display()
            )
        })?;
        let runner = directory.join(RUNNER_EXE);
        let command_runner = directory.join(COMMAND_RUNNER_EXE);
        let setup = directory.join(SETUP_EXE);
        for helper in [&runner, &command_runner, &setup] {
            if !helper.is_file() {
                return Err(format!(
                    "Windows sandbox helper '{}' is missing; install the complete Morphz Windows bundle rather than copying only morphz.exe",
                    helper.display()
                ));
            }
            if untrusted_root.is_some_and(|root| {
                std::fs::canonicalize(root)
                    .ok()
                    .zip(std::fs::canonicalize(helper).ok())
                    .is_some_and(|(root, helper)| helper.starts_with(root))
            }) {
                return Err(format!(
                    "Windows sandbox helper '{}' is inside the untrusted command root",
                    helper.display()
                ));
            }
        }
        Ok(HelperBundle { runner })
    }

    fn resolve_denied_paths(
        literal_paths: &[PathBuf],
        patterns: &[SandboxPathPattern],
        kind: &str,
    ) -> Result<Vec<PathBuf>, SandboxError> {
        let mut paths = denied_roots(literal_paths, kind)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        for rule in patterns {
            let root = std::fs::canonicalize(&rule.root).map_err(|error| {
                SandboxError::new(format!(
                    "failed to resolve Windows denied {kind} pattern root '{}': {error}",
                    rule.root.display()
                ))
            })?;
            let pattern = Pattern::new(&rule.glob).map_err(|error| {
                SandboxError::new(format!(
                    "invalid Windows denied {kind} glob '{}': {error}",
                    rule.glob
                ))
            })?;
            let options = MatchOptions {
                require_literal_separator: true,
                require_literal_leading_dot: false,
                case_sensitive: false,
            };
            for entry in WalkDir::new(&root).follow_links(false) {
                let entry = entry.map_err(|error| {
                    SandboxError::new(format!(
                        "failed to enumerate Windows denied {kind} pattern below '{}': {error}",
                        root.display()
                    ))
                })?;
                let Ok(relative) = entry.path().strip_prefix(&root) else {
                    continue;
                };
                if relative.as_os_str().is_empty() || !pattern.matches_path_with(relative, options)
                {
                    continue;
                }
                paths.insert(absolute_lexical_path(entry.path())?);
            }
        }
        let mut paths = paths.into_iter().collect::<Vec<_>>();
        paths.sort_by(|left, right| {
            left.components()
                .count()
                .cmp(&right.components().count())
                .then_with(|| left.cmp(right))
        });
        Ok(paths)
    }

    fn absolute(path: &Path, label: &str) -> Result<AbsolutePathBuf, String> {
        AbsolutePathBuf::from_absolute_path(path).map_err(|error| {
            format!(
                "Windows sandbox {label} must be an absolute path ('{}'): {error:?}",
                path.display()
            )
        })
    }

    pub async fn run_helper_from_process_arguments() -> Result<i32, String> {
        use std::io::Read as _;

        let mut request = Vec::new();
        std::io::stdin()
            .take(16 * 1024 * 1024)
            .read_to_end(&mut request)
            .map_err(|error| format!("failed to read Windows sandbox launch request: {error}"))?;
        if request.is_empty() {
            return Err("missing Windows sandbox launch request on stdin".to_string());
        }
        let request: WindowsLaunchRequest = serde_json::from_slice(&request)
            .map_err(|error| format!("invalid Windows sandbox launch request: {error}"))?;
        let cwd = absolute(&request.cwd, "cwd")?;
        let workspace_roots = request
            .write_roots
            .iter()
            .map(|root| absolute(root, "workspace root"))
            .collect::<Result<Vec<_>, _>>()?;
        let denied_read_paths = request
            .denied_read_paths
            .iter()
            .map(|path| absolute(path, "denied read path"))
            .collect::<Result<Vec<_>, _>>()?;
        let denied_write_paths = request
            .denied_write_paths
            .iter()
            .map(|path| absolute(path, "denied write path"))
            .collect::<Result<Vec<_>, _>>()?;
        let network = match request.network {
            NetworkPolicy::Deny => NetworkSandboxPolicy::Restricted,
            NetworkPolicy::Allow => NetworkSandboxPolicy::Enabled,
        };
        let permission_profile = PermissionProfile::workspace_write_with(
            workspace_roots.as_slice(),
            network,
            /*exclude_tmpdir_env_var*/ true,
            /*exclude_slash_tmp*/ true,
        );
        let mut env_map = std::env::vars().collect::<HashMap<_, _>>();
        if request.network == NetworkPolicy::Deny {
            // Codex can deliberately permit a loopback proxy inside its
            // restricted network identity. Morphz's NetworkPolicy::Deny is
            // stricter: no proxy or local-binding escape is part of this
            // command's capability set.
            let denied_proxy_names = [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "WS_PROXY",
                "WSS_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
                "ws_proxy",
                "wss_proxy",
                "CODEX_WINDOWS_SANDBOX_PROXY_PORTS",
                "CODEX_NETWORK_ALLOW_LOCAL_BINDING",
            ];
            env_map.retain(|name, _| {
                !denied_proxy_names
                    .iter()
                    .any(|denied| name.eq_ignore_ascii_case(denied))
            });
        }
        let spawned = codex_windows_sandbox::spawn_windows_sandbox_session_for_level(
            codex_windows_sandbox::WindowsSandboxSessionRequest {
                permission_profile: &permission_profile,
                workspace_roots: workspace_roots.as_slice(),
                codex_home: &request.morphz_home,
                command: vec![
                    "cmd.exe".to_string(),
                    "/D".to_string(),
                    "/S".to_string(),
                    "/C".to_string(),
                    request.command,
                ],
                cwd: cwd.as_path(),
                env_map,
                windows_sandbox_level: WindowsSandboxLevel::Elevated,
                proxy_enforced: false,
                network_proxy_restricting_sid: None,
                proxy_settings_mode:
                    codex_windows_sandbox::WindowsSandboxProxySettingsMode::Reconcile,
                timeout_ms: None,
                read_roots_override: Some(request.read_roots.as_slice()),
                read_roots_include_platform_defaults: true,
                write_roots_override: Some(request.write_roots.as_slice()),
                deny_read_paths_override: denied_read_paths.as_slice(),
                deny_write_paths_override: denied_write_paths.as_slice(),
                tty: false,
                stdin_open: false,
                use_private_desktop: true,
            },
        )
        .await
        .map_err(|error| format!("Windows sandbox launch failed: {error:#}"))?;
        Ok(codex_windows_sandbox::forward_sandbox_session_stdio(spawned).await)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::Write as _;

        fn spawn_prepared(prepared: PreparedCommand, cwd: &Path) -> std::process::Child {
            let mut command = std::process::Command::new(prepared.program);
            command
                .args(prepared.arguments)
                .current_dir(cwd)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(prepared.startup_stdin.as_deref().unwrap())
                .unwrap();
            child
        }

        fn execute_prepared(prepared: PreparedCommand, cwd: &Path) -> std::process::Output {
            spawn_prepared(prepared, cwd).wait_with_output().unwrap()
        }

        #[test]
        fn denied_pattern_resolution_is_case_insensitive_on_windows() {
            let temp = tempfile::TempDir::new().unwrap();
            let workspace = temp.path().join("workspace");
            std::fs::create_dir_all(workspace.join("Nested")).unwrap();
            std::fs::write(workspace.join("Nested/.ENV"), "SECRET=value").unwrap();
            let resolved = resolve_denied_paths(
                &[],
                &[SandboxPathPattern::new(&workspace, "**/.env")],
                "read",
            )
            .unwrap();
            assert_eq!(resolved.len(), 1);
            assert!(resolved[0].ends_with(".ENV"));
        }

        #[test]
        fn native_windows_sandbox_blocks_outside_and_protected_access() {
            if std::env::var_os("MORPHZ_RUN_WINDOWS_SANDBOX_ATTACK_TEST").is_none() {
                eprintln!(
                    "skipping native Windows sandbox attack test; set MORPHZ_RUN_WINDOWS_SANDBOX_ATTACK_TEST=1 after installing the helper bundle"
                );
                return;
            }
            let temp = tempfile::TempDir::new().unwrap();
            let workspace = temp.path().join("workspace");
            let outside = temp.path().join("outside.txt");
            std::fs::create_dir_all(&workspace).unwrap();
            std::fs::write(workspace.join(".env"), "SECRET=value\r\n").unwrap();
            let mut policy = SandboxPolicy::workspace(&workspace);
            policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env"));
            let sandbox = NativeSandbox::with_backend(Arc::new(WindowsCodexBackend));

            let allowed = sandbox
                .prepare_shell(&ShellRequest {
                    command: "echo allowed>allowed.txt".to_string(),
                    cwd: workspace.clone(),
                    policy: policy.clone(),
                })
                .unwrap();
            let allowed = execute_prepared(allowed, &workspace);
            assert!(
                allowed.status.success(),
                "allowed command failed: {}",
                String::from_utf8_lossy(&allowed.stderr)
            );
            assert_eq!(
                std::fs::read_to_string(workspace.join("allowed.txt"))
                    .unwrap()
                    .trim(),
                "allowed"
            );

            let outside_write = sandbox
                .prepare_shell(&ShellRequest {
                    command: format!("echo denied>\"{}\"", outside.display()),
                    cwd: workspace.clone(),
                    policy: policy.clone(),
                })
                .unwrap();
            let outside_write = execute_prepared(outside_write, &workspace);
            assert!(!outside_write.status.success());
            assert!(!outside.exists());

            let protected_read = sandbox
                .prepare_shell(&ShellRequest {
                    command: "type .env".to_string(),
                    cwd: workspace.clone(),
                    policy: policy.clone(),
                })
                .unwrap();
            let protected_read = execute_prepared(protected_read, &workspace);
            assert!(!protected_read.status.success());
            assert!(!String::from_utf8_lossy(&protected_read.stdout).contains("SECRET=value"));

            let network = sandbox
                .prepare_shell(&ShellRequest {
                    command: "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"$client = New-Object Net.Sockets.TcpClient; $client.Connect('1.1.1.1', 53)\"".to_string(),
                    cwd: workspace.clone(),
                    policy,
                })
                .unwrap();
            let network = execute_prepared(network, &workspace);
            assert!(!network.status.success());

            let escaped = workspace.join("escaped.txt");
            let ready = workspace.join("runner-ready.txt");
            let managed_tree = sandbox
                .prepare_shell(&ShellRequest {
                    command: "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Set-Content -Path runner-ready.txt -Value ready; Start-Sleep -Seconds 4; Set-Content -Path escaped.txt -Value escaped\"".to_string(),
                    cwd: workspace.clone(),
                    policy: SandboxPolicy::workspace(&workspace),
                })
                .unwrap();
            let mut managed_tree = spawn_prepared(managed_tree, &workspace);
            let process_id = i32::try_from(managed_tree.id()).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while !ready.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            assert!(
                ready.exists(),
                "sandboxed process did not reach its ready point"
            );
            assert!(crate::tool::terminate_process_tree(process_id).unwrap());
            let _ = managed_tree.wait();
            std::thread::sleep(std::time::Duration::from_secs(5));
            assert!(
                !escaped.exists(),
                "terminating the Windows sandbox runner must close the transport and terminate its Job Object descendants"
            );
        }
    }
}

#[cfg(windows)]
pub async fn run_windows_sandbox_helper() -> Result<i32, String> {
    windows::run_helper_from_process_arguments().await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct RecordingBackend;

    impl SandboxBackend for RecordingBackend {
        fn report(&self) -> BackendReport {
            BackendReport::enforced(BackendKind::Unsupported, "recording test backend")
        }

        fn prepare_shell(&self, request: &ShellRequest) -> Result<PreparedCommand, SandboxError> {
            Ok(PreparedCommand {
                program: OsString::from("recording-shell"),
                arguments: vec![OsString::from(&request.command)],
                startup_stdin: None,
                report: self.report(),
            })
        }
    }

    #[test]
    fn unified_backend_can_be_replaced_without_changing_request() {
        let sandbox = NativeSandbox::with_backend(Arc::new(RecordingBackend));
        let request = ShellRequest {
            command: "echo hello".to_string(),
            cwd: PathBuf::from("."),
            policy: SandboxPolicy::workspace("."),
        };

        let prepared = sandbox.prepare_shell(&request).unwrap();
        assert_eq!(prepared.program, OsString::from("recording-shell"));
        assert_eq!(prepared.arguments, vec![OsString::from("echo hello")]);
    }

    #[test]
    fn unsupported_backend_fails_closed() {
        let backend =
            UnsupportedNativeBackend::new(BackendKind::Unsupported, "test backend unavailable");
        let request = ShellRequest {
            command: "echo hello".to_string(),
            cwd: PathBuf::from("."),
            policy: SandboxPolicy::workspace("."),
        };

        let error = backend.prepare_shell(&request).unwrap_err();
        assert!(error.to_string().contains("refuses fallback"));
    }

    #[test]
    fn write_roots_are_also_readable() {
        let mut policy = SandboxPolicy::workspace("workspace");
        policy.add_write_root("generated");
        assert!(policy.read_roots.contains(&PathBuf::from("generated")));
        assert!(policy.write_roots.contains(&PathBuf::from("generated")));
    }

    #[test]
    fn denied_patterns_are_kept_as_symbolic_policy() {
        let mut policy = SandboxPolicy::workspace("workspace");
        let pattern = SandboxPathPattern::new("workspace", "**/.git/**");
        policy.deny_pattern(pattern.clone());
        policy.deny_pattern(pattern.clone());

        assert_eq!(policy.denied_read_patterns, vec![pattern.clone()]);
        assert_eq!(policy.denied_write_patterns, vec![pattern]);
    }

    #[test]
    fn missing_allow_root_still_fails_closed() {
        let temp = tempfile::TempDir::new().unwrap();
        let missing = temp.path().join("missing-workspace");
        let error = canonical_roots(&[missing], "read").unwrap_err();
        assert!(error
            .to_string()
            .contains("failed to resolve sandbox read root"));
    }

    #[test]
    fn missing_deny_root_keeps_stable_absolute_path() {
        let temp = tempfile::TempDir::new().unwrap();
        let protected = temp.path().join("ephemeral").join("checkpoint");
        let resolved = denied_roots(std::slice::from_ref(&protected), "denied read").unwrap();
        assert_eq!(resolved, vec![protected]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_denies_network_and_limits_writes() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let policy = SandboxPolicy::workspace(&workspace);
        let profile = macos::build_profile(&policy).unwrap();

        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains(&workspace.to_string_lossy().to_string()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_can_grant_one_read_only_file_without_its_siblings() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let external = temp.path().join("external");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let allowed_file = external.join("known_hosts");
        let denied_file = external.join("private-key");
        std::fs::write(&allowed_file, "known host\n").unwrap();
        std::fs::write(&denied_file, "private\n").unwrap();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.add_read_root(&allowed_file);
        let sandbox = NativeSandbox::for_current_platform();

        let allowed = sandbox
            .prepare_shell(&ShellRequest {
                command: format!("cat '{}' >/dev/null", allowed_file.display()),
                cwd: workspace.clone(),
                policy: policy.clone(),
            })
            .unwrap();
        assert!(std::process::Command::new(&allowed.program)
            .args(&allowed.arguments)
            .status()
            .unwrap()
            .success());

        let denied = sandbox
            .prepare_shell(&ShellRequest {
                command: format!("cat '{}' >/dev/null", denied_file.display()),
                cwd: workspace,
                policy,
            })
            .unwrap();
        assert!(!std::process::Command::new(&denied.program)
            .args(&denied.arguments)
            .status()
            .unwrap()
            .success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_compiles_symbolic_protected_globs() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace.with+regex[chars]");
        std::fs::create_dir_all(&workspace).unwrap();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.git/**"));
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env.*"));

        let profile = macos::build_profile(&policy).unwrap();

        assert!(profile.contains("(deny file-read* (regex #\""));
        assert!(profile.contains("[^/]*"));
        assert!(profile.contains("\\.git"));
        assert!(profile.contains("\\.env"));
        assert!(profile.contains("workspace\\.with\\+regex\\[chars\\]"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_profile_preserves_deny_rule_after_protected_path_disappears() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let protected = workspace.join(".git").join("refs").join("checkpoint");
        std::fs::create_dir_all(&protected).unwrap();
        let canonical_protected = std::fs::canonicalize(&protected).unwrap();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_path(&canonical_protected);
        std::fs::remove_dir_all(&protected).unwrap();

        let profile = macos::build_profile(&policy).unwrap();
        let protected_text = canonical_protected.to_string_lossy();
        assert!(profile.contains(&format!("(deny file-read* (subpath \"{protected_text}\"))")));
        assert!(profile.contains(&format!(
            "(deny file-write* (subpath \"{protected_text}\"))"
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_allows_workspace_write_and_denies_escape() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().join("escape.txt");
        let sandbox = NativeSandbox::for_current_platform();

        let allowed = sandbox
            .prepare_shell(&ShellRequest {
                command: "printf allowed > inside.txt".to_string(),
                cwd: workspace.clone(),
                policy: SandboxPolicy::workspace(&workspace),
            })
            .unwrap();
        let allowed_status = std::process::Command::new(&allowed.program)
            .args(&allowed.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();
        assert!(allowed_status.success());
        assert_eq!(
            std::fs::read_to_string(workspace.join("inside.txt")).unwrap(),
            "allowed"
        );

        let denied = sandbox
            .prepare_shell(&ShellRequest {
                command: format!(
                    "printf escaped > {}",
                    shell_quote(&outside.to_string_lossy())
                ),
                cwd: workspace.clone(),
                policy: SandboxPolicy::workspace(&workspace),
            })
            .unwrap();
        let denied_status = std::process::Command::new(&denied.program)
            .args(&denied.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();
        assert!(!denied_status.success());
        assert!(!outside.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_denies_workspace_symlink_escape() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, workspace.join("alias")).unwrap();
        let escaped = outside.join("escape.txt");
        let sandbox = NativeSandbox::for_current_platform();
        let prepared = sandbox
            .prepare_shell(&ShellRequest {
                command: "printf escaped > alias/escape.txt".to_string(),
                cwd: workspace.clone(),
                policy: SandboxPolicy::workspace(&workspace),
            })
            .unwrap();
        let status = std::process::Command::new(&prepared.program)
            .args(&prepared.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();

        assert!(!status.success());
        assert!(!escaped.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_denies_symbolic_protected_path_inside_writable_root() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let protected = workspace.join(".git");
        std::fs::create_dir_all(&protected).unwrap();
        std::fs::write(protected.join("config"), "secret").unwrap();
        std::fs::write(workspace.join("public.txt"), "public").unwrap();
        let sandbox = NativeSandbox::for_current_platform();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.git"));
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.git/**"));
        let profile = macos::build_profile(&policy).unwrap();

        let public_read = sandbox
            .prepare_shell(&ShellRequest {
                command: "cat public.txt >/dev/null".to_string(),
                cwd: workspace.clone(),
                policy: policy.clone(),
            })
            .unwrap();
        let public_status = std::process::Command::new(&public_read.program)
            .args(&public_read.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();
        assert!(public_status.success(), "generated profile:\n{profile}");

        let protected_read = sandbox
            .prepare_shell(&ShellRequest {
                command: "cat .git/config >/dev/null".to_string(),
                cwd: workspace.clone(),
                policy: policy.clone(),
            })
            .unwrap();
        let protected_read_status = std::process::Command::new(&protected_read.program)
            .args(&protected_read.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();
        assert!(
            !protected_read_status.success(),
            "protected reads must remain denied after workspace allows:\n{profile}"
        );

        let protected_write = sandbox
            .prepare_shell(&ShellRequest {
                command: "printf changed > .git/config".to_string(),
                cwd: workspace.clone(),
                policy,
            })
            .unwrap();
        let protected_write_status = std::process::Command::new(&protected_write.program)
            .args(&protected_write.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();
        assert!(!protected_write_status.success());
        assert_eq!(
            std::fs::read_to_string(protected.join("config")).unwrap(),
            "secret"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_denies_exact_protected_read_inside_allowed_root() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let protected = workspace.join("credentials.json");
        std::fs::write(&protected, "secret").unwrap();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_path(std::fs::canonicalize(&protected).unwrap());
        let sandbox = NativeSandbox::for_current_platform();
        let prepared = sandbox
            .prepare_shell(&ShellRequest {
                command: "cat credentials.json >/dev/null".to_string(),
                cwd: workspace.clone(),
                policy,
            })
            .unwrap();
        let status = std::process::Command::new(&prepared.program)
            .args(&prepared.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();

        assert!(!status.success());
        assert_eq!(std::fs::read_to_string(protected).unwrap(), "secret");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_denies_future_protected_match_without_discovery() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let nested = workspace.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let future_secret = nested.join(".env.local");
        let sandbox = NativeSandbox::for_current_platform();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env.*"));

        let prepared = sandbox
            .prepare_shell(&ShellRequest {
                command: "printf secret > nested/.env.local".to_string(),
                cwd: workspace.clone(),
                policy,
            })
            .unwrap();
        let status = std::process::Command::new(&prepared.program)
            .args(&prepared.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();

        assert!(!status.success());
        assert!(!future_secret.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_backend_confines_descendant_shells() {
        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let outside = temp.path().join("descendant-escape.txt");
        let sandbox = NativeSandbox::for_current_platform();
        let nested = format!(
            "/bin/sh -c {}",
            shell_quote(&format!(
                "printf escaped > {}",
                shell_quote(&outside.to_string_lossy())
            ))
        );
        let prepared = sandbox
            .prepare_shell(&ShellRequest {
                command: nested,
                cwd: workspace.clone(),
                policy: SandboxPolicy::workspace(&workspace),
            })
            .unwrap();
        let status = std::process::Command::new(&prepared.program)
            .args(&prepared.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();

        assert!(!status.success());
        assert!(!outside.exists());
    }

    #[cfg(target_os = "macos")]
    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}
