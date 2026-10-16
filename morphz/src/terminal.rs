//! A Runtime-owned terminal resource. Agent input crosses the ordinary durable
//! Tool/ExecutionJob boundary; UI reads do not create work or grant execution.
use crate::llm::ToolDefinition;
use crate::memory::terminal::{TerminalSessionFilter, TerminalSessionRecord, TerminalStatus};
use crate::memory::{ExecutionJobStatus, RuntimeStore};
use crate::permission::{PermissionBroker, PermissionProfile, SandboxMode, ShellEnvironmentPolicy};
use crate::sandbox::{NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest};
use crate::tool::{Tool, ToolExecutionJobContext, CURRENT_EXECUTION_JOB};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};

type Error = Box<dyn std::error::Error + Send + Sync>;
pub(crate) type TerminalSourceResolver = Arc<
    dyn Fn(
            ToolExecutionJobContext,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, Error>> + Send>>
        + Send
        + Sync,
>;
const MAX_LIVE: usize = 8;
const SCROLLBACK: usize = 500;

#[derive(Debug)]
pub enum TerminalAccessError {
    NotFound,
    Forbidden,
}
impl std::fmt::Display for TerminalAccessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotFound => "terminal is not available in this authorized Session",
            Self::Forbidden => "terminal Session membership is not current",
        })
    }
}
impl std::error::Error for TerminalAccessError {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TerminalSpan {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg_index: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg_index: Option<u8>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalScreen {
    pub sequence: u64,
    pub rows: u16,
    pub cols: u16,
    pub lines: Vec<Vec<TerminalSpan>>,
    pub text: String,
    pub cursor: (u16, u16),
    pub cursor_visible: bool,
    pub alternate_screen: bool,
    pub scrollback: usize,
    pub previous_available: bool,
    #[serde(default)]
    pub styles_simplified: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalView {
    pub terminal: TerminalSessionRecord,
    pub connected: bool,
    pub screen: Option<TerminalScreen>,
    /// A checkpoint is evidence of past output, never a live process handle.
    pub checkpoint: bool,
}

struct ScreenState {
    parser: vt100::Parser,
    sequence: u64,
    eof: bool,
    error: Option<String>,
}

struct LiveTerminal {
    control: tokio::sync::Mutex<()>,
    screen: Arc<Mutex<ScreenState>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    process_id: i32,
    stopped: Arc<AtomicBool>,
}

struct StartingChild(Option<Box<dyn Child + Send + Sync>>);
impl Drop for StartingChild {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl LiveTerminal {
    fn stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            #[cfg(unix)]
            if let Ok(master) = self.master.lock() {
                // Interactive job control gives each foreground/background
                // job its own process group. Query only our still-owned PTY,
                // never kill by a command name or scan unrelated descendants.
                if let Some(tty) = master.tty_name() {
                    if let Ok(output) = std::process::Command::new("/bin/ps")
                        .arg("-t")
                        .arg(tty)
                        .args(["-o", "pgid="])
                        .output()
                    {
                        if output.status.success() {
                            let groups = String::from_utf8_lossy(&output.stdout)
                                .split_whitespace()
                                .filter_map(|value| value.parse::<i32>().ok())
                                .filter(|id| *id > 0 && *id != std::process::id() as i32)
                                .collect::<std::collections::BTreeSet<_>>();
                            for group in groups {
                                let _ = crate::tool::terminate_process_tree(group);
                            }
                        }
                    }
                }
                if let Some(group) = master
                    .process_group_leader()
                    .filter(|group| *group > 0 && *group != self.process_id)
                {
                    let _ = crate::tool::terminate_process_tree(group);
                }
            }
            // portable-pty makes the child its own session leader on Unix.
            // Terminate the whole managed group, not just its shell leader.
            let _ = crate::tool::terminate_process_tree(self.process_id);
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for LiveTerminal {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct TerminalManager {
    store: Arc<dyn RuntimeStore>,
    permissions: Arc<PermissionBroker>,
    instance_id: String,
    live: Mutex<HashMap<String, Arc<LiveTerminal>>>,
    opens: tokio::sync::Mutex<()>,
    source: OnceLock<TerminalSourceResolver>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn size(rows: u16, cols: u16) -> Result<PtySize, Error> {
    if !(4..=60).contains(&rows) || !(20..=160).contains(&cols) {
        return Err("terminal size must be 4..60 rows and 20..160 columns".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn policy_hash(profile: &PermissionProfile) -> String {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "sandbox": profile.sandbox_mode,
        "cwd": profile.workspace_root,
        "reads": profile.read_roots,
        "writes": profile.write_roots,
        "protected": profile.protected_paths,
        "network": profile.network,
        "environment": profile.shell_environment_policy,
    }))
    .expect("serializable permission profile");
    format!("{:x}", Sha256::digest(bytes))
}

fn color(value: vt100::Color) -> Option<String> {
    match value {
        vt100::Color::Default => None,
        vt100::Color::Idx(index) => {
            const ANSI: [&str; 16] = [
                "#272b33", "#c94343", "#298451", "#98721c", "#3973c6", "#9560bd", "#228b98",
                "#c5c8cf", "#687080", "#ec7777", "#75cf99", "#e9c56b", "#81b0ee", "#c39ce4",
                "#7bd2da", "#f0f2f5",
            ];
            if index < 16 {
                return Some(ANSI[index as usize].into());
            }
            let (r, g, b) = if index >= 232 {
                let gray = 8 + (index - 232) * 10;
                (gray, gray, gray)
            } else {
                let i = index - 16;
                let level = |v| if v == 0 { 0 } else { 55 + 40 * v };
                (level(i / 36), level((i / 6) % 6), level(i % 6))
            };
            Some(format!("#{r:02x}{g:02x}{b:02x}"))
        }
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

fn color_index(value: vt100::Color) -> Option<u8> {
    match value {
        vt100::Color::Idx(index) => Some(index),
        _ => None,
    }
}

fn screen_snapshot(state: &mut ScreenState, scrollback: usize) -> TerminalScreen {
    state.parser.screen_mut().set_scrollback(SCROLLBACK);
    let available = state.parser.screen().scrollback();
    state
        .parser
        .screen_mut()
        .set_scrollback(scrollback.min(SCROLLBACK));
    let screen = state.parser.screen();
    let (rows, cols) = screen.size();
    let mut lines = Vec::with_capacity(rows as usize);
    for row in 0..rows {
        let mut spans: Vec<TerminalSpan> = Vec::new();
        for col in 0..cols {
            let Some(cell) = screen.cell(row, col) else {
                continue;
            };
            if cell.is_wide_continuation() {
                continue;
            }
            let text = if cell.has_contents() {
                cell.contents().chars().take(32).collect()
            } else {
                " ".into()
            };
            let span = TerminalSpan {
                text,
                fg: color(cell.fgcolor()),
                bg: color(cell.bgcolor()),
                fg_index: color_index(cell.fgcolor()),
                bg_index: color_index(cell.bgcolor()),
                bold: cell.bold(),
                italic: cell.italic(),
                underline: cell.underline(),
                inverse: cell.inverse(),
            };
            if let Some(last) = spans.last_mut().filter(|last| {
                last.fg == span.fg
                    && last.bg == span.bg
                    && last.fg_index == span.fg_index
                    && last.bg_index == span.bg_index
                    && last.bold == span.bold
                    && last.italic == span.italic
                    && last.underline == span.underline
                    && last.inverse == span.inverse
            }) {
                last.text.push_str(&span.text);
            } else {
                spans.push(span);
            }
        }
        lines.push(spans);
    }
    let mut snapshot = TerminalScreen {
        sequence: state.sequence,
        rows,
        cols,
        lines,
        text: screen.contents(),
        cursor: screen.cursor_position(),
        cursor_visible: !screen.hide_cursor() && scrollback == 0,
        alternate_screen: screen.alternate_screen(),
        scrollback: screen.scrollback(),
        previous_available: screen.scrollback() < available && !screen.alternate_screen(),
        styles_simplified: false,
    };
    // An adversarial ANSI program can change attributes at every cell. Keep
    // all visible text but simplify colors before the transport/checkpoint
    // exceeds its cap; never allocate an unbounded transcript or DOM tree.
    if serde_json::to_vec(&snapshot).map_or(true, |bytes| bytes.len() > 450000) {
        snapshot.lines = snapshot
            .lines
            .into_iter()
            .map(|spans| {
                vec![TerminalSpan {
                    text: spans.into_iter().map(|span| span.text).collect(),
                    ..Default::default()
                }]
            })
            .collect();
        snapshot.styles_simplified = true;
    }
    state.parser.screen_mut().set_scrollback(0);
    snapshot
}

impl TerminalManager {
    pub fn new(store: Arc<dyn RuntimeStore>, permissions: Arc<PermissionBroker>) -> Arc<Self> {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).expect("Runtime terminal owner requires OS randomness");
        let instance_id = format!("pty-{}-{:x}", std::process::id(), Sha256::digest(nonce));
        Arc::new(Self {
            store,
            permissions,
            instance_id,
            live: Mutex::new(HashMap::new()),
            opens: tokio::sync::Mutex::new(()),
            source: OnceLock::new(),
        })
    }

    pub(crate) fn bind_source(&self, resolver: TerminalSourceResolver) {
        assert!(
            self.source.set(resolver).is_ok(),
            "Terminal provenance resolver can only be bound once"
        );
    }

    async fn authorize(&self, session: &str, context: &str, principal: &str) -> Result<(), Error> {
        let record = self
            .store
            .get_session(session)
            .await?
            .ok_or("terminal Session does not exist")?;
        if record.context_id != context
            || !self
                .store
                .list_session_principals(session)
                .await?
                .iter()
                .any(|p| p.principal_id == principal && p.unbound_at.is_none())
        {
            return Err(TerminalAccessError::Forbidden.into());
        }
        Ok(())
    }

    async fn caller(&self) -> Result<ToolExecutionJobContext, Error> {
        let caller = CURRENT_EXECUTION_JOB
            .try_with(Clone::clone)
            .ok()
            .flatten()
            .ok_or("terminal operations require a Runtime-owned ExecutionJob")?;
        let principal = caller
            .initiating_principal_id
            .as_deref()
            .ok_or("terminal requires an authenticated initiating Principal")?;
        if caller.target_id != crate::execution_target::DEFAULT_EXECUTION_TARGET_ID {
            return Err("terminal PTY transport is not implemented for this Execution Target; no local fallback is permitted".into());
        }
        self.authorize(&caller.session_id, &caller.context_id, principal)
            .await?;
        let job = self
            .store
            .get_execution_job(&caller.parent_job_id)
            .await?
            .ok_or("terminal ExecutionJob does not exist")?;
        if job.status != ExecutionJobStatus::Running
            || job.cancel_requested_at.is_some()
            || job.session_id != caller.session_id
            || job.context_id != caller.context_id
            || job.initiating_principal_id != caller.initiating_principal_id
            || job.target_id != caller.target_id
            || job.thread_id != caller.thread_id
            || job.activation_id != caller.activation_id
            || job.agent_id != caller.agent_id
            || job.tool_call_id != caller.tool_call_id
            || job.tool_name != "terminal"
        {
            return Err("terminal ExecutionJob ownership is not current".into());
        }
        Ok(caller)
    }

    pub async fn list(
        &self,
        filter: &TerminalSessionFilter,
    ) -> Result<Vec<TerminalSessionRecord>, Error> {
        self.authorize(&filter.session_id, &filter.context_id, &filter.principal_id)
            .await?;
        let records = self.store.terminals(filter).await?;
        self.authorize(&filter.session_id, &filter.context_id, &filter.principal_id)
            .await?;
        Ok(records
            .into_iter()
            .map(|mut record| {
                if matches!(
                    record.status,
                    TerminalStatus::Open | TerminalStatus::Starting
                ) && record.owner_instance_id != self.instance_id
                    && record.lease_expires_at < now()
                {
                    record.status = TerminalStatus::Lost;
                }
                record
            })
            .collect())
    }

    pub async fn view(
        &self,
        id: &str,
        session: &str,
        context: &str,
        principal: &str,
        scrollback: usize,
    ) -> Result<TerminalView, Error> {
        self.authorize(session, context, principal).await?;
        let mut record = self
            .store
            .terminal(id)
            .await?
            .ok_or(TerminalAccessError::NotFound)?;
        if record.session_id != session
            || record.context_id != context
            || record.principal_id != principal
        {
            return Err(TerminalAccessError::NotFound.into());
        }
        let live = self
            .live
            .lock()
            .map_err(|_| "terminal registry poisoned")?
            .get(id)
            .cloned();
        let connected = live
            .as_ref()
            .is_some_and(|l| !l.stopped.load(Ordering::SeqCst))
            && record.status == TerminalStatus::Open;
        let screen = if let Some(live) = live {
            Some(screen_snapshot(
                &mut *live.screen.lock().map_err(|_| "terminal screen poisoned")?,
                scrollback,
            ))
        } else {
            if matches!(
                record.status,
                TerminalStatus::Starting | TerminalStatus::Open
            ) && record.lease_expires_at < now()
            {
                record.status = TerminalStatus::Lost;
            }
            self.store
                .terminal_checkpoint(id)
                .await?
                .map(|s| serde_json::from_str(&s))
                .transpose()?
        };
        self.authorize(session, context, principal).await?;
        Ok(TerminalView {
            terminal: record,
            connected,
            screen,
            checkpoint: !connected,
        })
    }

    pub async fn metadata(
        &self,
        id: &str,
        session: &str,
        context: &str,
        principal: &str,
    ) -> Result<TerminalSessionRecord, Error> {
        self.authorize(session, context, principal).await?;
        let record = self
            .store
            .terminal(id)
            .await?
            .ok_or(TerminalAccessError::NotFound)?;
        if record.session_id != session
            || record.context_id != context
            || record.principal_id != principal
        {
            return Err(TerminalAccessError::NotFound.into());
        }
        self.authorize(session, context, principal).await?;
        Ok(record)
    }

    async fn wait_output(
        &self,
        id: &str,
        caller: &ToolExecutionJobContext,
        after: Option<u64>,
        wait_ms: u64,
    ) -> Result<(), Error> {
        if wait_ms == 0 {
            return Ok(());
        }
        if wait_ms > 5000 || after.is_none() {
            return Err(
                "terminal.read waiting requires after_sequence and wait_ms in 1..5000".into(),
            );
        }
        self.metadata(
            id,
            &caller.session_id,
            &caller.context_id,
            caller
                .initiating_principal_id
                .as_deref()
                .ok_or("missing Principal")?,
        )
        .await?;
        let live = self
            .live
            .lock()
            .map_err(|_| "terminal registry poisoned")?
            .get(id)
            .cloned();
        let Some(live) = live else {
            return Ok(());
        };
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        loop {
            let ready = {
                let screen = live.screen.lock().map_err(|_| "terminal screen poisoned")?;
                screen.sequence > after.unwrap() || screen.eof
            };
            if ready
                || live.stopped.load(Ordering::SeqCst)
                || tokio::time::Instant::now() >= deadline
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    async fn open(
        self: &Arc<Self>,
        caller: &ToolExecutionJobContext,
        title: String,
        cwd: String,
        rows: u16,
        cols: u16,
    ) -> Result<TerminalView, Error> {
        let _guard = self.opens.lock().await;
        let pty_size = size(rows, cols)?;
        #[cfg(not(unix))]
        return Err("sandboxed interactive PTY startup is not implemented on this platform".into());
        #[cfg(unix)]
        {
            if title.trim().is_empty() || title.chars().count() > 80 {
                return Err("terminal title must contain 1..80 characters".into());
            }
            if self
                .live
                .lock()
                .map_err(|_| "terminal registry poisoned")?
                .len()
                >= MAX_LIVE
            {
                return Err(
                    "Runtime has 8 open terminals; explicitly close an unused terminal first"
                        .into(),
                );
            }
            let profile = self.permissions.profile_for_session(&caller.session_id);
            let resolved = profile.resolve_candidate(&cwd)?;
            if resolved.protected || !resolved.candidate.is_dir() {
                return Err("terminal cwd is not an allowed existing directory".into());
            }
            let cwd = std::fs::canonicalize(&resolved.candidate)?;
            if !profile
                .read_roots
                .iter()
                .chain(&profile.write_roots)
                .any(|root| cwd.starts_with(root))
            {
                return Err("terminal cwd is outside the current permission roots; use existing permission controls first".into());
            }
            let shell = if cfg!(target_os = "macos") {
                "/bin/zsh"
            } else if std::path::Path::new("/bin/bash").is_file() {
                "/bin/bash"
            } else {
                "/bin/sh"
            };
            // No startup files or login-shell credential hooks are loaded. This is
            // still the system shell, attached to the same persistent PTY.
            let shell_command = match shell {
                "/bin/zsh" => "exec /bin/zsh -f -i",
                "/bin/bash" => "PS1='\\[\\033[34m\\]\\w\\[\\033[0m\\] \\[\\033[32m\\]\\$\\[\\033[0m\\] ' exec /bin/bash --noprofile --norc -i",
                _ => "PS1='$ ' exec /bin/sh -i",
            };
            let sandbox = NativeSandbox::for_current_platform();
            let prepared = if profile.sandbox_mode == SandboxMode::WorkspaceWrite {
                let mut policy = SandboxPolicy {
                    read_roots: profile.read_roots.clone(),
                    write_roots: profile.write_roots.clone(),
                    denied_read_paths: vec![],
                    denied_write_paths: vec![],
                    denied_read_patterns: vec![],
                    denied_write_patterns: vec![],
                    network: if profile.network {
                        NetworkPolicy::Allow
                    } else {
                        NetworkPolicy::Deny
                    },
                    fail_closed: true,
                };
                for path in profile.sandbox_protected_paths(&policy.read_roots) {
                    policy.deny_path(path);
                }
                for pattern in profile.sandbox_protected_patterns(&policy.read_roots) {
                    policy.deny_pattern(pattern);
                }
                sandbox.prepare_shell(&ShellRequest {
                    command: shell_command.into(),
                    cwd: cwd.clone(),
                    policy,
                })?
            } else {
                sandbox.prepare_unconfined_shell(shell_command)
            };
            if prepared.startup_stdin.is_some() {
                return Err("this native sandbox requires a separate trusted startup pipe; PTY startup is not supported, refusing fallback".into());
            }
            let principal = caller
                .initiating_principal_id
                .clone()
                .ok_or("missing Principal")?;
            // Objective/child Threads can have synthetic execution roots. Reuse
            // Runtime's owner-resolved original input, not a UI-selected project
            // or a guess from that synthetic root.
            let root = self
                .source
                .get()
                .ok_or("terminal input provenance resolver is unavailable")?(
                caller.clone()
            )
            .await?;
            let id = format!("terminal-{}", caller.parent_job_id);
            let created_at = now();
            let mut record = TerminalSessionRecord {
                id: id.clone(),
                session_id: caller.session_id.clone(),
                context_id: caller.context_id.clone(),
                principal_id: principal.clone(),
                root_turn_id: root,
                source_job_id: caller.parent_job_id.clone(),
                target_id: caller.target_id.clone(),
                owner_instance_id: self.instance_id.clone(),
                lease_expires_at: (chrono::Utc::now() + chrono::Duration::seconds(20)).to_rfc3339(),
                revision: 1,
                status: TerminalStatus::Starting,
                title,
                shell: shell.into(),
                cwd: cwd.to_string_lossy().into_owned(),
                rows,
                cols,
                policy_hash: policy_hash(&profile),
                sandbox_status: if profile.sandbox_mode == SandboxMode::DangerFullAccess {
                    "disabled"
                } else {
                    "enforced"
                }
                .into(),
                network_enabled: profile.network,
                last_input_job_id: None,
                last_input_status: None,
                exit_code: None,
                created_at: created_at.clone(),
                updated_at: created_at,
            };
            if !self.store.create_terminal(&record).await? {
                return self
                    .view(&id, &caller.session_id, &caller.context_id, &principal, 0)
                    .await;
            }
            self.caller().await?;
            if policy_hash(&self.permissions.profile_for_session(&caller.session_id))
                != record.policy_hash
            {
                record.status = TerminalStatus::Closed;
                self.store
                    .compare_terminal(record.revision, &record)
                    .await?;
                return Err(
                    "terminal permissions changed before process creation; no process was started"
                        .into(),
                );
            }
            crate::tool::mark_physical_side_effect().await?;
            let profile_environment = profile.shell_environment_policy;
            let spawned =
                tokio::task::spawn_blocking(move || -> Result<Arc<LiveTerminal>, Error> {
                    let pair = native_pty_system().openpty(pty_size)?;
                    let mut command = CommandBuilder::new(prepared.program);
                    command.args(prepared.arguments);
                    command.cwd(cwd);
                    if profile_environment == ShellEnvironmentPolicy::RemoveSensitive {
                        for (name, _) in std::env::vars_os() {
                            if crate::tool::is_sensitive_environment_name(&name.to_string_lossy()) {
                                command.env_remove(name);
                            }
                        }
                    }
                    command.env("TERM", "xterm-256color");
                    command.env("COLORTERM", "truecolor");
                    command.env("TERM_PROGRAM", "Morphz");
                    command.env("MORPHZ_EMBEDDED_TERMINAL", "1");
                    // The sandbox wrapper /bin/sh resets PS1. Zsh's PROMPT
                    // survives that wrapper; bash receives its PS1 at exec above.
                    // No user startup files, plugins or command substitutions.
                    command.env("PROMPT", "%F{blue}%2~%f %F{green}%#%f ");
                    command.env("PROMPT_DIRTRIM", "2");
                    command.env("CLICOLOR", "1");
                    command.env("LSCOLORS", "exfxcxdxbxegedabagacad");
                    let mut child = StartingChild(Some(pair.slave.spawn_command(command)?));
                    drop(pair.slave);
                    let process_id = child
                        .0
                        .as_ref()
                        .unwrap()
                        .process_id()
                        .and_then(|id| i32::try_from(id).ok())
                        .filter(|id| *id > 0)
                        .ok_or("terminal child has no process identity")?;
                    let mut reader = pair.master.try_clone_reader()?;
                    let writer = pair.master.take_writer()?;
                    use std::os::fd::{AsFd, BorrowedFd};
                    let fd = pair
                        .master
                        .as_raw_fd()
                        .ok_or("terminal master does not expose a pollable descriptor")?;
                    // Own a duplicate for poll, so a closing/reused master descriptor
                    // can never make the reader poll an unrelated file.
                    let poll_fd = nix::unistd::dup(unsafe { BorrowedFd::borrow_raw(fd) })?;
                    let stopped = Arc::new(AtomicBool::new(false));
                    let screen = Arc::new(Mutex::new(ScreenState {
                        parser: vt100::Parser::new(rows, cols, SCROLLBACK),
                        sequence: 0,
                        eof: false,
                        error: None,
                    }));
                    let live = Arc::new(LiveTerminal {
                        control: tokio::sync::Mutex::new(()),
                        screen: screen.clone(),
                        master: Mutex::new(pair.master),
                        writer: Mutex::new(writer),
                        child: Mutex::new(child.0.take().unwrap()),
                        process_id,
                        stopped: stopped.clone(),
                    });
                    // Parse in the reader itself: there is no unbounded channel or
                    // accumulated byte log between a noisy child and the screen.
                    std::thread::Builder::new()
                        .name("morphz-terminal-reader".into())
                        .spawn(move || {
                            let mut buffer = [0u8; 8192];
                            loop {
                                if stopped.load(Ordering::SeqCst) {
                                    break;
                                }
                                let mut fds = [nix::poll::PollFd::new(
                                    poll_fd.as_fd(),
                                    nix::poll::PollFlags::POLLIN,
                                )];
                                match nix::poll::poll(&mut fds, 100u16) {
                                    Ok(0) => continue,
                                    Ok(_) => {}
                                    Err(nix::errno::Errno::EINTR) => continue,
                                    Err(_) => break,
                                }
                                match reader.read(&mut buffer) {
                                    Ok(0) => {
                                        if let Ok(mut s) = screen.lock() {
                                            s.eof = true;
                                        }
                                        break;
                                    }
                                    Ok(count) => {
                                        let Ok(mut s) = screen.lock() else {
                                            break;
                                        };
                                        s.parser.process(&buffer[..count]);
                                        s.sequence = s.sequence.saturating_add(1);
                                    }
                                    Err(error) => {
                                        if let Ok(mut s) = screen.lock() {
                                            s.eof = true;
                                            s.error = Some(error.to_string());
                                        }
                                        break;
                                    }
                                }
                            }
                        })?;
                    Ok(live)
                })
                .await?;
            let live = match spawned {
                Ok(live) => live,
                Err(error) => {
                    record.status = TerminalStatus::Lost;
                    record.updated_at = now();
                    let _ = self.store.compare_terminal(1, &record).await;
                    return Err(error);
                }
            };
            record.status = TerminalStatus::Open;
            if !self.store.compare_terminal(1, &record).await? {
                live.stop();
                return Err("terminal creation ownership changed; spawned process stopped".into());
            }
            self.live
                .lock()
                .map_err(|_| "terminal registry poisoned")?
                .insert(id.clone(), live.clone());
            let weak = Arc::downgrade(self);
            let weak_live = Arc::downgrade(&live);
            let monitor_id = id.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
                loop {
                    interval.tick().await;
                    let (Some(manager), Some(live)) = (weak.upgrade(), weak_live.upgrade()) else {
                        break;
                    };
                    if let Err(error) = manager.checkpoint(&monitor_id, &live).await {
                        tracing::warn!(%error,event_code="terminal.checkpoint_failed","Terminal checkpoint was not confirmed");
                    }
                    if live.stopped.load(Ordering::SeqCst) {
                        break;
                    }
                }
            });
            self.view(&id, &caller.session_id, &caller.context_id, &principal, 0)
                .await
        }
    }

    async fn checkpoint(&self, id: &str, live: &Arc<LiveTerminal>) -> Result<(), Error> {
        let _control = live.control.lock().await;
        let Some(mut record) = self.store.terminal(id).await? else {
            live.stop();
            return Ok(());
        };
        if record.owner_instance_id != self.instance_id {
            live.stop();
            return Err("terminal owner changed".into());
        }
        let authorized = self
            .authorize(&record.session_id, &record.context_id, &record.principal_id)
            .await
            .is_ok();
        let unchanged = record.policy_hash
            == policy_hash(&self.permissions.profile_for_session(&record.session_id));
        if !authorized || !unchanged {
            live.stop();
            record.status = TerminalStatus::Closed;
            record.revision += 1;
            record.updated_at = now();
            self.store
                .compare_terminal(record.revision - 1, &record)
                .await?;
        } else if record.status == TerminalStatus::Open {
            let status = live
                .child
                .lock()
                .map_err(|_| "terminal child poisoned")?
                .try_wait()?;
            if let Some(status) = status {
                record.exit_code = Some(status.exit_code());
                record.status = TerminalStatus::Exited;
                record.revision += 1;
                record.updated_at = now();
                live.stop();
                self.store
                    .compare_terminal(record.revision - 1, &record)
                    .await?;
            }
        }
        let screen = screen_snapshot(
            &mut *live.screen.lock().map_err(|_| "terminal screen poisoned")?,
            0,
        );
        self.store
            .save_terminal_checkpoint(id, &self.instance_id, &serde_json::to_string(&screen)?)
            .await?;
        if live.stopped.load(Ordering::SeqCst) {
            self.live
                .lock()
                .map_err(|_| "terminal registry poisoned")?
                .remove(id);
        }
        Ok(())
    }

    async fn control(
        &self,
        caller: &ToolExecutionJobContext,
        id: &str,
        expected: u64,
        action: &TerminalAction,
    ) -> Result<serde_json::Value, Error> {
        let live = self
            .live
            .lock()
            .map_err(|_| "terminal registry poisoned")?
            .get(id)
            .cloned()
            .ok_or("terminal is disconnected; never replay old commands to recover it")?;
        let _control = live.control.lock().await;
        let mut record = self.store.terminal(id).await?.ok_or("terminal not found")?;
        if record.session_id != caller.session_id
            || record.context_id != caller.context_id
            || Some(&record.principal_id) != caller.initiating_principal_id.as_ref()
            || record.target_id != caller.target_id
            || record.owner_instance_id != self.instance_id
        {
            return Err("terminal authority mismatch".into());
        }
        if record.last_input_job_id.as_deref() == Some(&caller.parent_job_id) {
            return Ok(
                serde_json::json!({"terminal_id":id,"revision":record.revision,"input_status":record.last_input_status,"replayed":false}),
            );
        }
        if record.last_input_status.as_deref() == Some("uncertain")
            && !matches!(action, TerminalAction::Close { .. })
        {
            return Err("previous terminal input receipt is uncertain; read the screen to inspect what happened, then close this terminal and open a new one instead of queueing or replaying input".into());
        }
        if record.status != TerminalStatus::Open || live.stopped.load(Ordering::SeqCst) {
            return Err("terminal has ended".into());
        }
        if policy_hash(&self.permissions.profile_for_session(&caller.session_id))
            != record.policy_hash
        {
            live.stop();
            return Err("terminal permission boundary changed; old shell stopped, open a new terminal under the current policy".into());
        }
        if record.revision != expected {
            return Err(format!(
                "terminal revision conflict: current revision is {}; read before sending again",
                record.revision
            )
            .into());
        }
        let input = match action {
            TerminalAction::Write { text, enter, .. } => {
                if text.len() > 4096 || text.contains('\0') {
                    return Err("terminal input must be at most 4096 bytes with no NUL".into());
                }
                let mut bytes = text.as_bytes().to_vec();
                if *enter {
                    bytes.push(b'\r');
                }
                Some(bytes)
            }
            TerminalAction::Interrupt { .. } => Some(vec![3]),
            TerminalAction::Resize { rows, cols, .. } => {
                size(*rows, *cols)?;
                None
            }
            TerminalAction::Close { .. } => None,
            _ => return Err("invalid terminal control".into()),
        };
        record.revision += 1;
        record.last_input_job_id = Some(caller.parent_job_id.clone());
        record.last_input_status = Some("uncertain".into());
        record.updated_at = now();
        if !self.store.compare_terminal(expected, &record).await? {
            return Err("terminal revision changed before input; nothing was sent".into());
        }
        crate::tool::mark_physical_side_effect().await?;
        // No retry after this point: a timed-out write may already have reached
        // the PTY. The durable uncertain receipt remains authoritative.
        let writer = live.clone();
        if let Some(bytes) = input {
            tokio::time::timeout(
                std::time::Duration::from_secs(3),
                tokio::task::spawn_blocking(move || -> Result<(), Error> {
                    let mut output = writer
                        .writer
                        .lock()
                        .map_err(|_| "terminal writer poisoned")?;
                    output.write_all(&bytes)?;
                    output.flush()?;
                    Ok(())
                }),
            )
            .await
            .map_err(|_| "terminal input receipt is uncertain; do not resend")???;
        } else {
            match action {
                TerminalAction::Resize { rows, cols, .. } => {
                    live.master
                        .lock()
                        .map_err(|_| "terminal master poisoned")?
                        .resize(size(*rows, *cols)?)?;
                    live.screen
                        .lock()
                        .map_err(|_| "terminal screen poisoned")?
                        .parser
                        .screen_mut()
                        .set_size(*rows, *cols);
                    record.rows = *rows;
                    record.cols = *cols;
                }
                TerminalAction::Close { .. } => {
                    live.stop();
                    record.status = TerminalStatus::Closed;
                }
                _ => {}
            }
        }
        record.last_input_status = Some("submitted".into());
        if !self
            .store
            .compare_terminal(record.revision, &record)
            .await?
        {
            return Err(
                "terminal input was sent but its receipt is uncertain; read state, do not resend"
                    .into(),
            );
        }
        Ok(
            serde_json::json!({"terminal_id":id,"revision":record.revision,"input_status":"submitted","command_completion":"not_asserted","replayed":false}),
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum TerminalAction {
    Open {
        #[serde(default = "default_title")]
        title: String,
        #[serde(default = "default_cwd")]
        cwd: String,
        #[serde(default = "default_rows")]
        rows: u16,
        #[serde(default = "default_cols")]
        cols: u16,
    },
    List,
    Read {
        terminal_id: String,
        #[serde(default)]
        scrollback: usize,
        #[serde(default)]
        after_sequence: Option<u64>,
        #[serde(default)]
        wait_ms: u64,
    },
    Write {
        terminal_id: String,
        expected_revision: u64,
        text: String,
        #[serde(default = "yes")]
        enter: bool,
    },
    Interrupt {
        terminal_id: String,
        expected_revision: u64,
    },
    Resize {
        terminal_id: String,
        expected_revision: u64,
        rows: u16,
        cols: u16,
    },
    Close {
        terminal_id: String,
        expected_revision: u64,
    },
}
fn default_title() -> String {
    "Terminal".into()
}
fn default_cwd() -> String {
    ".".into()
}
fn default_rows() -> u16 {
    24
}
fn default_cols() -> u16 {
    80
}
fn yes() -> bool {
    true
}

pub struct TerminalTool {
    manager: Arc<TerminalManager>,
}
impl TerminalTool {
    pub fn new(manager: Arc<TerminalManager>) -> Self {
        Self { manager }
    }
}

#[async_trait::async_trait]
impl Tool for TerminalTool {
    fn name(&self) -> &str {
        "terminal"
    }
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name:self.name().into(),
            description:"Operate the real PTY shown in Morphz's built-in Terminal application. Open creates a persistent system shell (cwd and environment survive). Write sends input, not proof of command completion; explicitly read the bounded screen to verify. Use enter=false for interactive input, interrupt for Ctrl+C, resize for the PTY size, close only to explicitly end it. Read returns one screen window; scrollback is a bounded row offset (0=current, maximum 500). To await new output, read with the last after_sequence and wait_ms up to 5000; no input is repeated. Plain reads explicitly flag text_truncated beyond 24000 characters. List returns metadata only, active sessions first, with has_more. Mutations require the latest expected_revision and must never be replayed when the receipt is uncertain. Ordinary exec is separate and does not appear here. Only the Runtime local execution node is supported; no remote fallback or permission escalation.".into(),
            parameters:serde_json::json!({
                "type":"object",
                "properties":{
                    "action":{"type":"string","enum":["open","list","read","write","interrupt","resize","close"]},
                    "terminal_id":{"type":"string"},"expected_revision":{"type":"integer","minimum":1},
                    "title":{"type":"string","maxLength":80},"cwd":{"type":"string"},
                    "text":{"type":"string","maxLength":4096},"enter":{"type":"boolean"},
                    "rows":{"type":"integer","minimum":4,"maximum":60},"cols":{"type":"integer","minimum":20,"maximum":160},
                    "scrollback":{"type":"integer","minimum":0,"maximum":500},
                    "after_sequence":{"type":"integer","minimum":0},"wait_ms":{"type":"integer","minimum":0,"maximum":5000}
                },"required":["action"],"additionalProperties":false
            })
        }
    }
    fn retry_safety_for_arguments(&self, arguments: &str) -> crate::memory::ExecutionRetrySafety {
        match serde_json::from_str::<TerminalAction>(arguments) {
            Ok(TerminalAction::List | TerminalAction::Read { .. }) => {
                crate::memory::ExecutionRetrySafety::Idempotent
            }
            _ => crate::memory::ExecutionRetrySafety::AtMostOnce,
        }
    }
    async fn execute(&self, arguments: &str) -> Result<String, Error> {
        let action: TerminalAction = serde_json::from_str(arguments)?;
        let caller = self.manager.caller().await?;
        let principal = caller
            .initiating_principal_id
            .as_deref()
            .ok_or("missing Principal")?;
        let result = match &action {
            TerminalAction::Open {
                title,
                cwd,
                rows,
                cols,
            } => {
                let view = self
                    .manager
                    .open(&caller, title.clone(), cwd.clone(), *rows, *cols)
                    .await?;
                serde_json::json!({"terminal":view.terminal,"connected":view.connected,"screen_available":true})
            }
            TerminalAction::List => {
                let mut records = self
                    .manager
                    .list(&TerminalSessionFilter {
                        session_id: caller.session_id.clone(),
                        context_id: caller.context_id.clone(),
                        principal_id: principal.into(),
                        root_ids: None,
                        limit: 51,
                    })
                    .await?;
                let has_more = records.len() > 50;
                records.truncate(50);
                serde_json::json!({"terminals":records,"limit":50,"has_more":has_more})
            }
            TerminalAction::Read {
                terminal_id,
                scrollback,
                after_sequence,
                wait_ms,
            } => {
                self.manager
                    .wait_output(terminal_id, &caller, *after_sequence, *wait_ms)
                    .await?;
                let view = self
                    .manager
                    .view(
                        terminal_id,
                        &caller.session_id,
                        &caller.context_id,
                        principal,
                        *scrollback,
                    )
                    .await?;
                serde_json::json!({"terminal":view.terminal,"connected":view.connected,"checkpoint":view.checkpoint,"screen":view.screen.as_ref().map(|screen|serde_json::json!({"text":screen.text.chars().take(24000).collect::<String>(),"text_truncated":screen.text.chars().count()>24000,"sequence":screen.sequence,"rows":screen.rows,"cols":screen.cols,"scrollback":screen.scrollback,"previous_available":screen.previous_available,"alternate_screen":screen.alternate_screen}))})
            }
            TerminalAction::Write {
                terminal_id,
                expected_revision,
                ..
            }
            | TerminalAction::Interrupt {
                terminal_id,
                expected_revision,
            }
            | TerminalAction::Resize {
                terminal_id,
                expected_revision,
                ..
            }
            | TerminalAction::Close {
                terminal_id,
                expected_revision,
            } => {
                self.manager
                    .control(&caller, terminal_id, *expected_revision, &action)
                    .await?
            }
        };
        Ok(serde_json::to_string(&result)?)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::event::{Event, TYPE_USER_MESSAGE};
    use crate::execution::{ExecutionJobManager, ExecutionJobSpec, JobClaim};
    use crate::llm::{Client, Message, Response};
    use crate::memory::{
        NewAgent, NewCognitiveContext, NewSession, NewThread, NewThreadActivation,
        SessionMountKind, ThreadKind, ThreadSupervision,
    };
    use crate::permission::PermissionMode;
    use crate::runtime::{MorphzRuntime, RuntimeIdentity};
    use serde_json::{json, Value};

    struct NoModel;
    #[async_trait::async_trait]
    impl Client for NoModel {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Error> {
            panic!("physical Terminal tests must not call a model");
        }
    }
    struct Fixture {
        _directory: tempfile::TempDir,
        runtime: MorphzRuntime,
        store: Arc<dyn RuntimeStore>,
        manager: Arc<TerminalManager>,
        caller: ToolExecutionJobContext,
        serial: std::sync::atomic::AtomicUsize,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let store: Arc<dyn RuntimeStore> = Arc::new(
                crate::memory::sqlite::SqliteStore::new(
                    directory.path().join("runtime.sqlite").to_str().unwrap(),
                )
                .await
                .unwrap(),
            );
            Self::with_store(directory, store).await
        }
        async fn with_store(directory: tempfile::TempDir, store: Arc<dyn RuntimeStore>) -> Self {
            let suffix = directory
                .path()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            let mut config = AppConfig::default();
            config.permissions.workspace_root = directory.path().to_string_lossy().into_owned();
            config.permissions.read_only_outside_workspace = false;
            config.permissions.mode = PermissionMode::RequestApproval;
            config.permissions.network = false;
            config.background_task.artifact_dir = directory
                .path()
                .join("output")
                .to_string_lossy()
                .into_owned();
            let runtime = MorphzRuntime::builder(config, Arc::new(NoModel))
                .identity(RuntimeIdentity {
                    agent_id: format!("terminal-agent-{suffix}"),
                    context_id: format!("terminal-context-{suffix}"),
                    principal_id: format!("terminal-human-{suffix}"),
                })
                .store("terminal-test", store.clone())
                .build()
                .await
                .unwrap();
            let identity = runtime.identity();
            runtime
                .ensure_agent(NewAgent {
                    id: identity.agent_id.clone(),
                    title: "Terminal test Agent".into(),
                    root_context_id: identity.context_id.clone(),
                })
                .await
                .unwrap();
            runtime
                .ensure_context(NewCognitiveContext {
                    id: identity.context_id.clone(),
                    agent_id: identity.agent_id.clone(),
                    title: "Terminal test Context".into(),
                })
                .await
                .unwrap();
            let session_id = format!("terminal-session-{suffix}");
            runtime
                .ensure_session(NewSession {
                    id: session_id.clone(),
                    agent_id: identity.agent_id.clone(),
                    context_id: identity.context_id.clone(),
                    parent_session_id: None,
                    title: "Terminal physical test".into(),
                    mount_kind: SessionMountKind::ExistingContext,
                })
                .await
                .unwrap();
            let root = format!("terminal-root-{suffix}");
            let event=Event::new(root.clone(),identity.principal_id.clone(),TYPE_USER_MESSAGE.into(),session_id.clone(),json!({"context_id":identity.context_id,"session_id":session_id,"principal_id":identity.principal_id,"content":"Terminal physical test"}).as_object().unwrap().clone());
            store.append(event.clone()).await.unwrap();
            let thread = store
                .ensure_thread(NewThread {
                    id: format!("terminal-thread-{suffix}"),
                    agent_id: identity.agent_id.clone(),
                    context_id: identity.context_id.clone(),
                    session_id: session_id.clone(),
                    initiating_principal_id: Some(identity.principal_id.clone()),
                    root_turn_id: root.clone(),
                    kind: ThreadKind::Execution,
                    executor_kind: "self".into(),
                    executor_id: None,
                    target_id: Some(crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.into()),
                    supervision: ThreadSupervision::legacy(),
                    response_annotations: crate::response_annotations::Protocol::Off,
                    model_alias: None,
                    reasoning_effort: None,
                })
                .await
                .unwrap();
            let activation = store
                .ensure_thread_activation(NewThreadActivation {
                    id: format!("terminal-activation-{suffix}"),
                    agent_id: identity.agent_id.clone(),
                    context_id: identity.context_id.clone(),
                    session_id: session_id.clone(),
                    initiating_principal_id: Some(identity.principal_id.clone()),
                    trigger_event_id: root.clone(),
                    trigger_sequence: event.sequence.unwrap_or(1),
                    trigger_kind: "test".into(),
                    parent_activation_id: None,
                    root_turn_id: root,
                })
                .await
                .unwrap();
            let caller = ToolExecutionJobContext {
                parent_job_id: String::new(),
                activation_id: activation.id,
                thread_id: thread.id,
                agent_id: identity.agent_id.clone(),
                context_id: identity.context_id.clone(),
                session_id,
                initiating_principal_id: Some(identity.principal_id.clone()),
                target_id: crate::execution_target::DEFAULT_EXECUTION_TARGET_ID.into(),
                tool_call_id: String::new(),
            };
            let manager = runtime.terminals().clone();
            Self {
                _directory: directory,
                runtime,
                store,
                manager,
                caller,
                serial: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        async fn job(&self, args: &Value) -> ToolExecutionJobContext {
            let mut caller = self.caller.clone();
            caller.tool_call_id = format!(
                "terminal-call-{}",
                self.serial.fetch_add(1, Ordering::SeqCst)
            );
            let manager = ExecutionJobManager::new(self.store.clone());
            let job = manager
                .ensure(ExecutionJobSpec {
                    activation_id: caller.activation_id.clone(),
                    thread_id: caller.thread_id.clone(),
                    agent_id: caller.agent_id.clone(),
                    context_id: caller.context_id.clone(),
                    session_id: caller.session_id.clone(),
                    initiating_principal_id: caller.initiating_principal_id.clone(),
                    target_id: caller.target_id.clone(),
                    tool_call_id: caller.tool_call_id.clone(),
                    tool_name: "terminal".into(),
                    request: args.clone(),
                    retry_safety: crate::memory::ExecutionRetrySafety::AtMostOnce,
                    requires_approval: false,
                })
                .await
                .unwrap();
            manager
                .claim(
                    &job.id,
                    job.revision,
                    JobClaim {
                        worker_id: "terminal-test-owner",
                        claim_token: &caller.tool_call_id,
                        lease_expires_at: chrono::Utc::now() + chrono::Duration::minutes(2),
                        approval_ref: None,
                    },
                )
                .await
                .unwrap();
            caller.parent_job_id = job.id;
            caller
        }
        async fn invoke_as(
            &self,
            caller: ToolExecutionJobContext,
            args: Value,
        ) -> Result<Value, Error> {
            let tool = TerminalTool::new(self.manager.clone());
            let text = CURRENT_EXECUTION_JOB
                .scope(Some(caller), tool.execute(&args.to_string()))
                .await?;
            Ok(serde_json::from_str(&text)?)
        }
        async fn invoke(&self, args: Value) -> Result<Value, Error> {
            self.invoke_as(self.job(&args).await, args).await
        }
        async fn open(&self) -> TerminalSessionRecord {
            let result = self
                .invoke(json!({"action":"open","title":"Terminal test"}))
                .await
                .unwrap();
            assert!(
                result.get("screen").is_none(),
                "open must not preload terminal output into model context"
            );
            let terminal: TerminalSessionRecord =
                serde_json::from_value(result["terminal"].clone()).unwrap();
            self.invoke(json!({"action":"write","terminal_id":terminal.id,"expected_revision":1,"text":"stty -echo; printf '\\n__READY__\\n'"})).await.unwrap();
            self.wait_line(&terminal.id, "__READY__").await;
            self.store.terminal(&terminal.id).await.unwrap().unwrap()
        }
        async fn wait_line(&self, id: &str, expected: &str) -> TerminalView {
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let view = self
                        .manager
                        .view(
                            id,
                            &self.caller.session_id,
                            &self.caller.context_id,
                            self.caller.initiating_principal_id.as_deref().unwrap(),
                            0,
                        )
                        .await
                        .unwrap();
                    if view
                        .screen
                        .as_ref()
                        .is_some_and(|s| s.text.lines().any(|line| line.trim() == expected))
                    {
                        return view;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or_else(|_| {
                panic!("terminal never produced the actual output line {expected:?}")
            })
        }
        async fn write(&self, id: &str, text: &str) -> Value {
            let revision = self.store.terminal(id).await.unwrap().unwrap().revision;
            self.invoke(
                json!({"action":"write","terminal_id":id,"expected_revision":revision,"text":text}),
            )
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn terminal_real_pty_keeps_directory_environment_unicode_and_ansi() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        assert!(fixture
            .runtime
            .tool_names()
            .iter()
            .any(|name| name == "exec"));
        assert!(fixture
            .runtime
            .tool_names()
            .iter()
            .any(|name| name == "terminal"));
        assert_eq!(record.sandbox_status, "enforced");
        fixture.write(&record.id,"mkdir branch; cd branch; export MORPHZ_TERMINAL_CHECK='中文状态'; printf '\\n__CHANGED__\\n'").await;
        fixture.wait_line(&record.id, "__CHANGED__").await;
        fixture.write(&record.id,"test \"$PWD\" = \"$(pwd -P)\" && test -d ../branch && printf '\\n__ENV__:%s\\n' \"$MORPHZ_TERMINAL_CHECK\"; printf '\\033[31m__RED__\\033[0m\\n'").await;
        fixture.wait_line(&record.id, "__ENV__:中文状态").await;
        assert!(fixture._directory.path().join("branch").is_dir());
        let view = fixture.wait_line(&record.id, "__RED__").await;
        assert!(view.screen.unwrap().lines.iter().flatten().any(|span| span
            .text
            .contains("__RED__")
            && span.fg.as_deref() == Some("#c94343")
            && span.fg_index == Some(1)));
        assert!(view.connected);
        let result = fixture
            .invoke(json!({"action":"read","terminal_id":record.id}))
            .await
            .unwrap();
        assert!(
            result["screen"].get("lines").is_none(),
            "Agent reads plain bounded text, not UI cells"
        );
    }

    #[tokio::test]
    async fn terminal_default_prompt_survives_sandbox_shell_wrapper() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        fixture.write(&record.id, "printf '\\n__COLOR_ENV__:%s:%s\\n' \"$CLICOLOR\" \"$TERM_PROGRAM\"; printf '__PROMPT__:%s\\n' \"$PS1\"").await;
        let view = fixture
            .wait_line(&record.id, "__COLOR_ENV__:1:Morphz")
            .await;
        let screen = view.screen.unwrap();
        assert!(screen.text.contains("__PROMPT__:"));
        if record.shell == "/bin/zsh" {
            assert!(screen.text.contains("%F{blue}%2~%f %F{green}%#%f"));
        } else if record.shell == "/bin/bash" {
            assert!(screen.text.contains("\\033[34m"));
        }
        // This is the actual prompt generated by the PTY shell, not the echoed
        // source string. It must contain separate colored cwd and prompt spans.
        let colored = screen
            .lines
            .iter()
            .flatten()
            .filter_map(|span| span.fg_index)
            .collect::<Vec<_>>();
        assert!(colored.contains(&4), "actual prompt path is blue");
        assert!(colored.contains(&2), "actual prompt symbol is green");
    }

    #[test]
    fn terminal_palette_index_is_not_inferred_from_truecolor() {
        let mut state = ScreenState {
            parser: vt100::Parser::new(4, 80, SCROLLBACK),
            sequence: 1,
            eof: false,
            error: None,
        };
        state
            .parser
            .process(b"\x1b[31mA\x1b[38;2;201;67;67mB\x1b[38;5;196mC\x1b[0m");
        let screen = screen_snapshot(&mut state, 0);
        let spans = &screen.lines[0];
        assert_eq!(spans[0].fg.as_deref(), Some("#c94343"));
        assert_eq!(spans[0].fg_index, Some(1));
        assert_eq!(spans[1].fg.as_deref(), Some("#c94343"));
        assert_eq!(spans[1].fg_index, None);
        assert_eq!(spans[2].fg_index, Some(196));
        assert_eq!(spans[2].fg.as_deref(), Some("#ff0000"));
    }

    #[tokio::test]
    async fn terminal_input_revision_and_same_job_replay_are_fenced() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        let args = json!({"action":"write","terminal_id":record.id,"expected_revision":record.revision,"text":"printf x >> once.txt; printf '\\n__ONCE__\\n'"});
        let caller = fixture.job(&args).await;
        fixture
            .invoke_as(caller.clone(), args.clone())
            .await
            .unwrap();
        fixture.wait_line(&record.id, "__ONCE__").await;
        let replay = fixture.invoke_as(caller, args.clone()).await.unwrap();
        assert_eq!(replay["replayed"], false);
        assert_eq!(
            std::fs::read_to_string(fixture._directory.path().join("once.txt")).unwrap(),
            "x"
        );
        assert!(fixture
            .invoke(args)
            .await
            .unwrap_err()
            .to_string()
            .contains("revision conflict"));
    }

    #[tokio::test]
    async fn terminal_uncertain_receipt_blocks_new_input_but_allows_read_and_close() {
        let fixture = Fixture::new().await;
        let mut record = fixture.open().await;
        let args = json!({"action":"write","terminal_id":record.id,"expected_revision":record.revision,"text":"printf should-not-run > uncertain.txt"});
        let caller = fixture.job(&args).await;
        let expected = record.revision;
        record.revision += 1;
        record.last_input_job_id = Some(caller.parent_job_id.clone());
        record.last_input_status = Some("uncertain".into());
        assert!(fixture
            .store
            .compare_terminal(expected, &record)
            .await
            .unwrap());
        let replay = fixture.invoke_as(caller, args).await.unwrap();
        assert_eq!(replay["input_status"], "uncertain");
        let error = fixture.invoke(json!({"action":"write","terminal_id":record.id,"expected_revision":record.revision,"text":"printf should-not-run > uncertain.txt"})).await.unwrap_err();
        assert!(error.to_string().contains("receipt is uncertain"));
        assert!(!fixture._directory.path().join("uncertain.txt").exists());
        let view = fixture
            .invoke(json!({"action":"read","terminal_id":record.id}))
            .await
            .unwrap();
        assert_eq!(view["terminal"]["last_input_status"], "uncertain");
        assert!(view["screen"]["text"].is_string());
        fixture.invoke(json!({"action":"close","terminal_id":record.id,"expected_revision":record.revision})).await.unwrap();
        assert_eq!(
            fixture
                .store
                .terminal(&record.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            TerminalStatus::Closed
        );
    }

    #[tokio::test]
    async fn terminal_read_can_wait_for_actual_delayed_output_without_resending() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        fixture
            .write(&record.id, "sleep 0.2; printf '\\n__DELAYED__\\n'")
            .await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut sequence = 0;
            loop {
                let result = fixture.invoke(json!({"action":"read","terminal_id":record.id,"after_sequence":sequence,"wait_ms":1000})).await.unwrap();
                sequence = result["screen"]["sequence"].as_u64().unwrap();
                if result["screen"]["text"].as_str().unwrap().lines().any(|line| line == "__DELAYED__") {
                    break result;
                }
            }
        }).await.unwrap();
        assert!(result["connected"].as_bool().unwrap());
        assert!(fixture
            .invoke(json!({"action":"read","terminal_id":record.id,"wait_ms":5001}))
            .await
            .unwrap_err()
            .to_string()
            .contains("5000"));
    }

    #[tokio::test]
    async fn terminal_interrupt_keeps_shell_and_resize_is_real() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        fixture.write(&record.id, "sleep 30").await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let mut record = fixture.store.terminal(&record.id).await.unwrap().unwrap();
        fixture.invoke(json!({"action":"interrupt","terminal_id":record.id,"expected_revision":record.revision})).await.unwrap();
        record = fixture.store.terminal(&record.id).await.unwrap().unwrap();
        fixture.invoke(json!({"action":"resize","terminal_id":record.id,"expected_revision":record.revision,"rows":30,"cols":96})).await.unwrap();
        fixture
            .write(&record.id, "printf '\\n__SIZE__:'; stty size")
            .await;
        let view = fixture.wait_line(&record.id, "__SIZE__:30 96").await;
        assert_eq!(view.screen.unwrap().cols, 96);
        assert!(view.connected);
    }

    #[tokio::test]
    async fn terminal_scope_and_physical_owner_are_not_model_arguments() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        let manager = &fixture.manager;
        assert!(manager
            .view(
                &record.id,
                &fixture.caller.session_id,
                "another-context",
                fixture.caller.initiating_principal_id.as_deref().unwrap(),
                0
            )
            .await
            .is_err());
        assert!(manager
            .view(
                &record.id,
                &fixture.caller.session_id,
                &fixture.caller.context_id,
                "another-principal",
                0
            )
            .await
            .is_err());
        let tool = TerminalTool::new(manager.clone());
        assert!(tool
            .execute("{\"action\":\"list\"}")
            .await
            .unwrap_err()
            .to_string()
            .contains("ExecutionJob"));
        let mut caller = fixture.job(&json!({"action":"list"})).await;
        caller.target_id = "target-other".into();
        assert!(fixture
            .invoke_as(caller, json!({"action":"list"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("no local fallback"));
        assert!(fixture
            .invoke(json!({"action":"open","principal_id":"fake"}))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn terminal_sandbox_denies_outside_writes_and_protected_files() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(
            fixture._directory.path().join(".env"),
            "PRIVATE_TERMINAL_TEST",
        )
        .unwrap();
        let text=format!("if printf bad > '{}'; then printf '\\n__UNSAFE__\\n'; else printf '\\n__WRITE_DENIED__\\n'; fi; if cat .env >/dev/null 2>&1; then printf '\\n__UNSAFE__\\n'; else printf '\\n__READ_DENIED__\\n'; fi",outside.path().join("must-not-exist").display());
        fixture.write(&record.id, &text).await;
        fixture.wait_line(&record.id, "__WRITE_DENIED__").await;
        fixture.wait_line(&record.id, "__READ_DENIED__").await;
        assert!(!outside.path().join("must-not-exist").exists());
    }

    #[tokio::test]
    async fn terminal_filter_precedes_limit_and_checkpoint_is_not_a_live_handle() {
        let fixture = Fixture::new().await;
        let record = fixture.open().await;
        let live = fixture
            .manager
            .live
            .lock()
            .unwrap()
            .get(&record.id)
            .unwrap()
            .clone();
        fixture.manager.checkpoint(&record.id, &live).await.unwrap();
        let no_match = fixture
            .manager
            .list(&TerminalSessionFilter {
                session_id: record.session_id.clone(),
                context_id: record.context_id.clone(),
                principal_id: record.principal_id.clone(),
                root_ids: Some(vec!["not-this-root".into()]),
                limit: 1,
            })
            .await
            .unwrap();
        assert!(no_match.is_empty());
        let new_owner =
            TerminalManager::new(fixture.store.clone(), fixture.manager.permissions.clone());
        let view = new_owner
            .view(
                &record.id,
                &record.session_id,
                &record.context_id,
                &record.principal_id,
                0,
            )
            .await
            .unwrap();
        assert!(!view.connected);
        assert!(view.checkpoint);
        assert!(view.screen.is_some());
        let latest = fixture.store.terminal(&record.id).await.unwrap().unwrap();
        fixture.invoke(json!({"action":"close","terminal_id":record.id,"expected_revision":latest.revision})).await.unwrap();
        assert_eq!(
            fixture
                .store
                .terminal(&record.id)
                .await
                .unwrap()
                .unwrap()
                .status,
            TerminalStatus::Closed
        );
        assert!(fixture
            .manager
            .metadata(
                &record.id,
                &record.session_id,
                &record.context_id,
                &record.principal_id
            )
            .await
            .is_ok());
    }

    #[test]
    fn terminal_screen_and_input_bounds_are_finite() {
        let mut state = ScreenState {
            parser: vt100::Parser::new(24, 80, SCROLLBACK),
            sequence: 1,
            eof: false,
            error: None,
        };
        assert!(!screen_snapshot(&mut state, 0).previous_available);
        for _ in 0..10000 {
            state.parser.process(b"bounded terminal output\r\n");
        }
        let screen = screen_snapshot(&mut state, 10000);
        assert!(screen.scrollback <= SCROLLBACK);
        assert!(serde_json::to_string(&screen).unwrap().len() < 524288);
        assert_eq!(screen.lines.len(), 24);
        assert!(size(400, 80).is_err());
        assert!(size(24, 1000).is_err());
    }

    #[test]
    fn terminal_adversarial_ansi_is_bounded_without_losing_visible_text() {
        let mut state = ScreenState {
            parser: vt100::Parser::new(60, 160, SCROLLBACK),
            sequence: 1,
            eof: false,
            error: None,
        };
        for row in 1..=60 {
            state.parser.process(format!("\x1b[{row};1H").as_bytes());
            for col in 0..160 {
                state.parser.process(
                    format!(
                        "\x1b[38;2;{};{};{}m\x1b[48;2;{};{};{}m\x1b[1;3;4mX",
                        col,
                        row,
                        col + row,
                        row,
                        col,
                        col + row
                    )
                    .as_bytes(),
                );
            }
        }
        let screen = screen_snapshot(&mut state, 0);
        assert!(screen.styles_simplified);
        assert_eq!(screen.text.chars().filter(|c| *c == 'X').count(), 9600);
        assert!(serde_json::to_vec(&screen).unwrap().len() < 524288);
        assert_eq!(screen.lines.iter().map(Vec::len).sum::<usize>(), 60);
    }

    #[tokio::test]
    #[ignore = "requires the dedicated MORPHZ_TEST_POSTGRES_URL test cluster; run explicitly with --include-ignored"]
    async fn terminal_postgres_store_and_real_pty_contract() {
        let url = std::env::var("MORPHZ_TEST_POSTGRES_URL")
            .expect("a dedicated test PostgreSQL URL is required; never use business credentials");
        let directory = tempfile::tempdir().unwrap();
        let store: Arc<dyn RuntimeStore> = Arc::new(
            crate::memory::postgres::PostgresStore::new(&url, 4)
                .await
                .unwrap(),
        );
        let f = Fixture::with_store(directory, store).await;
        let record = f.open().await;
        let args = json!({"action":"write","terminal_id":record.id,"expected_revision":record.revision,"text":"printf x >> pg-once.txt; printf '\\n__PG_READY__\\n'"});
        let caller = f.job(&args).await;
        f.invoke_as(caller.clone(), args.clone()).await.unwrap();
        f.wait_line(&record.id, "__PG_READY__").await;
        f.invoke_as(caller, args).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(f._directory.path().join("pg-once.txt")).unwrap(),
            "x"
        );
        let catalog = f
            .manager
            .list(&TerminalSessionFilter {
                session_id: record.session_id.clone(),
                context_id: record.context_id.clone(),
                principal_id: record.principal_id.clone(),
                root_ids: Some(vec![record.root_turn_id.clone()]),
                limit: 1,
            })
            .await
            .unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].id, record.id);
        let mut foreign = catalog[0].clone();
        foreign.principal_id = "foreign".into();
        assert!(!f
            .store
            .compare_terminal(foreign.revision, &foreign)
            .await
            .unwrap());
        let live = f
            .manager
            .live
            .lock()
            .unwrap()
            .get(&record.id)
            .unwrap()
            .clone();
        f.manager.checkpoint(&record.id, &live).await.unwrap();
        assert!(f
            .store
            .terminal_checkpoint(&record.id)
            .await
            .unwrap()
            .unwrap()
            .contains("__PG_READY__"));
        let revision = f
            .store
            .terminal(&record.id)
            .await
            .unwrap()
            .unwrap()
            .revision;
        f.invoke(json!({"action":"close","terminal_id":record.id,"expected_revision":revision}))
            .await
            .unwrap();
        assert_eq!(
            f.store.terminal(&record.id).await.unwrap().unwrap().status,
            TerminalStatus::Closed
        );
    }
}
