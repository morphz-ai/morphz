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
    Arc::new(UnsupportedNativeBackend::new(
        BackendKind::LinuxNative,
        "the native Linux sandbox Backend is not implemented and validated on a real host",
    ))
}

#[cfg(windows)]
fn platform_backend() -> Arc<dyn SandboxBackend> {
    Arc::new(UnsupportedNativeBackend::new(
        BackendKind::WindowsNative,
        "the native Windows sandbox Backend is not implemented and validated on a real host",
    ))
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
