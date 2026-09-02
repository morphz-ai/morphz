//! Full-screen terminal frontend for Morphz.
//!
//! The TUI consumes the same Runtime event stream as the classic CLI. Model
//! deltas are deliberately transient presentation state; only durable Runtime
//! facts such as user messages, tool receipts and terminal responses enter the transcript.

mod markdown;
mod shell;

use crate::approval::ApprovalDecision;
use crate::config::TuiTheme;
use crate::event::Event as RuntimeEvent;
use crate::i18n::Locale;
use crate::llm::{ModelStreamEvent, ReasoningEffort};
use crate::memory::{
    DelegationRecord, DelegationStatus, MessageDispatchMode, ObjectiveRecord, ObjectiveStatus,
    ObjectiveWaitCondition, SessionRecord, SessionStatus, SessionUpdate,
};
use crate::orchestrator::context::ContextView;
use crate::permission::{PermissionMode, SandboxMode};
use crate::runtime::{InferenceModelOption, MorphzRuntime, RuntimeError, SessionHandle};
use crate::sdk::{MorphzSdk, SendMessageCommand};
use crate::sexpr::SExpr;
use crate::sexpr_vm_contract::{MORPHZ_MACHINE_NAME_EN, MORPHZ_MACHINE_NAME_ZH};
use crate::tool::{get_tasks_map, BackgroundTaskStatus};
use chrono::Utc;
use crossterm::cursor::Show;
use crossterm::event::{
    poll as poll_input_event, read as read_input_event, DisableBracketedPaste,
    EnableBracketedPaste, Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, supports_keyboard_enhancement, EnterAlternateScreen,
    LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::io::{self, Stdout};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

type TuiError = Box<dyn std::error::Error + Send + Sync>;

const USER_MESSAGE_PREFIX: &str = "❨ᴍ❩ ";
const COMPOSER_PREFIX: &str = "❯ ";
const THEME_COLOR_MORPH_TICKS: usize = 8;
const COGNITIVE_PULSE_TICKS_PER_FRAME: usize = 2;
const COGNITIVE_PULSE_FRAMES: [&str; 14] = [
    "·", "·", "∙", "∙", "•", "•", "●", "●", "●", "•", "•", "∙", "∙", "·",
];
const REASONING_PREVIEW_LINES: usize = 2;
const TUI_RECENT_EVENT_ID_CAPACITY: usize = 16_384;
const MORPHZ_WORDMARK: [&str; 6] = [
    r"███╗   ███╗ ██████╗ ██████╗ ██████╗ ██╗  ██╗ ███████╗",
    r"████╗ ████║██╔═══██╗██╔══██╗██╔══██╗██║  ██║ ╚══███╔╝",
    r"██╔████╔██║██║   ██║██████╔╝██████╔╝███████║   ███╔╝",
    r"██║╚██╔╝██║██║   ██║██╔══██╗██╔═══╝ ██╔══██║  ███╔╝",
    r"██║ ╚═╝ ██║╚██████╔╝██║  ██║██║     ██║  ██║ ███████╗",
    r"╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝ ╚══════╝",
];
const MORPHZ_COMPACT_WORDMARK: [&str; 6] = [
    r" __  __                  _",
    r"|  \/  | ___  _ __ _ __ | |__  ____",
    r"| |\/| |/ _ \| '__| '_ \| '_ \|_  /",
    r"| |  | | (_) | |  | |_) | | | |/ /_",
    r"|_|  |_|\___/|_|  | .__/|_| |_/____|",
    r"                  |_|",
];
const MORPHZ_WORDMARK_SLANT: [usize; 6] = [2, 2, 1, 1, 0, 0];

fn interpolate_color(start: Color, end: Color, step: usize, last_step: usize) -> Color {
    let (Color::Rgb(start_r, start_g, start_b), Color::Rgb(end_r, end_g, end_b)) = (start, end)
    else {
        return start;
    };
    if last_step == 0 {
        return start;
    }
    let mix = |from: u8, to: u8| {
        let from = i32::from(from);
        let delta = i32::from(to) - from;
        (from + delta * step as i32 / last_step as i32) as u8
    };
    Color::Rgb(
        mix(start_r, end_r),
        mix(start_g, end_g),
        mix(start_b, end_b),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalAppearance {
    Light,
    Dark,
}

fn parse_appearance_hint(value: &str) -> Option<TerminalAppearance> {
    match value.trim().to_ascii_lowercase().as_str() {
        "light" | "day" => Some(TerminalAppearance::Light),
        "dark" | "night" => Some(TerminalAppearance::Dark),
        _ => None,
    }
}

fn appearance_from_colorfgbg(value: &str) -> Option<TerminalAppearance> {
    let background = value.rsplit([';', ':']).next()?.trim().parse::<u8>().ok()?;
    match background {
        // COLORFGBG normally uses the ANSI 16-color palette. Black through
        // cyan and bright-black are conventionally dark backgrounds.
        0..=6 | 8 => Some(TerminalAppearance::Dark),
        7 | 9..=15 => Some(TerminalAppearance::Light),
        _ => None,
    }
}

#[cfg(any(unix, test))]
fn appearance_from_background_response(response: &[u8]) -> Option<TerminalAppearance> {
    let response = String::from_utf8_lossy(response);
    let payload = response.rsplit_once("]11;")?.1;
    let payload = payload
        .split(['\u{7}', '\u{1b}'])
        .next()?
        .strip_prefix("rgb:")?;
    let mut components = payload.split('/').map(parse_terminal_rgb_component);
    let red = components.next()??;
    let green = components.next()??;
    let blue = components.next()??;
    let luminance = 299 * u32::from(red) + 587 * u32::from(green) + 114 * u32::from(blue);
    Some(if luminance >= 128_000 {
        TerminalAppearance::Light
    } else {
        TerminalAppearance::Dark
    })
}

#[cfg(any(unix, test))]
fn parse_terminal_rgb_component(component: &str) -> Option<u8> {
    if component.is_empty() || component.len() > 4 {
        return None;
    }
    let value = u32::from_str_radix(component, 16).ok()?;
    let maximum = (1_u32 << (component.len() * 4)) - 1;
    Some(((value * 255 + maximum / 2) / maximum) as u8)
}

#[cfg(unix)]
fn query_terminal_appearance() -> Option<TerminalAppearance> {
    use nix::poll::{poll, PollFd, PollFlags};
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::fd::AsFd;
    use std::time::{Duration, Instant};

    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .ok()?;
    tty.write_all(b"\x1b]11;?\x07").ok()?;
    tty.flush().ok()?;

    let deadline = Instant::now() + Duration::from_millis(250);
    let mut response = Vec::with_capacity(96);
    while Instant::now() < deadline && response.len() < 512 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout_ms = remaining.as_millis().clamp(1, u128::from(u16::MAX)) as u16;
        let readable = {
            let mut descriptors = [PollFd::new(tty.as_fd(), PollFlags::POLLIN)];
            poll(&mut descriptors, timeout_ms).ok()? > 0
                && descriptors[0]
                    .revents()
                    .is_some_and(|events| events.contains(PollFlags::POLLIN))
        };
        if !readable {
            break;
        }
        let mut chunk = [0_u8; 128];
        let count = tty.read(&mut chunk).ok()?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..count]);
        if response.contains(&b'\x07') || response.windows(2).any(|window| window == b"\x1b\\") {
            break;
        }
    }
    appearance_from_background_response(&response)
}

#[cfg(not(unix))]
fn query_terminal_appearance() -> Option<TerminalAppearance> {
    None
}

fn drain_terminal_probe_events() {
    for _ in 0..512 {
        match poll_input_event(std::time::Duration::ZERO) {
            Ok(true) => {
                if read_input_event().is_err() {
                    break;
                }
            }
            _ => break,
        }
    }
}

fn detect_terminal_appearance() -> TerminalAppearance {
    std::env::var("MORPHZ_TUI_APPEARANCE")
        .ok()
        .as_deref()
        .and_then(parse_appearance_hint)
        .or_else(|| {
            std::env::var("COLORFGBG")
                .ok()
                .as_deref()
                .and_then(appearance_from_colorfgbg)
        })
        .or_else(system_appearance)
        .unwrap_or(TerminalAppearance::Dark)
}

#[cfg(target_os = "macos")]
fn system_appearance() -> Option<TerminalAppearance> {
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .ok()?;
    if output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .eq_ignore_ascii_case("dark")
    {
        Some(TerminalAppearance::Dark)
    } else {
        // On macOS the key is absent while Light appearance is active.
        Some(TerminalAppearance::Light)
    }
}

#[cfg(not(target_os = "macos"))]
fn system_appearance() -> Option<TerminalAppearance> {
    None
}

/// Semantic colors for the terminal UI. Components consume roles instead of
/// choosing their own accents, which keeps the interface coherent as it grows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Theme {
    border_subtle: Color,
    border_strong: Color,
    text_primary: Color,
    text_secondary: Color,
    text_muted: Color,
    brand: Color,
    motion_palette: [Color; 3],
    wordmark_start: Color,
    wordmark_end: Color,
    focus: Color,
    user: Color,
    tool: Color,
    success: Color,
    warning: Color,
    error: Color,
}

impl Theme {
    fn for_appearance(kind: TuiTheme, appearance: TerminalAppearance) -> Self {
        let terminal_native = Self {
            // Named ANSI colors are resolved by the user's terminal theme.
            // Morphz deliberately never paints a background.
            border_subtle: Color::DarkGray,
            border_strong: Color::Gray,
            text_primary: Color::Reset,
            text_secondary: Color::Reset,
            text_muted: Color::DarkGray,
            brand: Color::Reset,
            motion_palette: [Color::Magenta, Color::Cyan, Color::Red],
            wordmark_start: Color::Reset,
            wordmark_end: Color::Reset,
            focus: Color::Reset,
            user: Color::Reset,
            tool: Color::Cyan,
            success: Color::Green,
            warning: Color::Yellow,
            error: Color::Red,
        };
        // Text uses the terminal's default foreground so it remains readable
        // even when a terminal theme differs from the OS appearance. The
        // remaining semantic tokens mirror the Dashboard's dark palette and
        // a contrast-correct light counterpart.
        let dashboard = match appearance {
            TerminalAppearance::Dark => Self {
                border_subtle: Color::Rgb(42, 46, 61),
                border_strong: Color::Rgb(58, 64, 85),
                text_primary: Color::Reset,
                text_secondary: Color::Rgb(200, 198, 208),
                text_muted: Color::Rgb(154, 158, 176),
                brand: Color::Rgb(165, 140, 255),
                motion_palette: [
                    Color::Rgb(165, 140, 255),
                    Color::Rgb(86, 208, 222),
                    Color::Rgb(240, 138, 126),
                ],
                wordmark_start: Color::Rgb(124, 91, 240),
                wordmark_end: Color::Rgb(220, 210, 255),
                focus: Color::Rgb(165, 140, 255),
                user: Color::Rgb(212, 200, 255),
                tool: Color::Rgb(106, 212, 223),
                success: Color::Rgb(92, 224, 153),
                warning: Color::Rgb(240, 193, 100),
                error: Color::Rgb(255, 138, 146),
            },
            TerminalAppearance::Light => Self {
                border_subtle: Color::Rgb(213, 211, 220),
                border_strong: Color::Rgb(166, 162, 177),
                text_primary: Color::Reset,
                text_secondary: Color::Rgb(75, 72, 84),
                text_muted: Color::Rgb(108, 104, 119),
                brand: Color::Rgb(103, 72, 194),
                motion_palette: [
                    Color::Rgb(103, 72, 194),
                    Color::Rgb(8, 124, 138),
                    Color::Rgb(184, 71, 61),
                ],
                wordmark_start: Color::Rgb(63, 28, 151),
                wordmark_end: Color::Rgb(118, 79, 198),
                focus: Color::Rgb(103, 72, 194),
                user: Color::Rgb(84, 54, 166),
                tool: Color::Rgb(8, 124, 138),
                success: Color::Rgb(24, 121, 78),
                warning: Color::Rgb(143, 95, 0),
                error: Color::Rgb(196, 51, 63),
            },
        };
        match kind {
            // "system" intentionally resolves to the conservative terminal-
            // native palette. It remains stable across light/dark themes.
            TuiTheme::System => terminal_native,
            TuiTheme::Iris => dashboard,
            TuiTheme::Cyan => match appearance {
                TerminalAppearance::Dark => Self {
                    brand: Color::Rgb(86, 208, 222),
                    motion_palette: [
                        Color::Rgb(86, 208, 222),
                        Color::Rgb(240, 138, 126),
                        Color::Rgb(165, 140, 255),
                    ],
                    wordmark_start: Color::Rgb(38, 180, 199),
                    wordmark_end: Color::Rgb(185, 246, 250),
                    focus: Color::Rgb(86, 208, 222),
                    user: Color::Rgb(168, 238, 245),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(8, 124, 138),
                    motion_palette: [
                        Color::Rgb(8, 124, 138),
                        Color::Rgb(184, 71, 61),
                        Color::Rgb(103, 72, 194),
                    ],
                    wordmark_start: Color::Rgb(0, 74, 84),
                    wordmark_end: Color::Rgb(8, 124, 138),
                    focus: Color::Rgb(8, 124, 138),
                    user: Color::Rgb(0, 101, 113),
                    ..dashboard
                },
            },
            TuiTheme::Coral => match appearance {
                TerminalAppearance::Dark => Self {
                    brand: Color::Rgb(240, 138, 126),
                    motion_palette: [
                        Color::Rgb(240, 138, 126),
                        Color::Rgb(165, 140, 255),
                        Color::Rgb(86, 208, 222),
                    ],
                    wordmark_start: Color::Rgb(220, 93, 82),
                    wordmark_end: Color::Rgb(255, 211, 205),
                    focus: Color::Rgb(240, 138, 126),
                    user: Color::Rgb(255, 196, 189),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(184, 71, 61),
                    motion_palette: [
                        Color::Rgb(184, 71, 61),
                        Color::Rgb(103, 72, 194),
                        Color::Rgb(8, 124, 138),
                    ],
                    wordmark_start: Color::Rgb(126, 37, 31),
                    wordmark_end: Color::Rgb(184, 71, 61),
                    focus: Color::Rgb(184, 71, 61),
                    user: Color::Rgb(153, 51, 44),
                    ..dashboard
                },
            },
            TuiTheme::Mono => match appearance {
                TerminalAppearance::Dark => Self {
                    brand: Color::Rgb(210, 211, 218),
                    motion_palette: [
                        Color::Rgb(210, 211, 218),
                        Color::Rgb(255, 255, 255),
                        Color::Rgb(156, 159, 170),
                    ],
                    wordmark_start: Color::Rgb(156, 159, 170),
                    wordmark_end: Color::Rgb(255, 255, 255),
                    focus: Color::Rgb(210, 211, 218),
                    user: Color::Rgb(255, 255, 255),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(57, 55, 64),
                    motion_palette: [
                        Color::Rgb(57, 55, 64),
                        Color::Rgb(35, 33, 40),
                        Color::Rgb(108, 104, 119),
                    ],
                    wordmark_start: Color::Rgb(35, 33, 40),
                    wordmark_end: Color::Rgb(93, 89, 101),
                    focus: Color::Rgb(57, 55, 64),
                    user: Color::Rgb(35, 33, 40),
                    ..dashboard
                },
            },
            TuiTheme::NoColor => Self {
                border_subtle: Color::Reset,
                border_strong: Color::Reset,
                text_muted: Color::Reset,
                motion_palette: [Color::Reset; 3],
                tool: Color::Reset,
                success: Color::Reset,
                warning: Color::Reset,
                error: Color::Reset,
                ..terminal_native
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    User,
    Reasoning,
    Assistant,
    Coordination,
    Progress,
    Tool,
    System,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiView {
    Conversation,
    Tasks,
    Mind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiFocus {
    Content,
    Composer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ControlAction {
    ShowHelp,
    ShowConversation,
    ShowTasks,
    ShowMind,
    ShowSessions,
    ShowObjectives,
    ShowTools,
    ShowExecutionJobs,
    ShowDelegations,
    InspectContext,
    OpenShell,
    SetToolDetails(bool),
    SetReasoningDetails(bool),
    CycleTheme,
    SetTheme(TuiTheme),
    SetModel(String),
    SetReasoningEffort(Option<ReasoningEffort>),
    SetPermissionMode(PermissionMode),
    CancelEvaluation,
    ClearView,
    Quit,
}

#[derive(Debug, Clone)]
struct ControlItem {
    action: ControlAction,
    command: String,
    label: String,
    description: String,
    shortcut: Option<&'static str>,
    enabled: bool,
    disabled_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct InfoPanel {
    title: String,
    body: String,
    formatted_sexpr: bool,
}

impl ControlItem {
    fn new(
        action: ControlAction,
        command: impl Into<String>,
        label: impl Into<String>,
        description: impl Into<String>,
        shortcut: Option<&'static str>,
    ) -> Self {
        Self {
            action,
            command: command.into(),
            label: label.into(),
            description: description.into(),
            shortcut,
            enabled: true,
            disabled_reason: None,
        }
    }

    fn enabled_if(mut self, enabled: bool, disabled_reason: impl Into<String>) -> Self {
        self.enabled = enabled;
        if !enabled {
            self.disabled_reason = Some(disabled_reason.into());
        }
        self
    }

    fn searchable_text(&self) -> String {
        format!("{} {} {}", self.command, self.label, self.description).to_lowercase()
    }
}

fn control_item_matches(item: &ControlItem, query: &str) -> bool {
    let searchable = item.searchable_text();
    query
        .to_lowercase()
        .split_whitespace()
        .all(|term| searchable.contains(term) || is_subsequence(term, &searchable))
}

fn control_match_rank(item: &ControlItem, query: &str) -> u8 {
    let query = query.to_lowercase();
    let command = item.command.to_lowercase();
    let label = item.label.to_lowercase();
    if command == query || label == query {
        0
    } else if command.starts_with(&query) || label.starts_with(&query) {
        1
    } else if command.contains(&query) || label.contains(&query) {
        2
    } else {
        3
    }
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut chars = needle.chars();
    let mut next = chars.next();
    for character in haystack.chars() {
        if next == Some(character) {
            next = chars.next();
            if next.is_none() {
                return true;
            }
        }
    }
    next.is_none()
}

#[derive(Debug, Clone)]
struct TranscriptEntry {
    kind: EntryKind,
    body: String,
    detail: Option<String>,
    source_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct LiveToolCall {
    name: String,
    arguments: String,
    completed: bool,
}

#[derive(Debug, Clone)]
struct LiveAttempt {
    activation_id: String,
    thread_kind: String,
    reasoning_summary: String,
    text: String,
    tools: BTreeMap<usize, LiveToolCall>,
    reasoning_summary_persisted: bool,
}

impl LiveAttempt {
    fn new(activation_id: String, thread_kind: String) -> Self {
        Self {
            activation_id,
            thread_kind,
            reasoning_summary: String::new(),
            text: String::new(),
            tools: BTreeMap::new(),
            reasoning_summary_persisted: false,
        }
    }

    fn is_conversation(&self) -> bool {
        is_conversation_thread_kind(&self.thread_kind)
    }
}

fn is_conversation_thread_kind(thread_kind: &str) -> bool {
    matches!(thread_kind, "dialogue_turn" | "delivery")
}

#[derive(Debug)]
struct Composer {
    chars: Vec<char>,
    cursor: usize,
}

impl Composer {
    fn new() -> Self {
        Self {
            chars: Vec::new(),
            cursor: 0,
        }
    }

    fn text(&self) -> String {
        self.chars.iter().collect()
    }

    fn insert(&mut self, value: char) {
        self.chars.insert(self.cursor, value);
        self.cursor += 1;
    }

    fn insert_str(&mut self, value: &str) {
        for character in value.chars() {
            self.insert(character);
        }
    }

    fn backspace(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
            self.chars.remove(self.cursor);
        }
    }

    fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    fn take_trimmed(&mut self) -> String {
        let value = self.text().trim().to_string();
        self.chars.clear();
        self.cursor = 0;
        value
    }

    fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    fn row_col(&self) -> (usize, usize) {
        let mut row = 0;
        let mut column = 0;
        for character in self.chars.iter().take(self.cursor) {
            if *character == '\n' {
                row += 1;
                column = 0;
            } else {
                column += character.width().unwrap_or(0);
            }
        }
        (row, column)
    }
}

#[derive(Debug)]
struct PendingApproval {
    id: String,
    text: String,
}

#[derive(Debug)]
struct UiState {
    locale: Locale,
    agent_id: String,
    context_id: String,
    session_id: String,
    session_title: Option<String>,
    model: String,
    permission_mode: PermissionMode,
    working_directory: String,
    entries: Vec<TranscriptEntry>,
    composer: Composer,
    live_attempts: BTreeMap<String, LiveAttempt>,
    status: String,
    context_status: String,
    objectives: Vec<ObjectiveRecord>,
    context_view: Option<ContextView>,
    delegations: Vec<DelegationRecord>,
    sessions: Vec<SessionRecord>,
    session_selection: usize,
    session_drafts: BTreeMap<String, String>,
    model_options: Vec<InferenceModelOption>,
    tool_names: Vec<String>,
    active_view: UiView,
    focus: UiFocus,
    selected_objective_id: Option<String>,
    selected_frame_id: Option<String>,
    view_scroll: u16,
    busy: bool,
    follow_tail: bool,
    scroll: u16,
    max_scroll: u16,
    spinner: usize,
    pending_approval: Option<PendingApproval>,
    show_help: bool,
    show_tool_details: bool,
    show_reasoning_details: bool,
    show_task_diagnostics: bool,
    show_objectives: bool,
    show_sessions: bool,
    show_control: bool,
    control_input: Composer,
    control_selection: usize,
    control_feedback: Option<String>,
    info_panel: Option<InfoPanel>,
    info_scroll: u16,
    objective_scroll: u16,
    cancel_confirmation_armed: bool,
    appearance: TerminalAppearance,
    theme_kind: TuiTheme,
    theme: Theme,
}

impl UiState {
    fn tr(&self, english: &'static str, chinese: &'static str) -> &'static str {
        self.locale.text(english, chinese)
    }

    fn tagline(&self) -> &'static str {
        self.locale
            .text(MORPHZ_MACHINE_NAME_EN, MORPHZ_MACHINE_NAME_ZH)
    }

    fn new(runtime: &MorphzRuntime, session: &SessionHandle) -> Self {
        let configured_theme = runtime.config().tui.theme;
        let theme_kind = if std::env::var_os("NO_COLOR").is_some() {
            TuiTheme::NoColor
        } else {
            configured_theme
        };
        let appearance = detect_terminal_appearance();
        let locale = runtime.config().ui.language.resolve();
        Self {
            locale,
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            session_title: None,
            model: runtime.model(),
            permission_mode: runtime.config().permissions.effective_mode(),
            working_directory: display_working_directory(),
            entries: Vec::new(),
            composer: Composer::new(),
            live_attempts: BTreeMap::new(),
            status: locale.text("ready", "就绪").to_string(),
            context_status: locale.text("Context loading", "上下文正在加载").to_string(),
            objectives: Vec::new(),
            context_view: None,
            delegations: Vec::new(),
            sessions: Vec::new(),
            session_selection: 0,
            session_drafts: BTreeMap::new(),
            model_options: Vec::new(),
            tool_names: runtime.tool_names(),
            active_view: UiView::Conversation,
            focus: UiFocus::Composer,
            selected_objective_id: None,
            selected_frame_id: None,
            view_scroll: 0,
            busy: false,
            follow_tail: true,
            scroll: 0,
            max_scroll: 0,
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_reasoning_details: false,
            show_task_diagnostics: false,
            show_objectives: false,
            show_sessions: false,
            show_control: false,
            control_input: Composer::new(),
            control_selection: 0,
            control_feedback: None,
            info_panel: None,
            info_scroll: 0,
            objective_scroll: 0,
            cancel_confirmation_armed: false,
            appearance,
            theme_kind,
            theme: Theme::for_appearance(theme_kind, appearance),
        }
    }

    fn set_theme(&mut self, theme_kind: TuiTheme) {
        self.theme_kind = theme_kind;
        self.theme = Theme::for_appearance(theme_kind, self.appearance);
    }

    fn set_appearance(&mut self, appearance: TerminalAppearance) {
        self.appearance = appearance;
        self.theme = Theme::for_appearance(self.theme_kind, appearance);
    }

    fn cycle_theme(&mut self) -> TuiTheme {
        let next = self.next_theme();
        self.set_theme(next);
        next
    }

    fn next_theme(&self) -> TuiTheme {
        match self.theme_kind {
            TuiTheme::Cyan => TuiTheme::Iris,
            TuiTheme::Iris => TuiTheme::Coral,
            TuiTheme::Coral => TuiTheme::Mono,
            TuiTheme::Mono => TuiTheme::Cyan,
            TuiTheme::System | TuiTheme::NoColor => TuiTheme::Cyan,
        }
    }

    fn close_nonapproval_overlays(&mut self) {
        self.show_help = false;
        self.show_objectives = false;
        self.show_sessions = false;
        self.show_control = false;
        self.info_panel = None;
    }

    fn open_control(&mut self) {
        self.close_nonapproval_overlays();
        self.show_control = true;
        self.control_input.clear();
        self.control_selection = 0;
        self.control_feedback = None;
    }

    fn close_control(&mut self) {
        self.show_control = false;
        self.control_input.clear();
        self.control_selection = 0;
        self.control_feedback = None;
    }

    fn show_info_panel(&mut self, title: impl Into<String>, body: impl Into<String>) {
        self.close_nonapproval_overlays();
        self.info_panel = Some(InfoPanel {
            title: title.into(),
            body: body.into(),
            formatted_sexpr: false,
        });
        self.info_scroll = 0;
    }

    fn show_sexpr_panel(&mut self, title: impl Into<String>, body: impl Into<String>) {
        self.close_nonapproval_overlays();
        self.info_panel = Some(InfoPanel {
            title: title.into(),
            body: body.into(),
            formatted_sexpr: true,
        });
        self.info_scroll = 0;
    }

    fn control_items(&self) -> Vec<ControlItem> {
        let mut items = vec![
            ControlItem::new(
                ControlAction::ShowHelp,
                "help",
                self.tr("Show keyboard help", "查看键盘帮助"),
                self.tr(
                    "Open the localized shortcut and interaction reference.",
                    "打开本地化的快捷键与交互说明。",
                ),
                Some("?"),
            ),
            ControlItem::new(
                ControlAction::ShowConversation,
                "view conversation",
                self.tr("Open Conversation", "打开对话"),
                self.tr("Return to the conversational input and transcript.", "返回对话输入与消息流。"),
                Some("Esc"),
            ),
            ControlItem::new(
                ControlAction::ShowTasks,
                "view tasks",
                self.tr("Open Tasks", "打开任务"),
                self.tr("Inspect active Objectives and Runtime work.", "查看活跃目标与 Runtime 工作。"),
                Some("Ctrl+T"),
            ),
            ControlItem::new(
                ControlAction::ShowMind,
                "view mind",
                self.tr("Open Mind", "打开认知"),
                self.tr("Inspect selectable Mind Frames and provenance.", "查看可选择的认知帧及其来源。"),
                Some("Ctrl+K"),
            ),
            ControlItem::new(
                ControlAction::ShowSessions,
                "session list",
                self.tr("Switch Session", "切换会话"),
                self.tr("Open the authorized active Session directory.", "打开已授权的活跃会话目录。"),
                Some("Ctrl+G"),
            ),
            ControlItem::new(
                ControlAction::ShowObjectives,
                "objective list",
                self.tr("Inspect Objectives", "查看目标"),
                self.tr("Open the current Context Objective lifecycle view.", "打开当前 Context 的目标生命周期视图。"),
                Some("Ctrl+O"),
            ),
            ControlItem::new(
                ControlAction::ShowTools,
                "tool list",
                self.tr("List available tools", "列出可用工具"),
                self.tr("Show every tool currently exposed by Runtime.", "显示 Runtime 当前暴露的全部工具。"),
                None,
            )
            .enabled_if(
                !self.tool_names.is_empty(),
                self.tr("Runtime currently exposes no tools.", "Runtime 当前没有暴露工具。"),
            ),
            ControlItem::new(
                ControlAction::ShowDelegations,
                "delegation list",
                self.tr("List delegations", "列出委派"),
                self.tr("Show subagent delegations without mixing them with Execution Jobs.", "显示子代理委派，不与 Execution Job 混用。"),
                None,
            ),
            ControlItem::new(
                ControlAction::ShowExecutionJobs,
                "execution job list",
                self.tr("List Execution Jobs", "列出执行任务"),
                self.tr(
                    "Show Runtime-managed background process jobs for the current Context.",
                    "显示当前 Context 中由 Runtime 托管的后台进程任务。",
                ),
                None,
            ),
            ControlItem::new(
                ControlAction::InspectContext,
                "context inspect",
                self.tr("Inspect Context", "检查 Context"),
                self.tr("Open the formatted current Context encoding outside the dialogue stream.", "在对话流之外打开格式化的当前 Context 编码。"),
                None,
            ),
            ControlItem::new(
                ControlAction::OpenShell,
                "shell open",
                self.tr("Open embedded Shell", "打开内嵌终端"),
                self.tr("Enter the persistent PTY. Ctrl+] returns to Morphz.", "进入持久 PTY；按 Ctrl+] 返回 Morphz。"),
                None,
            ),
            ControlItem::new(
                ControlAction::SetToolDetails(!self.show_tool_details),
                if self.show_tool_details {
                    "tool details off"
                } else {
                    "tool details on"
                },
                if self.show_tool_details {
                    self.tr("Hide raw tool details", "收起工具原始详情")
                } else {
                    self.tr("Show raw tool details", "展开工具原始详情")
                },
                self.tr("Change presentation only; no dialogue Event is created.", "仅改变显示，不创建对话 Event。"),
                None,
            ),
            ControlItem::new(
                ControlAction::SetReasoningDetails(!self.show_reasoning_details),
                if self.show_reasoning_details {
                    "reasoning details off"
                } else {
                    "reasoning details on"
                },
                if self.show_reasoning_details {
                    self.tr("Hide reasoning summaries", "收起推理摘要")
                } else {
                    self.tr("Show reasoning summaries", "展开推理摘要")
                },
                self.tr("Change presentation only; no dialogue Event is created.", "仅改变显示，不创建对话 Event。"),
                Some("Ctrl+R"),
            ),
            ControlItem::new(
                ControlAction::CancelEvaluation,
                "runtime cancel",
                self.tr("Cancel current evaluation", "取消当前求值"),
                self.tr("Cancel only the active Session evaluation; background work keeps its lifecycle.", "只取消当前 Session 求值；后台工作保持自身生命周期。"),
                Some("Ctrl+C"),
            )
            .enabled_if(
                self.busy,
                self.tr("There is no active evaluation to cancel.", "当前没有可取消的求值。"),
            ),
            ControlItem::new(
                ControlAction::ClearView,
                "view clear",
                self.tr("Clear local transcript view", "清空本地对话显示"),
                self.tr("Clear transient presentation only; durable Session history is unchanged.", "只清空临时显示；持久化 Session 历史不变。"),
                None,
            ),
            ControlItem::new(
                ControlAction::Quit,
                "app quit",
                self.tr("Quit Morphz TUI", "退出 Morphz TUI"),
                self.tr("Leave the terminal client without cancelling durable background work.", "退出终端客户端，不取消持久后台工作。"),
                Some("Ctrl+D"),
            ),
            ControlItem::new(
                ControlAction::CycleTheme,
                "theme cycle",
                self.tr("Cycle terminal theme", "循环切换终端主题"),
                self.tr(
                    "Advance to the next terminal theme without creating a dialogue Event.",
                    "切换到下一个终端主题，不创建对话 Event。",
                ),
                Some("Alt+T"),
            ),
        ];

        for theme in [
            TuiTheme::System,
            TuiTheme::Cyan,
            TuiTheme::Iris,
            TuiTheme::Coral,
            TuiTheme::Mono,
            TuiTheme::NoColor,
        ] {
            items.push(ControlItem::new(
                ControlAction::SetTheme(theme),
                format!("theme set {}", theme.as_str()),
                if self.locale.is_chinese() {
                    format!("切换主题 · {}", theme.as_str())
                } else {
                    format!("Set theme · {}", theme.as_str())
                },
                if theme == self.theme_kind {
                    self.tr("Current terminal theme.", "当前终端主题。")
                } else {
                    self.tr(
                        "Apply this theme for the current terminal session.",
                        "为当前终端会话应用此主题。",
                    )
                },
                None,
            ));
        }

        if self.model_options.is_empty() {
            items.push(
                ControlItem::new(
                    ControlAction::SetModel(String::new()),
                    "model select",
                    self.tr("Select model", "选择模型"),
                    self.tr(
                        "Select an enabled inference model route.",
                        "选择已启用的推理模型路由。",
                    ),
                    None,
                )
                .enabled_if(
                    false,
                    self.tr(
                        "No enabled model is currently available.",
                        "当前没有已启用的可用模型。",
                    ),
                ),
            );
        } else {
            for option in &self.model_options {
                items.push(ControlItem::new(
                    ControlAction::SetModel(option.id.clone()),
                    format!("model select {}", option.id),
                    if self.locale.is_chinese() {
                        format!("选择模型 · {}", option.label)
                    } else {
                        format!("Select model · {}", option.label)
                    },
                    if option.id == self.model {
                        self.tr("Current model route.", "当前模型路由。")
                    } else {
                        self.tr(
                            "Bind this model route to subsequent evaluations in the current Session.",
                            "当前会话的后续求值使用此模型路由。",
                        )
                    },
                    None,
                ));
            }
        }

        items.push(ControlItem::new(
            ControlAction::SetReasoningEffort(None),
            "reasoning effort default",
            self.tr("Use provider-default reasoning", "使用服务默认推理强度"),
            self.tr(
                "Omit the reasoning field and preserve the provider default.",
                "省略推理字段并保留服务默认值。",
            ),
            None,
        ));
        for permission_mode in [
            PermissionMode::AutoReview,
            PermissionMode::RequestApproval,
            PermissionMode::FullAccess,
        ] {
            let (label_en, label_zh, description_en, description_zh) = match permission_mode {
                PermissionMode::AutoReview => (
                    "Permissions · Auto Approval",
                    "权限 · 自动审批",
                    "Use the native Workspace sandbox and automatically review requests for capabilities outside it.",
                    "使用原生工作区沙箱，并自动评审超出边界的能力请求。",
                ),
                PermissionMode::RequestApproval => (
                    "Permissions · Request Approval",
                    "权限 · 请求审批",
                    "Use the native Workspace sandbox and ask you before granting capabilities outside it.",
                    "使用原生工作区沙箱，并在授予超出边界的能力前请求人工审批。",
                ),
                PermissionMode::FullAccess => (
                    "Permissions · Full Access",
                    "权限 · 完全访问",
                    "Allow subsequent tool work beyond Workspace and operating-system sandbox boundaries without approval.",
                    "允许随后开始的工具工作无需审批即可越过工作区和操作系统沙箱边界。",
                ),
                PermissionMode::Custom => unreachable!("custom is not a Session permission preset"),
            };
            items.push(ControlItem::new(
                ControlAction::SetPermissionMode(permission_mode),
                format!("permissions set {}", permission_mode.as_str()),
                self.tr(label_en, label_zh),
                if permission_mode == self.permission_mode {
                    self.tr("Current Session permission preset.", "当前会话的权限预设。")
                } else {
                    self.tr(description_en, description_zh)
                },
                Some("Alt+S"),
            ));
        }
        let supported_efforts = self
            .model_options
            .iter()
            .find(|option| option.id == self.model)
            .and_then(|option| option.supported_reasoning_efforts.as_ref());
        for effort in [
            ReasoningEffort::Off,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Max,
        ] {
            let native = supported_efforts
                .is_none_or(|supported| supported.iter().any(|value| value == effort.as_str()));
            items.push(
                ControlItem::new(
                    ControlAction::SetReasoningEffort(Some(effort)),
                    format!("reasoning effort {}", effort.as_str()),
                    if self.locale.is_chinese() {
                        format!("设置推理强度 · {}", effort.as_str())
                    } else {
                        format!("Set reasoning effort · {}", effort.as_str())
                    },
                    self.tr(
                        "Apply this native effort to subsequent evaluations.",
                        "后续求值使用此原生推理强度。",
                    ),
                    None,
                )
                .enabled_if(
                    native,
                    self.tr(
                        "The selected model does not expose this native effort.",
                        "当前模型不提供这一原生推理强度。",
                    ),
                ),
            );
        }
        items
    }

    fn filtered_control_items(&self) -> Vec<ControlItem> {
        let query = self.control_input.text();
        let query = query.trim();
        let mut items = self.control_items();
        if query.is_empty() {
            return items;
        }
        items.retain(|item| control_item_matches(item, query));
        items.sort_by_key(|item| control_match_rank(item, query));
        items
    }

    fn reconcile_control_selection(&mut self) {
        let len = self.filtered_control_items().len();
        self.control_selection = self.control_selection.min(len.saturating_sub(1));
    }

    fn set_active_view(&mut self, active_view: UiView) {
        self.active_view = active_view;
        self.focus = if active_view == UiView::Conversation {
            UiFocus::Composer
        } else {
            UiFocus::Content
        };
        self.view_scroll = 0;
    }

    fn toggle_secondary_focus(&mut self) {
        if self.active_view == UiView::Conversation {
            self.focus = UiFocus::Composer;
        } else {
            self.focus = match self.focus {
                UiFocus::Content => UiFocus::Composer,
                UiFocus::Composer => UiFocus::Content,
            };
        }
    }

    fn set_sessions(&mut self, mut sessions: Vec<SessionRecord>) {
        sessions.retain(|session| session.status == SessionStatus::Active);
        sessions.sort_by(|left, right| {
            right
                .last_activity_at
                .cmp(&left.last_activity_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        let selected_id = self
            .sessions
            .get(self.session_selection)
            .map(|session| session.id.clone())
            .unwrap_or_else(|| self.session_id.clone());
        self.session_selection = sessions
            .iter()
            .position(|session| session.id == selected_id)
            .or_else(|| {
                sessions
                    .iter()
                    .position(|session| session.id == self.session_id)
            })
            .unwrap_or_default();
        self.sessions = sessions;
    }

    fn selected_session_id(&self) -> Option<&str> {
        self.sessions
            .get(self.session_selection)
            .map(|session| session.id.as_str())
    }

    fn move_session_selection(&mut self, amount: isize) {
        self.session_selection =
            move_selection(self.session_selection, self.sessions.len(), amount);
    }

    fn reconcile_content_selections(&mut self) {
        let active_objective_ids = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .map(|objective| objective.id.as_str())
            .collect::<Vec<_>>();
        if self
            .selected_objective_id
            .as_deref()
            .is_none_or(|id| !active_objective_ids.contains(&id))
        {
            self.selected_objective_id = active_objective_ids.first().map(|id| (*id).to_string());
        }

        let frame_ids = self
            .context_view
            .as_ref()
            .map(|view| {
                view.state
                    .frames
                    .iter()
                    .map(|frame| frame.id.as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if self
            .selected_frame_id
            .as_deref()
            .is_none_or(|id| !frame_ids.contains(&id))
        {
            self.selected_frame_id = frame_ids.first().map(|id| (*id).to_string());
        }
    }

    fn move_objective_selection(&mut self, amount: isize) {
        let ids = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .map(|objective| objective.id.clone())
            .collect::<Vec<_>>();
        self.selected_objective_id =
            moved_selection_id(self.selected_objective_id.as_deref(), &ids, amount);
    }

    fn move_frame_selection(&mut self, amount: isize) {
        let ids = self
            .context_view
            .as_ref()
            .map(|view| {
                view.state
                    .frames
                    .iter()
                    .map(|frame| frame.id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.selected_frame_id =
            moved_selection_id(self.selected_frame_id.as_deref(), &ids, amount);
    }

    fn select_first_content_item(&mut self) {
        match self.active_view {
            UiView::Tasks => self.move_objective_selection(isize::MIN),
            UiView::Mind => self.move_frame_selection(isize::MIN),
            UiView::Conversation => {}
        }
    }

    fn select_last_content_item(&mut self) {
        match self.active_view {
            UiView::Tasks => self.move_objective_selection(isize::MAX),
            UiView::Mind => self.move_frame_selection(isize::MAX),
            UiView::Conversation => {}
        }
    }

    fn push(&mut self, kind: EntryKind, body: impl Into<String>) {
        let body = body.into();
        if body.trim().is_empty() {
            return;
        }
        self.entries.push(TranscriptEntry {
            kind,
            body,
            detail: None,
            source_id: None,
        });
        if self.entries.len() > 500 {
            self.entries.drain(..100);
        }
    }

    fn push_tool(&mut self, body: impl Into<String>, detail: impl Into<String>) {
        let body = body.into();
        if body.trim().is_empty() {
            return;
        }
        self.entries.push(TranscriptEntry {
            kind: EntryKind::Tool,
            body,
            detail: Some(detail.into()),
            source_id: None,
        });
        if self.entries.len() > 500 {
            self.entries.drain(..100);
        }
    }

    fn begin_request(&mut self, prompt: &str) {
        self.follow_tail = true;
        self.push(EntryKind::User, prompt.to_string());
        self.busy = true;
        self.status = self.tr("queued", "已排队").to_string();
    }

    fn update_context(&mut self, view: &ContextView) {
        self.context_id.clone_from(&view.context_id);
        self.objectives = view.objectives.clone();
        let active_objectives = view
            .objectives
            .iter()
            .filter(|objective| objective.status == ObjectiveStatus::Active)
            .count();
        self.context_status = if self.locale.is_chinese() {
            format!(
                "{} · {}/{} · {} 个认知帧 · {}+{} 个会话 · {} 项求值 · {} 个线程组 · {} 个目标",
                localized_pressure(self.locale, &view.pressure.level),
                compact_count(view.pressure.estimated_tokens),
                compact_count(view.pressure.hard_limit),
                view.pressure.active_frames,
                view.session_working_set.full_session_ids.len(),
                view.session_working_set.metadata_only_session_ids.len(),
                view.active_activations.len(),
                view.thread_groups.len(),
                active_objectives
            )
        } else {
            format!(
                "{} · {}/{} · {} frames · {}+{} sessions · {} evaluations · {} thread groups · {} objectives",
                localized_pressure(self.locale, &view.pressure.level),
                compact_count(view.pressure.estimated_tokens),
                compact_count(view.pressure.hard_limit),
                view.pressure.active_frames,
                view.session_working_set.full_session_ids.len(),
                view.session_working_set.metadata_only_session_ids.len(),
                view.active_activations.len(),
                view.thread_groups.len(),
                active_objectives
            )
        };
        self.context_view = Some(view.clone());
        self.reconcile_content_selections();
    }

    fn clear_live_attempt(&mut self, causal_id: &str) -> bool {
        let previous_len = self.live_attempts.len();
        self.live_attempts.retain(|attempt_id, attempt| {
            attempt_id != causal_id && attempt.activation_id != causal_id
        });
        previous_len != self.live_attempts.len()
    }

    fn refresh_busy_from_live_attempts(&mut self) {
        self.busy = !self.live_attempts.is_empty();
    }

    fn clear_causal_live_attempt(&mut self, event: &RuntimeEvent) -> bool {
        event_causal_id(&event.payload).is_some_and(|causal_id| self.clear_live_attempt(causal_id))
    }

    fn clear_exact_live_attempt(&mut self, event: &RuntimeEvent) -> bool {
        event
            .payload
            .get("attempt_id")
            .and_then(Value::as_str)
            .filter(|attempt_id| !attempt_id.is_empty())
            .is_some_and(|attempt_id| self.live_attempts.remove(attempt_id).is_some())
    }

    fn resolve_live_attempt(&mut self, causal_id: &str) -> bool {
        let matching = self
            .live_attempts
            .iter()
            .filter(|(attempt_id, attempt)| {
                attempt_id.as_str() == causal_id || attempt.activation_id == causal_id
            })
            .map(|(attempt_id, _)| attempt_id.clone())
            .collect::<Vec<_>>();
        for attempt_id in &matching {
            if let Some(attempt) = self.live_attempts.remove(attempt_id) {
                self.upsert_reasoning_summary(
                    attempt_id,
                    &attempt.reasoning_summary,
                    &attempt.thread_kind,
                );
            }
        }
        !matching.is_empty()
    }

    fn resolve_causal_live_attempt(&mut self, event: &RuntimeEvent) -> bool {
        event_causal_id(&event.payload)
            .is_some_and(|causal_id| self.resolve_live_attempt(causal_id))
    }

    fn resolve_exact_live_attempt(&mut self, event: &RuntimeEvent) -> bool {
        event
            .payload
            .get("attempt_id")
            .and_then(Value::as_str)
            .filter(|attempt_id| !attempt_id.is_empty())
            .is_some_and(|attempt_id| self.resolve_live_attempt(attempt_id))
    }

    fn ingest_reasoning_summary(&mut self, event: &RuntimeEvent) {
        let attempt_id = event
            .payload
            .get("attempt_id")
            .and_then(Value::as_str)
            .filter(|attempt_id| !attempt_id.is_empty())
            .unwrap_or(&event.id);
        let text = event
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let thread_kind = event_thread_kind(&event.payload);

        self.upsert_reasoning_summary(attempt_id, text, thread_kind);
        if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
            attempt.reasoning_summary_persisted = true;
        }
    }

    fn upsert_reasoning_summary(&mut self, attempt_id: &str, text: &str, thread_kind: &str) {
        if !is_conversation_thread_kind(thread_kind) || text.trim().is_empty() {
            return;
        }
        if let Some(entry) = self.entries.iter_mut().find(|entry| {
            entry.kind == EntryKind::Reasoning && entry.source_id.as_deref() == Some(attempt_id)
        }) {
            entry.body = text.to_string();
        } else {
            self.entries.push(TranscriptEntry {
                kind: EntryKind::Reasoning,
                body: text.to_string(),
                detail: None,
                source_id: Some(attempt_id.to_string()),
            });
            if self.entries.len() > 500 {
                self.entries.drain(..100);
            }
        }
    }

    fn scroll_transcript_up(&mut self, amount: u16) {
        self.follow_tail = false;
        self.scroll = self.scroll.saturating_sub(amount);
    }

    fn scroll_transcript_down(&mut self, amount: u16) {
        self.scroll = self.scroll.saturating_add(amount).min(self.max_scroll);
        self.follow_tail = self.scroll >= self.max_scroll;
    }

    fn scroll_transcript_to_top(&mut self) {
        self.follow_tail = false;
        self.scroll = 0;
    }

    fn scroll_transcript_to_bottom(&mut self) {
        self.follow_tail = true;
        self.scroll = self.max_scroll;
    }

    fn ingest_history(&mut self, event: &RuntimeEvent) {
        if event.payload.get("session_id").and_then(Value::as_str) != Some(&self.session_id) {
            return;
        }
        let text = event
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event.topic.as_str() {
            "chat/user_message" => self.push(EntryKind::User, text),
            "runtime/model_reasoning_summary" => self.ingest_reasoning_summary(event),
            "chat/reply" | "chat/outbound_message" => self.push(EntryKind::Assistant, text),
            "chat/session_signal" => self.push_session_signal(event),
            "chat/progress" => self.push(EntryKind::Progress, text),
            "runtime/tool_calls_selected" => {
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_activity(&event.payload, self.locale) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
            }
            "chat/tool_output" if event_thread_kind(&event.payload) != "execution" => {
                if let Some(activity) = format_tool_result(&event.payload, self.locale) {
                    self.push_tool(activity.compact, activity.detail);
                }
            }
            _ => {}
        }
    }

    fn on_runtime_event(&mut self, event: RuntimeEvent) {
        if event.payload.get("session_id").and_then(Value::as_str) != Some(&self.session_id) {
            return;
        }
        match event.topic.as_str() {
            "runtime/model_stream" => {
                let Some(attempt_id) = event
                    .payload
                    .get("attempt_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                else {
                    return;
                };
                let activation_id = event
                    .payload
                    .get("activation_id")
                    .and_then(Value::as_str)
                    .unwrap_or(attempt_id);
                let thread_kind = event
                    .payload
                    .get("thread_kind")
                    .and_then(Value::as_str)
                    .unwrap_or("dialogue_turn");
                if let Some(value) = event.payload.get("stream") {
                    if let Ok(stream_event) =
                        serde_json::from_value::<ModelStreamEvent>(value.clone())
                    {
                        self.on_model_stream(attempt_id, activation_id, thread_kind, stream_event);
                    }
                }
            }
            "runtime/tool_calls_selected" => {
                self.resolve_causal_live_attempt(&event);
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_activity(&event.payload, self.locale) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
                self.busy = true;
                self.status = self.tr("running tools", "正在执行工具").to_string();
            }
            "chat/tool_output" => {
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_result(&event.payload, self.locale) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
                self.status = self.tr("processing results", "正在处理结果").to_string();
            }
            "chat/progress" => {
                // The durable progress fact commits the text just streamed by
                // this exact model Attempt. Do not clear by Activation here: a
                // later protocol-retry Attempt may already share that route.
                self.resolve_exact_live_attempt(&event);
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.push(EntryKind::Progress, text);
            }
            "runtime/response_protocol_error" => {
                self.clear_exact_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
                self.status = self
                    .tr("correcting model response", "正在纠正模型响应")
                    .to_string();
            }
            "runtime/response_protocol_fused" => {
                self.clear_exact_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr(
                        "response protocol error · other work continues",
                        "响应协议错误 · 其他工作仍在继续",
                    )
                } else {
                    self.tr("response protocol error", "响应协议错误")
                }
                .to_string();
            }
            "chat/assistant_call"
                if event
                    .payload
                    .get("terminal_outcome")
                    .and_then(Value::as_bool)
                    != Some(true) =>
            {
                self.resolve_exact_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
            }
            "runtime/model_reasoning_summary" => self.ingest_reasoning_summary(&event),
            "chat/reply" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.resolve_causal_live_attempt(&event);
                self.push(EntryKind::Assistant, text);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr("running", "执行中")
                } else {
                    self.tr("ready", "就绪")
                }
                .to_string();
            }
            "chat/outbound_message" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.push(EntryKind::Assistant, text);
            }
            "chat/session_signal" => self.push_session_signal(&event),
            "chat/no_reply" => {
                self.resolve_causal_live_attempt(&event);
                let background = event
                    .payload
                    .get("active_background_tasks")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if background > 0 {
                    self.refresh_busy_from_live_attempts();
                    self.status = if self.busy {
                        if self.locale.is_chinese() {
                            format!("执行中 · {background} 个后台任务")
                        } else {
                            format!("running · {background} background task(s)")
                        }
                    } else if self.locale.is_chinese() {
                        format!("就绪 · {background} 个后台任务")
                    } else {
                        format!("ready · {background} background task(s)")
                    };
                } else {
                    self.refresh_busy_from_live_attempts();
                    self.status = if self.busy {
                        self.tr("running", "执行中").to_string()
                    } else {
                        self.tr("ready · no reply", "就绪 · 无需回复").to_string()
                    };
                }
            }
            "chat/cancelled" => {
                if !self.clear_causal_live_attempt(&event)
                    && event_causal_id(&event.payload).is_none()
                {
                    // The public Session cancellation endpoint deliberately
                    // cancels the whole Session and therefore has no single
                    // causal Activation. In that one case every local draft is
                    // stale; routed cancellation still removes only its own
                    // Attempt.
                    self.live_attempts.clear();
                }
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr("running", "执行中")
                } else {
                    self.tr("cancelled", "已取消")
                }
                .to_string();
            }
            "chat/runtime_error" => {
                self.clear_causal_live_attempt(&event);
                let message = event
                    .payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| self.tr("Runtime error", "运行时错误"));
                self.push(EntryKind::Error, message);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr(
                        "runtime error · other work continues",
                        "运行时错误 · 其他工作仍在继续",
                    )
                } else {
                    self.tr("runtime error", "运行时错误")
                }
                .to_string();
            }
            "runtime/thread_result" => {
                self.resolve_causal_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr("running", "执行中")
                } else {
                    self.tr("ready", "就绪")
                }
                .to_string();
            }
            "runtime/approval_requested" => {
                let id = event
                    .payload
                    .get("approval_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| {
                        self.tr(
                            "This permission request needs your decision",
                            "这项权限请求需要你做出决定",
                        )
                    })
                    .to_string();
                self.pending_approval = Some(PendingApproval { id, text });
                self.status = self.tr("approval required", "等待审批").to_string();
            }
            _ => {}
        }
    }

    fn push_session_signal(&mut self, event: &RuntimeEvent) {
        let text = event
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let source_session_id = event
            .payload
            .get("source_session_id")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        self.push(
            EntryKind::Coordination,
            if self.locale.is_chinese() {
                format!("来自会话 {}\n{}", short_id(source_session_id), text)
            } else {
                format!("from Session {}\n{}", short_id(source_session_id), text)
            },
        );
    }

    fn on_model_stream(
        &mut self,
        attempt_id: &str,
        activation_id: &str,
        thread_kind: &str,
        event: ModelStreamEvent,
    ) {
        match event {
            ModelStreamEvent::Started => {
                self.busy = true;
                self.live_attempts.insert(
                    attempt_id.to_string(),
                    LiveAttempt::new(activation_id.to_string(), thread_kind.to_string()),
                );
                self.status = if thread_kind == "execution" {
                    self.tr("execution evaluating", "执行正在求值")
                } else {
                    self.tr("thinking", "正在思考")
                }
                .to_string();
            }
            ModelStreamEvent::TextDelta { text } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    attempt.text.push_str(&text);
                }
            }
            // This is the provider-authored, presentation-safe summary channel,
            // not hidden chain-of-thought. Deltas drive the live preview; the
            // Runtime later commits one durable model_reasoning_summary fact.
            ModelStreamEvent::ReasoningSummaryDelta { text } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    attempt.reasoning_summary.push_str(&text);
                }
            }
            ModelStreamEvent::ReasoningSummaryCompleted => {
                self.status = self
                    .tr(
                        "reasoning complete · waiting for final output",
                        "推理已完成 · 正在等待最终输出",
                    )
                    .to_string();
            }
            // Consumed inside the Orchestrator before presentation events are
            // broadcast. Keep this defensive arm so a future transport bug
            // still cannot expose opaque reasoning continuation state.
            ModelStreamEvent::ProviderContinuation { .. } => {}
            ModelStreamEvent::ToolCallStarted { index, name, .. } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    attempt.tools.entry(index).or_default().name = name.clone();
                }
                self.status = if name == "no_reply" {
                    self.tr("finishing silently", "正在静默完成").to_string()
                } else if self.locale.is_chinese() {
                    format!("正在准备 {name}")
                } else {
                    format!("preparing {name}")
                };
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    attempt
                        .tools
                        .entry(index)
                        .or_default()
                        .arguments
                        .push_str(&delta);
                }
            }
            ModelStreamEvent::ToolCallCompleted { index } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    if let Some(tool) = attempt.tools.get_mut(&index) {
                        tool.completed = true;
                    }
                }
            }
            ModelStreamEvent::Usage { .. } => {}
            ModelStreamEvent::Incomplete { .. } => {
                self.status = self
                    .tr("continuing model response", "正在续接模型响应")
                    .to_string();
            }
            ModelStreamEvent::Completed => {
                self.status = self.tr("processing response", "正在处理响应").to_string();
            }
            ModelStreamEvent::Failed { message } => {
                self.live_attempts.remove(attempt_id);
                self.push(EntryKind::Error, message);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    self.tr(
                        "model error · other work continues",
                        "模型错误 · 其他工作仍在继续",
                    )
                } else {
                    self.tr("model error", "模型错误")
                }
                .to_string();
            }
        }
    }

    fn render(&mut self, frame: &mut Frame<'_>) {
        self.render_with_composer_cursor(frame, true);
    }

    fn render_with_composer_cursor(&mut self, frame: &mut Frame<'_>, show_cursor: bool) {
        let size = frame.area();
        frame.render_widget(Block::default(), size);
        let input_lines = self.composer.text().split('\n').count().clamp(1, 5) as u16;
        if self.active_view == UiView::Conversation {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Min(3),
                    Constraint::Length(input_lines + 2),
                    Constraint::Length(1),
                ])
                .split(size);
            self.render_transcript(frame, chunks[0]);
            self.render_composer(frame, chunks[1], show_cursor);
            self.render_footer(frame, chunks[2]);
        } else {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Min(4),
                    Constraint::Length(input_lines + 2),
                    Constraint::Length(1),
                ])
                .split(size);
            match self.active_view {
                UiView::Tasks => self.render_tasks_view(frame, chunks[0]),
                UiView::Mind => self.render_mind_view(frame, chunks[0]),
                UiView::Conversation => unreachable!(),
            }
            self.render_composer(frame, chunks[1], show_cursor);
            self.render_footer(frame, chunks[2]);
        }
        if self.show_help {
            self.render_help(frame, centered_rect(88, 96, size));
        }
        if self.show_objectives {
            self.render_objectives(frame, centered_rect(84, 78, size));
        }
        if self.show_sessions {
            self.render_sessions(frame, centered_rect(88, 82, size));
        }
        if self.info_panel.is_some() {
            self.render_info_panel(frame, centered_rect(88, 84, size));
        }
        if self.show_control {
            self.render_control(frame, centered_rect(88, 82, size));
        }
        if self.pending_approval.is_some() {
            self.render_approval(frame, centered_rect(78, 62, size));
        }
    }

    fn runtime_task_counts(&self) -> (usize, usize, usize, usize) {
        let activations = self
            .context_view
            .as_ref()
            .map(|view| view.active_activations.len())
            .unwrap_or_default();
        let objectives = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .count();
        let background = self.context_background_tasks().len();
        let delegations = self
            .delegations
            .iter()
            .filter(|job| {
                job.parent_context_id == self.context_id
                    && matches!(
                        job.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    )
            })
            .count();
        (activations, objectives, background, delegations)
    }

    fn context_background_tasks(&self) -> &[crate::orchestrator::context::BackgroundTaskView] {
        self.context_view
            .as_ref()
            .map(|view| view.background_tasks.as_slice())
            .unwrap_or(&[])
    }

    fn task_overview_lines(&self) -> Vec<Line<'static>> {
        const MAX_ITEMS_PER_SECTION: usize = 4;
        let (activations, objectives, background_count, delegations) = self.runtime_task_counts();
        let total = activations + objectives + background_count + delegations;
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    self.tr("TASKS & EXECUTION", "任务与执行"),
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  {activations} 项求值  ·  {objectives} 个目标  ·  {background_count} 个后台任务  ·  {delegations} 项委派"
                        )
                    } else {
                        format!(
                            "  {activations} evaluations  ·  {objectives} objectives  ·  {background_count} background tasks  ·  {delegations} delegations"
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                self.tr(
                    "Only current executable facts are shown; press D for diagnostics.",
                    "仅显示当前可执行事实；按 D 查看诊断详情。",
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
        ];
        if total == 0 {
            lines.push(Line::from(vec![
                Span::styled("○  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    self.tr("No active tasks", "当前没有活跃任务"),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]));
            return lines;
        }

        if let Some(view) = self.context_view.as_ref() {
            if !view.thread_groups.is_empty() {
                lines.push(section_title(
                    self.tr("SUPERVISED THREAD GROUPS", "受监督线程组"),
                    view.thread_groups.len(),
                    self.theme.focus,
                    self.theme.text_muted,
                ));
                lines.extend(self.thread_group_panel_lines(false));
                lines.push(Line::from(""));
            }
            if !view.active_activations.is_empty() {
                lines.push(section_title(
                    self.tr("MODEL EVALUATIONS", "模型求值"),
                    view.active_activations.len(),
                    self.theme.tool,
                    self.theme.text_muted,
                ));
                for item in view.active_activations.iter().take(MAX_ITEMS_PER_SECTION) {
                    lines.push(Line::from(vec![
                        Span::styled("  ◒  ", Style::default().fg(self.theme.tool)),
                        Span::styled(
                            localized_runtime_status(self.locale, item.status.as_str()),
                            Style::default()
                                .fg(task_status_color(item.status.as_str(), &self.theme))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            if self.locale.is_chinese() {
                                format!(
                                    "  {} · 会话/{}",
                                    item.trigger_kind,
                                    short_id(&item.session_id)
                                )
                            } else {
                                format!(
                                    "  {} · session/{}",
                                    item.trigger_kind,
                                    short_id(&item.session_id)
                                )
                            },
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]));
                }
                push_more_hint(
                    &mut lines,
                    view.active_activations.len(),
                    MAX_ITEMS_PER_SECTION,
                    self.theme.text_muted,
                    self.locale,
                );
                lines.push(Line::from(""));
            }
        }

        let active_objectives = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .collect::<Vec<_>>();
        if !active_objectives.is_empty() {
            lines.push(section_title(
                self.tr("OBJECTIVES", "目标"),
                active_objectives.len(),
                self.theme.warning,
                self.theme.text_muted,
            ));
            for objective in &active_objectives {
                let selected = self.selected_objective_id.as_deref() == Some(objective.id.as_str());
                lines.push(Line::from(vec![
                    Span::styled(
                        if selected { "▌ " } else { "  " },
                        Style::default().fg(if selected {
                            self.theme.focus
                        } else {
                            self.theme.border_subtle
                        }),
                    ),
                    Span::styled(
                        format!("{}  ", objective_status_marker(objective.status)),
                        Style::default().fg(objective_status_color(objective.status, &self.theme)),
                    ),
                    Span::styled(
                        truncate(&objective.stated_objective.replace('\n', " "), 110),
                        Style::default()
                            .fg(self.theme.text_primary)
                            .add_modifier(if selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                    Span::styled(
                        format!(
                            "  ·  {}",
                            localized_objective_status(self.locale, objective.status)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        }

        let background = self.context_background_tasks();
        if !background.is_empty() {
            lines.push(section_title(
                self.tr("BACKGROUND TASKS", "后台任务"),
                background.len(),
                self.theme.success,
                self.theme.text_muted,
            ));
            for task in background.iter().take(MAX_ITEMS_PER_SECTION) {
                lines.push(Line::from(vec![
                    Span::styled("  ●  ", Style::default().fg(self.theme.success)),
                    Span::styled(
                        truncate(&task.command_preview.replace('\n', " "), 110),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!(
                            "  ·  {}",
                            localized_runtime_status(self.locale, &task.status)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            push_more_hint(
                &mut lines,
                background.len(),
                MAX_ITEMS_PER_SECTION,
                self.theme.text_muted,
                self.locale,
            );
            lines.push(Line::from(""));
        }

        let active_delegations = self
            .delegations
            .iter()
            .filter(|job| {
                job.parent_context_id == self.context_id
                    && matches!(
                        job.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    )
            })
            .collect::<Vec<_>>();
        if !active_delegations.is_empty() {
            lines.push(section_title(
                self.tr("DELEGATIONS", "委派"),
                active_delegations.len(),
                self.theme.focus,
                self.theme.text_muted,
            ));
            for job in active_delegations.iter().take(MAX_ITEMS_PER_SECTION) {
                lines.push(Line::from(vec![
                    Span::styled("  ◇  ", Style::default().fg(self.theme.focus)),
                    Span::styled(
                        truncate(&job.task.replace('\n', " "), 110),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!(
                            "  ·  {}",
                            localized_delegation_status(self.locale, &job.status)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            push_more_hint(
                &mut lines,
                active_delegations.len(),
                MAX_ITEMS_PER_SECTION,
                self.theme.text_muted,
                self.locale,
            );
        }
        lines
    }

    fn task_diagnostic_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    self.tr("TASK DIAGNOSTICS", "任务诊断"),
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  ·  context/{}", short_id(&self.context_id)),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                self.tr(
                    "Only Runtime-verified objectives, evaluations, background tasks, and delegations are shown.",
                    "仅显示运行时可验证的目标、求值、后台任务与委派。",
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
        ];

        let activations = self
            .context_view
            .as_ref()
            .map(|view| view.active_activations.as_slice())
            .unwrap_or_default();
        lines.push(section_title(
            self.tr("EVALUATIONS", "求值"),
            activations.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for item in activations {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    localized_runtime_status(self.locale, item.status.as_str()),
                    Style::default()
                        .fg(task_status_color(item.status.as_str(), &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  {}  ·  会话/{}  ·  {}",
                            short_id(&item.id),
                            short_id(&item.session_id),
                            item.trigger_kind
                        )
                    } else {
                        format!(
                            "  {}  ·  session/{}  ·  {}",
                            short_id(&item.id),
                            short_id(&item.session_id),
                            item.trigger_kind
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
        }
        if activations.is_empty() {
            lines.push(empty_state_line(
                self.tr("No active model evaluations", "没有活跃的模型求值"),
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));

        let objectives = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .collect::<Vec<_>>();
        lines.push(section_title(
            self.tr("OBJECTIVES", "目标"),
            objectives.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for objective in objectives {
            lines.push(Line::from(vec![
                Span::styled(
                    format!("  {} ", objective_status_marker(objective.status)),
                    Style::default().fg(objective_status_color(objective.status, &self.theme)),
                ),
                Span::styled(
                    localized_objective_status(self.locale, objective.status),
                    Style::default()
                        .fg(objective_status_color(objective.status, &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  {}  ·  修订 {}",
                            short_id(&objective.id),
                            objective.revision
                        )
                    } else {
                        format!(
                            "  {}  ·  revision {}",
                            short_id(&objective.id),
                            objective.revision
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
            lines.push(Line::from(Span::styled(
                format!(
                    "     {}",
                    truncate(&objective.stated_objective.replace('\n', " "), 180)
                ),
                Style::default().fg(self.theme.text_primary),
            )));
            if let Some(wait) = objective.wait_condition.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!(
                        "     {}: {}",
                        self.tr("waiting", "等待"),
                        format_objective_wait(wait, self.locale)
                    ),
                    Style::default().fg(self.theme.text_muted),
                )));
            }
        }
        if self
            .objectives
            .iter()
            .all(|objective| objective.status.is_terminal())
        {
            lines.push(empty_state_line(
                self.tr("No non-terminal objectives", "没有非终态目标"),
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));

        let background = self.context_background_tasks();
        lines.push(section_title(
            self.tr("BACKGROUND TASKS", "后台任务"),
            background.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for task in background {
            lines.push(Line::from(vec![
                Span::styled("  ◒ ", Style::default().fg(self.theme.warning)),
                Span::styled(
                    localized_runtime_status(self.locale, &task.status),
                    Style::default()
                        .fg(task_status_color(&task.status, &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  {}  ·  会话/{}  ·  {}秒",
                            short_id(&task.task_id),
                            short_id(&task.session_id),
                            task.elapsed_secs
                        )
                    } else {
                        format!(
                            "  {}  ·  session/{}  ·  {}s",
                            short_id(&task.task_id),
                            short_id(&task.session_id),
                            task.elapsed_secs
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
            lines.push(Line::from(Span::styled(
                format!(
                    "     {}",
                    truncate(&task.command_preview.replace('\n', " "), 180)
                ),
                Style::default().fg(self.theme.text_primary),
            )));
            if let Some(due) = task.checkpoint_due_at.as_deref() {
                lines.push(Line::from(Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "     检查点 g{} · {}",
                            task.checkpoint_generation.unwrap_or(0),
                            due
                        )
                    } else {
                        format!(
                            "     checkpoint g{} · {}",
                            task.checkpoint_generation.unwrap_or(0),
                            due
                        )
                    },
                    Style::default().fg(self.theme.warning),
                )));
            }
        }
        if background.is_empty() {
            lines.push(empty_state_line(
                self.tr("No running background tasks", "没有运行中的后台任务"),
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));

        let delegations = self
            .delegations
            .iter()
            .filter(|job| {
                job.parent_context_id == self.context_id
                    && matches!(
                        job.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    )
            })
            .collect::<Vec<_>>();
        lines.push(section_title(
            self.tr("DELEGATIONS", "委派"),
            delegations.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for job in delegations {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    localized_delegation_status(self.locale, &job.status),
                    Style::default()
                        .fg(task_status_color(job.status.as_str(), &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  {}  ·  子会话/{}",
                            short_id(&job.id),
                            short_id(&job.child_session_id)
                        )
                    } else {
                        format!(
                            "  {}  ·  child/{}",
                            short_id(&job.id),
                            short_id(&job.child_session_id)
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
            lines.push(Line::from(Span::styled(
                format!("     {}", truncate(&job.task.replace('\n', " "), 180)),
                Style::default().fg(self.theme.text_primary),
            )));
        }
        if self
            .delegations
            .iter()
            .filter(|job| job.parent_context_id == self.context_id)
            .all(|job| {
                !matches!(
                    job.status,
                    DelegationStatus::Queued | DelegationStatus::Running
                )
            })
        {
            lines.push(empty_state_line(
                self.tr("No active subagent delegations", "没有活跃的子代理委派"),
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            self.tr(
                "Free-form Mind Frames appear only in the cognition view; the Runtime never guesses that they are tasks.",
                "自由认知帧仅在认知视图中呈现；运行时不会猜测它们是任务。",
            ),
            Style::default().fg(self.theme.text_muted),
        )));
        lines
    }

    fn mind_lines(&self) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line(
                self.tr(
                    "The shared cognition structure is loading",
                    "共享认知结构正在加载",
                ),
                self.theme.text_muted,
            )];
        };
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    self.tr("SHARED MIND", "共享认知"),
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  ·  {}/{}  ·  {} {}",
                        self.tr("context", "上下文"),
                        short_id(&view.context_id),
                        self.tr("revision", "修订"),
                        view.state.version,
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                if self.locale.is_chinese() {
                    format!(
                        "{} 个词元 / {} 硬上限 · 压力 {} · {} 个完整会话 + {} 个元数据会话",
                        compact_count(view.pressure.estimated_tokens),
                        compact_count(view.pressure.hard_limit),
                        localized_pressure(self.locale, &view.pressure.level),
                        view.session_working_set.full_session_ids.len(),
                        view.session_working_set.metadata_only_session_ids.len()
                    )
                } else {
                    format!(
                        "{} tokens / {} hard limit · pressure {} · {} full + {} metadata sessions",
                        compact_count(view.pressure.estimated_tokens),
                        compact_count(view.pressure.hard_limit),
                        localized_pressure(self.locale, &view.pressure.level),
                        view.session_working_set.full_session_ids.len(),
                        view.session_working_set.metadata_only_session_ids.len()
                    )
                },
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
            section_title(
                self.tr("MIND FRAMES", "认知帧"),
                view.state.frames.len(),
                self.theme.text_secondary,
                self.theme.text_muted,
            ),
        ];
        for frame in &view.state.frames {
            let protected = if view.state.protected.contains(&frame.id) {
                self.tr(" · protected", " · 已保护")
            } else {
                ""
            };
            let selected = self.selected_frame_id.as_deref() == Some(frame.id.as_str());
            lines.push(Line::from(vec![
                Span::styled(
                    if selected { "▌ " } else { "  " },
                    Style::default().fg(if selected {
                        self.theme.focus
                    } else {
                        self.theme.border_subtle
                    }),
                ),
                Span::styled("◇ ", Style::default().fg(self.theme.focus)),
                Span::styled(
                    frame.id.clone(),
                    Style::default()
                        .fg(self.theme.text_secondary)
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!(
                            "  ·  修订 {}  ·  更新于版本 {}  ·  {} 个来源{protected}",
                            frame.revision,
                            frame.updated_version,
                            frame.sources.len()
                        )
                    } else {
                        format!(
                            "  ·  revision {}  ·  updated v{}  ·  {} source(s){protected}",
                            frame.revision,
                            frame.updated_version,
                            frame.sources.len()
                        )
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
            for body_line in truncate(&frame.body, 420).lines() {
                lines.push(Line::from(Span::styled(
                    format!("     {body_line}"),
                    Style::default().fg(self.theme.text_primary),
                )));
            }
            lines.push(Line::from(""));
        }
        if view.state.frames.is_empty() {
            lines.push(empty_state_line(
                self.tr(
                    "The shared cognition has not formed any Mind Frames yet",
                    "共享认知尚未形成任何认知帧",
                ),
                self.theme.text_muted,
            ));
            lines.push(Line::from(""));
        }

        lines.push(section_title(
            self.tr("RELATIONS", "关系"),
            view.state.relations.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for relation in &view.state.relations {
            lines.push(Line::from(Span::styled(
                format!(
                    "  {}  —{}→  {}  ·  v{}",
                    relation.subject, relation.relation, relation.object, relation.created_version
                ),
                Style::default().fg(self.theme.text_secondary),
            )));
        }
        if view.state.relations.is_empty() {
            lines.push(empty_state_line(
                self.tr("No explicit relations", "没有显式关系"),
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            if self.locale.is_chinese() {
                format!(
                    "已退役 {}  ·  已保护 {}  ·  检查点 {}  ·  按 Ctrl+K 或 Esc 返回对话",
                    view.state.retired.len(),
                    view.state.protected.len(),
                    view.state.checkpoints.len()
                )
            } else {
                format!(
                    "RETIRED {}  ·  PROTECTED {}  ·  CHECKPOINTS {}  ·  Ctrl+K / Esc to return",
                    view.state.retired.len(),
                    view.state.protected.len(),
                    view.state.checkpoints.len()
                )
            },
            Style::default().fg(self.theme.text_muted),
        )));
        lines
    }

    fn render_view_lines(&mut self, frame: &mut Frame<'_>, area: Rect, lines: Vec<Line<'static>>) {
        let inner = inset_rect(area, content_horizontal_margin(area.width), 1);
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        let visual_lines = paragraph.line_count(inner.width);
        let max_scroll = visual_lines
            .saturating_sub(inner.height as usize)
            .min(u16::MAX as usize) as u16;
        self.view_scroll = self.view_scroll.min(max_scroll);
        frame.render_widget(paragraph.scroll((self.view_scroll, 0)), inner);
    }

    fn evaluation_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line(
                self.tr("Context is loading", "上下文正在加载"),
                self.theme.text_muted,
            )];
        };
        if view.active_activations.is_empty() {
            return vec![empty_state_line(
                self.tr("No active model evaluations", "没有活跃的模型求值"),
                self.theme.text_muted,
            )];
        }
        view.active_activations
            .iter()
            .flat_map(|item| {
                let mut lines = vec![Line::from(vec![
                    Span::styled("◒ ", Style::default().fg(self.theme.tool)),
                    Span::styled(
                        localized_runtime_status(self.locale, item.status.as_str()),
                        Style::default()
                            .fg(task_status_color(item.status.as_str(), &self.theme))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {}", item.trigger_kind),
                        Style::default().fg(self.theme.text_primary),
                    ),
                ])];
                if detailed {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  {} · {}/{}",
                            short_id(&item.id),
                            self.tr("session", "会话"),
                            short_id(&item.session_id),
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines
            })
            .collect()
    }

    fn background_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let tasks = self.context_background_tasks();
        if tasks.is_empty() {
            return vec![empty_state_line(
                self.tr("No running background tasks", "没有运行中的后台任务"),
                self.theme.text_muted,
            )];
        }
        tasks
            .iter()
            .flat_map(|task| {
                let mut lines = vec![Line::from(vec![
                    Span::styled("● ", Style::default().fg(self.theme.success)),
                    Span::styled(
                        truncate(&task.command_preview.replace('\n', " "), 120),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!(
                            "  ·  {}",
                            localized_runtime_status(self.locale, &task.status)
                        ),
                        Style::default().fg(task_status_color(&task.status, &self.theme)),
                    ),
                ])];
                if detailed {
                    let mut detail = format!(
                        "  {} · {}/{} · {}{}",
                        short_id(&task.task_id),
                        self.tr("session", "会话"),
                        short_id(&task.session_id),
                        task.elapsed_secs,
                        self.tr("s", "秒"),
                    );
                    if let Some(due) = task.checkpoint_due_at.as_deref() {
                        detail.push_str(&format!(
                            " · {} g{} {}",
                            self.tr("checkpoint", "检查点"),
                            task.checkpoint_generation.unwrap_or(0),
                            due
                        ));
                    }
                    lines.push(Line::from(Span::styled(
                        detail,
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines
            })
            .collect()
    }

    fn execution_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let activations = self
            .context_view
            .as_ref()
            .map(|view| view.active_activations.len())
            .unwrap_or_default();
        let background = self.context_background_tasks().len();
        if activations + background == 0 {
            return vec![empty_state_line(
                self.tr(
                    "No model evaluations or background tasks are running",
                    "没有正在执行的模型求值或后台任务",
                ),
                self.theme.text_muted,
            )];
        }

        let mut lines = Vec::new();
        if activations > 0 {
            lines.push(section_title(
                self.tr("EVALUATIONS", "求值"),
                activations,
                self.theme.tool,
                self.theme.text_muted,
            ));
            lines.extend(self.evaluation_panel_lines(detailed));
        }
        if background > 0 {
            if !lines.is_empty() {
                lines.push(Line::from(""));
            }
            lines.push(section_title(
                self.tr("BACKGROUND TASKS", "后台任务"),
                background,
                self.theme.success,
                self.theme.text_muted,
            ));
            lines.extend(self.background_panel_lines(detailed));
        }
        lines
    }

    fn thread_group_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return Vec::new();
        };
        if view.thread_groups.is_empty() {
            return vec![empty_state_line(
                self.tr("No supervised Thread Groups", "没有受监督线程组"),
                self.theme.text_muted,
            )];
        }

        view.thread_groups
            .iter()
            .flat_map(|group| {
                let members = view
                    .thread_group_members
                    .iter()
                    .filter(|member| member.group_id == group.id)
                    .count();
                let outcomes = view
                    .thread_outcomes
                    .iter()
                    .filter(|outcome| {
                        view.thread_group_members.iter().any(|member| {
                            member.group_id == group.id && member.thread_id == outcome.thread_id
                        })
                    })
                    .count();
                let mut lines = vec![Line::from(vec![
                    Span::styled(
                        if group.status.as_str() == "open" {
                            "◒ "
                        } else {
                            "● "
                        },
                        Style::default().fg(if group.status.as_str() == "open" {
                            self.theme.warning
                        } else {
                            self.theme.success
                        }),
                    ),
                    Span::styled(
                        short_id(&group.id),
                        Style::default()
                            .fg(self.theme.text_primary)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!(
                            "  ·  {} / {}  ·  {} {outcomes}/{members}",
                            group.policy.as_str(),
                            group.status.as_str(),
                            self.tr("outcomes", "结果")
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ])];
                if detailed {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  {}:{} · generation {}{}",
                            group.supervisor_kind.as_str(),
                            short_id(&group.supervisor_id),
                            group.generation,
                            group
                                .barrier_event_id
                                .as_deref()
                                .map(|id| format!(" · barrier/{}", short_id(id)))
                                .unwrap_or_default()
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines
            })
            .collect()
    }

    fn task_outline_lines(&self) -> Vec<Line<'static>> {
        let objectives = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .collect::<Vec<_>>();
        let activations = self
            .context_view
            .as_ref()
            .map(|view| view.active_activations.as_slice())
            .unwrap_or_default();
        let thread_groups = self
            .context_view
            .as_ref()
            .map(|view| view.thread_groups.as_slice())
            .unwrap_or_default();
        let background = self.context_background_tasks();
        let delegations = self
            .delegations
            .iter()
            .filter(|job| {
                job.parent_context_id == self.context_id
                    && matches!(
                        job.status,
                        DelegationStatus::Queued | DelegationStatus::Running
                    )
            })
            .collect::<Vec<_>>();

        let mut lines = vec![section_title(
            self.tr("OBJECTIVES", "目标"),
            objectives.len(),
            self.theme.focus,
            self.theme.text_muted,
        )];
        if objectives.is_empty() {
            lines.push(empty_state_line(
                self.tr("No active objectives", "没有活跃目标"),
                self.theme.text_muted,
            ));
        }
        for objective in objectives {
            let selected = self.selected_objective_id.as_deref() == Some(objective.id.as_str());
            lines.push(Line::from(vec![
                Span::styled(
                    if selected { "▌ " } else { "  " },
                    Style::default().fg(if selected {
                        self.theme.focus
                    } else {
                        self.theme.border_subtle
                    }),
                ),
                Span::styled(
                    objective_status_marker(objective.status),
                    Style::default().fg(objective_status_color(objective.status, &self.theme)),
                ),
                Span::styled(
                    format!(
                        " {}  r{}",
                        truncate(&objective.stated_objective.replace('\n', " "), 42),
                        objective.revision
                    ),
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
            ]));
            if let Some(wait) = objective.wait_condition.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!("      ◷ {}", format_objective_wait(wait, self.locale)),
                    Style::default().fg(self.theme.warning),
                )));
            }
        }

        lines.push(Line::from(""));
        lines.push(section_title(
            self.tr("EXECUTION", "执行"),
            activations.len() + background.len() + thread_groups.len(),
            self.theme.success,
            self.theme.text_muted,
        ));
        for activation in activations.iter().take(5) {
            lines.push(Line::from(vec![
                Span::styled("  ◒ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    truncate(&activation.trigger_kind, 32),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(
                    format!(
                        "  {}",
                        localized_runtime_status(self.locale, activation.status.as_str())
                    ),
                    Style::default().fg(task_status_color(activation.status.as_str(), &self.theme)),
                ),
            ]));
        }
        for task in background.iter().take(4) {
            lines.push(Line::from(vec![
                Span::styled("  ● ", Style::default().fg(self.theme.success)),
                Span::styled(
                    truncate(&task.command_preview.replace('\n', " "), 34),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(
                    format!("  {}", localized_runtime_status(self.locale, &task.status)),
                    Style::default().fg(task_status_color(&task.status, &self.theme)),
                ),
            ]));
        }
        for group in thread_groups.iter().take(4) {
            lines.push(Line::from(vec![
                Span::styled("  ├ ", Style::default().fg(self.theme.focus)),
                Span::styled(
                    format!("{} · {}", short_id(&group.id), group.status.as_str()),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]));
        }
        if activations.is_empty() && background.is_empty() && thread_groups.is_empty() {
            lines.push(empty_state_line(
                self.tr("No work in flight", "没有正在执行的工作"),
                self.theme.text_muted,
            ));
        }

        lines.push(Line::from(""));
        lines.push(section_title(
            self.tr("DELEGATIONS", "委派"),
            delegations.len(),
            self.theme.tool,
            self.theme.text_muted,
        ));
        if delegations.is_empty() {
            lines.push(empty_state_line(
                self.tr("No active delegations", "没有活跃委派"),
                self.theme.text_muted,
            ));
        }
        for job in delegations.into_iter().take(4) {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    truncate(&job.task.replace('\n', " "), 38),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]));
        }
        lines
    }

    fn task_detail_lines(&self) -> Vec<Line<'static>> {
        let selected = self
            .objectives
            .iter()
            .find(|objective| {
                !objective.status.is_terminal()
                    && self.selected_objective_id.as_deref() == Some(objective.id.as_str())
            })
            .or_else(|| {
                self.objectives
                    .iter()
                    .find(|objective| !objective.status.is_terminal())
            });
        let mut lines = Vec::new();
        if let Some(objective) = selected {
            lines.extend([
                Line::from(Span::styled(
                    format!(
                        "{} · {}",
                        self.tr("OBJECTIVE", "目标"),
                        short_id(&objective.id)
                    ),
                    Style::default().fg(self.theme.focus),
                )),
                Line::from(Span::styled(
                    objective.stated_objective.clone(),
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(vec![
                    Span::styled(
                        format!("{}  ", self.tr("Status", "状态")),
                        Style::default().fg(self.theme.text_muted),
                    ),
                    Span::styled(
                        localized_objective_status(self.locale, objective.status),
                        Style::default().fg(objective_status_color(objective.status, &self.theme)),
                    ),
                    Span::styled(
                        format!("  ·  r{}", objective.revision),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]),
            ]);
            if let Some(wait) = objective.wait_condition.as_ref() {
                lines.push(Line::from(Span::styled(
                    format!(
                        "{}  ◷ {}",
                        self.tr("Waiting", "等待"),
                        format_objective_wait(wait, self.locale)
                    ),
                    Style::default().fg(self.theme.warning),
                )));
            }
            if let Some(reason) = objective.status_reason.as_deref() {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    reason.to_string(),
                    Style::default().fg(self.theme.text_secondary),
                )));
            }
        } else {
            lines.push(empty_state_line(
                self.tr(
                    "No active objective is selected",
                    "当前没有可查看的活跃目标",
                ),
                self.theme.text_muted,
            ));
        }

        lines.push(Line::from(""));
        lines.push(section_title(
            self.tr("CURRENT ACTIVITY", "当前活动"),
            self.runtime_task_counts().0 + self.runtime_task_counts().2,
            self.theme.success,
            self.theme.text_muted,
        ));
        lines.extend(self.execution_panel_lines(self.show_task_diagnostics));
        let groups = self.thread_group_panel_lines(self.show_task_diagnostics);
        if self
            .context_view
            .as_ref()
            .is_some_and(|view| !view.thread_groups.is_empty())
        {
            lines.push(Line::from(""));
            lines.push(section_title(
                self.tr("THREAD GROUPS", "线程组"),
                self.context_view
                    .as_ref()
                    .map(|view| view.thread_groups.len())
                    .unwrap_or_default(),
                self.theme.focus,
                self.theme.text_muted,
            ));
            lines.extend(groups);
        }
        lines
    }

    fn render_tasks_view(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if area.width < 94 || area.height < 16 {
            let lines = if self.show_task_diagnostics {
                self.task_diagnostic_lines()
            } else {
                self.task_overview_lines()
            };
            self.render_view_lines(frame, area, lines);
            return;
        }

        let inner = inset_rect(area, content_horizontal_margin(area.width), 0);
        let (activations, objectives, background, delegations) = self.runtime_task_counts();
        let thread_groups = self
            .context_view
            .as_ref()
            .map(|view| view.thread_groups.len())
            .unwrap_or_default();
        let total = activations + objectives + background + delegations + thread_groups;
        if total == 0 {
            self.render_tasks_empty_state(frame, inner);
            return;
        }

        let panes = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(37), Constraint::Percentage(63)])
            .split(inner);
        frame.render_widget(
            Paragraph::new(self.task_outline_lines())
                .block(
                    Block::default()
                        .borders(Borders::RIGHT)
                        .border_style(Style::default().fg(self.theme.border_subtle))
                        .padding(ratatui::widgets::Padding::horizontal(1)),
                )
                .wrap(Wrap { trim: false }),
            panes[0],
        );
        frame.render_widget(
            Paragraph::new(self.task_detail_lines())
                .block(Block::default().padding(ratatui::widgets::Padding::horizontal(2)))
                .wrap(Wrap { trim: false }),
            panes[1],
        );
    }

    fn render_tasks_empty_state(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    self.tr("TASKS & EXECUTION  0", "任务与执行  0"),
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    self.tr("○  No tasks are running", "○  当前没有进行中的任务"),
                    Style::default().fg(self.theme.text_secondary),
                )),
                Line::from(Span::styled(
                    self.tr(
                        "New objectives, executions, and delegations will appear here by level.",
                        "新的目标、执行任务和委派会按层级出现在这里。",
                    ),
                    Style::default().fg(self.theme.text_muted),
                )),
            ])
            .block(Block::default().padding(ratatui::widgets::Padding::new(2, 2, 1, 0))),
            area,
        );
    }

    fn mind_outline_lines(&self) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line(
                self.tr("Shared cognition is loading", "共享认知正在加载"),
                self.theme.text_muted,
            )];
        };
        let mut lines = vec![section_title(
            self.tr("MIND FRAMES", "认知帧"),
            view.state.frames.len(),
            self.theme.focus,
            self.theme.text_muted,
        )];
        for context_frame in &view.state.frames {
            let protected = view.state.protected.contains(&context_frame.id);
            let selected = self.selected_frame_id.as_deref() == Some(context_frame.id.as_str());
            lines.push(Line::from(vec![
                Span::styled(
                    if selected { "▌ " } else { "  " },
                    Style::default().fg(if selected {
                        self.theme.focus
                    } else {
                        self.theme.border_subtle
                    }),
                ),
                Span::styled(
                    if protected { "◆ " } else { "◇ " },
                    Style::default().fg(if protected {
                        self.theme.brand
                    } else {
                        self.theme.text_muted
                    }),
                ),
                Span::styled(
                    truncate(&context_frame.id, 38),
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                ),
                Span::styled(
                    format!("  r{}", context_frame.revision),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
        }
        lines
    }

    fn mind_detail_lines(&self) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line(
                self.tr("Shared cognition is loading", "共享认知正在加载"),
                self.theme.text_muted,
            )];
        };
        let Some(context_frame) = view
            .state
            .frames
            .iter()
            .find(|frame| self.selected_frame_id.as_deref() == Some(frame.id.as_str()))
            .or_else(|| view.state.frames.first())
        else {
            return Vec::new();
        };
        let protected = view.state.protected.contains(&context_frame.id);
        let mut lines = vec![
            Line::from(Span::styled(
                format!(
                    "{} · {}",
                    self.tr("FRAME", "认知帧"),
                    short_id(&context_frame.id)
                ),
                Style::default().fg(self.theme.focus),
            )),
            Line::from(Span::styled(
                context_frame.id.clone(),
                Style::default()
                    .fg(self.theme.text_primary)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    format!("{}  ", self.tr("Revision", "修订")),
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    format!("r{}", context_frame.revision),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!("  ·  {} 个来源", context_frame.sources.len())
                    } else {
                        format!("  ·  {} sources", context_frame.sources.len())
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    if protected {
                        self.tr("  ·  protected", "  ·  已保护")
                    } else {
                        ""
                    },
                    Style::default().fg(self.theme.brand),
                ),
            ]),
            Line::from(""),
        ];
        lines.extend(sexpr_reader_lines(&context_frame.body, &self.theme));
        if !context_frame.sources.is_empty() {
            lines.push(Line::from(""));
            lines.push(section_title(
                self.tr("SOURCES", "来源"),
                context_frame.sources.len(),
                self.theme.text_secondary,
                self.theme.text_muted,
            ));
            for source in context_frame.sources.iter().take(8) {
                lines.push(Line::from(vec![
                    Span::styled("  ↳ ", Style::default().fg(self.theme.text_muted)),
                    Span::styled(
                        source.clone(),
                        Style::default().fg(self.theme.text_secondary),
                    ),
                ]));
            }
        }
        let related = view
            .state
            .relations
            .iter()
            .filter(|relation| {
                relation.subject == context_frame.id || relation.object == context_frame.id
            })
            .collect::<Vec<_>>();
        if !related.is_empty() {
            lines.push(Line::from(""));
            lines.push(section_title(
                self.tr("RELATIONS", "关系"),
                related.len(),
                self.theme.tool,
                self.theme.text_muted,
            ));
            for relation in related.into_iter().take(6) {
                lines.push(Line::from(Span::styled(
                    format!(
                        "  {} —{}→ {}",
                        relation.subject, relation.relation, relation.object
                    ),
                    Style::default().fg(self.theme.text_secondary),
                )));
            }
        }
        lines.push(Line::from(""));
        lines.push(Line::from(vec![
            Span::styled(
                format!("{}  ", self.tr("Pressure", "压力")),
                Style::default().fg(self.theme.text_muted),
            ),
            Span::styled(
                localized_pressure(self.locale, &view.pressure.level),
                Style::default().fg(pressure_color(&view.pressure.level, &self.theme)),
            ),
            Span::styled(
                format!(
                    "  ·  {} / {}",
                    compact_count(view.pressure.estimated_tokens),
                    compact_count(view.pressure.hard_limit)
                ),
                Style::default().fg(self.theme.text_muted),
            ),
        ]));
        lines
    }

    fn render_mind_view(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if area.width < 94 || area.height < 16 {
            let lines = self.mind_lines();
            self.render_view_lines(frame, area, lines);
            return;
        }
        let Some(view) = self.context_view.as_ref() else {
            self.render_view_lines(
                frame,
                area,
                vec![empty_state_line(
                    self.tr(
                        "The shared cognition structure is loading",
                        "共享认知结构正在加载",
                    ),
                    self.theme.text_muted,
                )],
            );
            return;
        };

        let inner = inset_rect(area, content_horizontal_margin(area.width), 0);
        if view.state.frames.is_empty() {
            self.render_mind_empty_state(frame, inner, view.state.version);
            return;
        }

        let panes = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(37), Constraint::Percentage(63)])
            .split(inner);
        frame.render_widget(
            Paragraph::new(self.mind_outline_lines())
                .block(
                    Block::default()
                        .borders(Borders::RIGHT)
                        .border_style(Style::default().fg(self.theme.border_subtle))
                        .padding(ratatui::widgets::Padding::horizontal(1)),
                )
                .wrap(Wrap { trim: false }),
            panes[0],
        );
        frame.render_widget(
            Paragraph::new(self.mind_detail_lines())
                .block(Block::default().padding(ratatui::widgets::Padding::horizontal(2)))
                .wrap(Wrap { trim: false }),
            panes[1],
        );
    }

    fn render_mind_empty_state(&self, frame: &mut Frame<'_>, area: Rect, version: u64) {
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    if self.locale.is_chinese() {
                        format!("认知帧  0  ·  r{version}")
                    } else {
                        format!("MIND FRAMES  0  ·  r{version}")
                    },
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    self.tr(
                        "○  The shared cognition has not formed any Mind Frames yet",
                        "○  共享认知尚未形成任何认知帧",
                    ),
                    Style::default().fg(self.theme.text_secondary),
                )),
                Line::from(Span::styled(
                    self.tr(
                        "The agent creates them autonomously when goals, constraints, or experience should persist.",
                        "代理会在需要保留目标、约束或经验时自主创建。",
                    ),
                    Style::default().fg(self.theme.text_muted),
                )),
            ])
            .block(Block::default().padding(ratatui::widgets::Padding::new(2, 2, 1, 0))),
            area,
        );
    }

    fn startup_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = vec![Line::from("")];
        let rule_width = width.saturating_sub(2).min(112) as usize;
        if width >= 104 {
            lines.push(Line::from(Span::styled(
                "─".repeat(rule_width),
                Style::default().fg(self.theme.border_subtle),
            )));
            let wordmark_width = MORPHZ_WORDMARK
                .iter()
                .map(|line| UnicodeWidthStr::width(*line))
                .max()
                .unwrap_or_default()
                + 2;
            let metadata = [
                vec![Span::styled(
                    "Morphz",
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(Modifier::BOLD),
                )],
                vec![Span::styled(
                    self.tagline(),
                    Style::default().fg(self.theme.text_muted),
                )],
                vec![],
                vec![
                    Span::styled(
                        self.tr("Directory  ", "目录    "),
                        Style::default().fg(self.theme.text_muted),
                    ),
                    Span::styled(
                        self.working_directory.clone(),
                        Style::default().fg(self.theme.text_secondary),
                    ),
                ],
                vec![
                    Span::styled(
                        self.tr("Model      ", "模型    "),
                        Style::default().fg(self.theme.text_muted),
                    ),
                    Span::styled(
                        self.model.clone(),
                        Style::default().fg(self.theme.text_secondary),
                    ),
                ],
                vec![
                    Span::styled(
                        self.tr("Status     ", "状态    "),
                        Style::default().fg(self.theme.text_muted),
                    ),
                    Span::styled("● ", Style::default().fg(self.theme.success)),
                    Span::styled(
                        self.tr("Ready", "已就绪"),
                        Style::default().fg(self.theme.success),
                    ),
                ],
            ];
            let last_line = MORPHZ_WORDMARK.len().saturating_sub(1);
            for (index, wordmark) in MORPHZ_WORDMARK.iter().enumerate() {
                let slant = MORPHZ_WORDMARK_SLANT
                    .get(index)
                    .copied()
                    .unwrap_or_default();
                let rendered = format!("{}{}", " ".repeat(slant), wordmark);
                let padding = wordmark_width
                    .saturating_sub(UnicodeWidthStr::width(rendered.as_str()))
                    .saturating_add(4);
                let mut spans = vec![
                    Span::styled(
                        rendered,
                        Style::default()
                            .fg(interpolate_color(
                                self.theme.wordmark_start,
                                self.theme.wordmark_end,
                                index,
                                last_line,
                            ))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" ".repeat(padding)),
                ];
                spans.extend(metadata[index].clone());
                lines.push(Line::from(spans));
            }
            lines.push(Line::from(Span::styled(
                "─".repeat(rule_width),
                Style::default().fg(self.theme.border_subtle),
            )));
            lines.push(Line::from(""));
            return lines;
        }

        let wordmark: Option<&[&str]> = if width >= 66 {
            Some(&MORPHZ_WORDMARK)
        } else if width >= 44 {
            Some(&MORPHZ_COMPACT_WORDMARK)
        } else {
            None
        };
        if let Some(wordmark) = wordmark {
            let last_line = wordmark.len().saturating_sub(1);
            lines.extend(wordmark.iter().enumerate().map(|(index, line)| {
                Line::from(Span::styled(
                    format!(
                        "  {}{line}",
                        " ".repeat(MORPHZ_WORDMARK_SLANT.get(index).copied().unwrap_or(0))
                    ),
                    Style::default()
                        .fg(interpolate_color(
                            self.theme.wordmark_start,
                            self.theme.wordmark_end,
                            index,
                            last_line,
                        ))
                        .add_modifier(Modifier::BOLD),
                ))
            }));
        }
        let mut brand_line = vec![
            Span::styled("  ◆  ", Style::default().fg(self.theme.brand)),
            Span::styled(
                "Morphz",
                Style::default()
                    .fg(self.theme.text_primary)
                    .add_modifier(Modifier::BOLD),
            ),
        ];
        if width >= 44 {
            brand_line.extend([
                Span::styled("  ·  ", Style::default().fg(self.theme.border_subtle)),
                Span::styled(self.tagline(), Style::default().fg(self.theme.text_muted)),
            ]);
        }
        lines.extend([
            Line::from(""),
            Line::from(brand_line),
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    self.tr("     Directory  ", "     目录      "),
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    self.working_directory.clone(),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    self.tr("     Model      ", "     模型      "),
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    self.model.clone(),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(""),
        ]);
        lines
    }

    fn motion_color(&self) -> Color {
        let segment = (self.spinner / THEME_COLOR_MORPH_TICKS) % 3;
        let step = self.spinner % THEME_COLOR_MORPH_TICKS;
        let from = self.theme.motion_palette[segment];
        let to = self.theme.motion_palette[(segment + 1) % 3];
        interpolate_color(from, to, step, THEME_COLOR_MORPH_TICKS - 1)
    }

    fn user_message_marker_spans(&self, animated: bool) -> Vec<Span<'static>> {
        // The three existing colored themes form one shared motion palette.
        // The active theme leads the sequence; Mono follows the same motion in
        // grayscale. The complete mark changes color as one symmetric glyph;
        // the palette is temporal, never three simultaneous component colors.
        let color = if animated {
            self.motion_color()
        } else {
            self.theme.motion_palette[0]
        };
        let style = || Style::default().fg(color).add_modifier(Modifier::BOLD);
        vec![
            Span::styled("❨", style()),
            Span::styled("ᴍ", style()),
            Span::styled("❩ ", style()),
        ]
    }

    fn cognitive_activity_spans(&self, trailing_space: bool) -> Vec<Span<'static>> {
        // A thought condenses inside S-expression brackets instead of a generic
        // loading wheel rotating. Four dot sizes follow an eased curve with a
        // short rest at both extremes: 14 frames × 2 ticks × 80 ms ≈ 2.24 s.
        let pulse = COGNITIVE_PULSE_FRAMES
            [(self.spinner / COGNITIVE_PULSE_TICKS_PER_FRAME) % COGNITIVE_PULSE_FRAMES.len()];
        let pulse_modifier = match pulse {
            "·" => Modifier::DIM,
            "●" => Modifier::BOLD,
            _ => Modifier::empty(),
        };
        let color = self.motion_color();
        vec![
            Span::styled("❨", Style::default().fg(color)),
            Span::styled(
                pulse,
                Style::default().fg(color).add_modifier(pulse_modifier),
            ),
            Span::styled(
                if trailing_space { "❩ " } else { "❩" },
                Style::default().fg(color),
            ),
        ]
    }

    fn transcript_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = self.startup_lines(width);
        let latest_user_entry = self
            .entries
            .iter()
            .rposition(|entry| entry.kind == EntryKind::User);
        for (entry_index, entry) in self.entries.iter().enumerate() {
            if entry.kind == EntryKind::Tool {
                lines.extend(self.tool_activity_lines(&entry.body, entry.detail.as_deref()));
                continue;
            }
            if entry.kind == EntryKind::Reasoning {
                lines.extend(self.reasoning_summary_lines(&entry.body, width, false));
                continue;
            }
            if entry.kind == EntryKind::Assistant {
                lines.extend(self.assistant_message_lines(&entry.body, width));
                lines.push(Line::from(""));
                continue;
            }
            let (marker, marker_color, body_color, modifier) = match entry.kind {
                EntryKind::User => (
                    USER_MESSAGE_PREFIX,
                    self.theme.brand,
                    self.theme.brand,
                    Modifier::BOLD,
                ),
                EntryKind::Progress => (
                    "✦ ",
                    self.theme.brand,
                    self.theme.text_primary,
                    Modifier::empty(),
                ),
                EntryKind::Coordination => (
                    "↔ ",
                    self.theme.brand,
                    self.theme.text_secondary,
                    Modifier::empty(),
                ),
                EntryKind::System => (
                    "• ",
                    self.theme.text_muted,
                    self.theme.text_muted,
                    Modifier::empty(),
                ),
                EntryKind::Error => ("! ", self.theme.error, self.theme.error, Modifier::empty()),
                EntryKind::Reasoning | EntryKind::Assistant | EntryKind::Tool => unreachable!(),
            };
            for (index, body_line) in entry.body.lines().enumerate() {
                let mut spans = if entry.kind == EntryKind::User {
                    if index == 0 {
                        self.user_message_marker_spans(
                            self.busy && latest_user_entry == Some(entry_index),
                        )
                    } else {
                        vec![Span::raw(
                            " ".repeat(UnicodeWidthStr::width(USER_MESSAGE_PREFIX)),
                        )]
                    }
                } else {
                    let marker = if index == 0 {
                        marker.to_string()
                    } else {
                        " ".repeat(UnicodeWidthStr::width(marker))
                    };
                    vec![Span::styled(
                        marker,
                        Style::default()
                            .fg(marker_color)
                            .add_modifier(Modifier::BOLD),
                    )]
                };
                spans.push(Span::styled(
                    body_line.to_string(),
                    Style::default().fg(body_color).add_modifier(modifier),
                ));
                lines.push(Line::from(spans));
            }
            lines.push(Line::from(""));
        }
        for attempt in self
            .live_attempts
            .values()
            .filter(|attempt| attempt.is_conversation())
        {
            if attempt.reasoning_summary.trim().is_empty()
                && attempt.text.trim().is_empty()
                && attempt.tools.is_empty()
            {
                let mut spans = self.cognitive_activity_spans(true);
                spans.push(Span::styled(
                    self.tr("Thinking…", "正在思考…"),
                    Style::default()
                        .fg(self.theme.text_muted)
                        .add_modifier(Modifier::ITALIC),
                ));
                lines.push(Line::from(spans));
                lines.push(Line::from(""));
            }
            if !attempt.reasoning_summary.trim().is_empty() && !attempt.reasoning_summary_persisted
            {
                lines.extend(self.reasoning_summary_lines(&attempt.reasoning_summary, width, true));
            }
            if !attempt.text.trim().is_empty() {
                lines.extend(self.assistant_message_lines(&attempt.text, width));
                lines.push(Line::from(""));
            }
            for tool in attempt.tools.values() {
                let activity = summarize_tool_call(&tool.name, &tool.arguments, None, self.locale);
                let mut body = format!("{} {}", self.tr("Using", "正在使用"), activity.title);
                if !activity.target.is_empty() {
                    body.push('\n');
                    body.push_str("  ");
                    body.push_str(&activity.target);
                }
                lines.extend(self.tool_activity_lines(
                    &body,
                    (!tool.arguments.is_empty()).then_some(tool.arguments.as_str()),
                ));
            }
        }
        lines
    }

    fn assistant_message_lines(&self, body: &str, width: u16) -> Vec<Line<'static>> {
        let marker_width = UnicodeWidthStr::width("● ");
        markdown::render(body, self.theme, width.saturating_sub(marker_width as u16))
            .into_iter()
            .enumerate()
            .map(|(index, mut line)| {
                line.spans.insert(
                    0,
                    Span::styled(
                        if index == 0 {
                            "● ".to_string()
                        } else {
                            " ".repeat(marker_width)
                        },
                        Style::default().fg(self.theme.text_primary),
                    ),
                );
                line
            })
            .collect()
    }

    fn reasoning_summary_lines(&self, summary: &str, width: u16, live: bool) -> Vec<Line<'static>> {
        let summary = truncate(summary, 4_000);
        let marker_width = if live {
            UnicodeWidthStr::width("❨●❩ ")
        } else {
            UnicodeWidthStr::width("• ")
        };
        let wrapped = wrap_display_lines(
            &summary,
            width.saturating_sub(marker_width as u16).max(1) as usize,
        );
        let visible_count = if self.show_reasoning_details {
            wrapped.len()
        } else {
            wrapped.len().min(REASONING_PREVIEW_LINES)
        };
        let hidden_count = wrapped.len().saturating_sub(visible_count);
        let mut lines = wrapped
            .into_iter()
            .take(visible_count)
            .enumerate()
            .map(|(index, line)| {
                let mut spans = if index == 0 && live {
                    self.cognitive_activity_spans(true)
                } else if index == 0 {
                    vec![Span::styled(
                        "• ",
                        Style::default().fg(self.theme.text_muted),
                    )]
                } else {
                    vec![Span::raw(" ".repeat(marker_width))]
                };
                spans.push(Span::styled(
                    line,
                    Style::default()
                        .fg(self.theme.text_muted)
                        .add_modifier(Modifier::ITALIC),
                ));
                Line::from(spans)
            })
            .collect::<Vec<_>>();
        if hidden_count > 0 {
            lines.push(Line::from(vec![
                Span::raw(" ".repeat(marker_width)),
                Span::styled(
                    if self.locale.is_chinese() {
                        format!("…（还有 {hidden_count} 行 · 按 Ctrl+R 展开）")
                    } else {
                        format!("… ({hidden_count} more lines · Ctrl+R to expand)")
                    },
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
        }
        lines.push(Line::from(""));
        lines
    }

    fn tool_activity_lines(&self, body: &str, detail: Option<&str>) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        let mut starts_activity = true;
        for body_line in body.lines() {
            if body_line.trim().is_empty() {
                lines.push(Line::from(""));
                starts_activity = true;
                continue;
            }
            let trimmed = body_line.trim_start();
            let cleaned = trimmed
                .strip_prefix('◇')
                .or_else(|| trimmed.strip_prefix('✓'))
                .or_else(|| trimmed.strip_prefix('!'))
                .unwrap_or(trimmed)
                .trim_start();
            let completed = cleaned.starts_with("Used ")
                || cleaned.starts_with("已使用 ")
                || trimmed.starts_with('✓');
            let failed = cleaned.starts_with("Failed ")
                || cleaned.starts_with("失败 ")
                || trimmed.starts_with('!');
            let color = if failed {
                self.theme.error
            } else if completed {
                self.theme.success
            } else {
                self.theme.tool
            };
            if starts_activity {
                let (verb, title) = cleaned
                    .split_once(' ')
                    .filter(|(verb, _)| {
                        matches!(
                            *verb,
                            "Using" | "Used" | "Failed" | "正在使用" | "已使用" | "失败"
                        )
                    })
                    .unwrap_or(("", cleaned));
                let mut spans = vec![Span::styled("● ", Style::default().fg(color))];
                if !verb.is_empty() {
                    spans.push(Span::styled(
                        format!("{verb} "),
                        Style::default().fg(self.theme.text_secondary),
                    ));
                }
                spans.push(Span::styled(
                    title.to_string(),
                    Style::default()
                        .fg(if failed {
                            self.theme.error
                        } else {
                            self.theme.tool
                        })
                        .add_modifier(Modifier::BOLD),
                ));
                lines.push(Line::from(spans));
                starts_activity = false;
            } else {
                lines.push(Line::from(vec![
                    Span::raw("  "),
                    Span::styled(
                        cleaned.to_string(),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
        }
        if self.show_tool_details {
            if let Some(detail) = detail {
                for detail_line in truncate(detail, 1_600).lines() {
                    lines.push(Line::from(vec![
                        Span::styled("  │ ", Style::default().fg(self.theme.border_subtle)),
                        Span::styled(
                            detail_line.to_string(),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]));
                }
            }
        }
        lines.push(Line::from(""));
        lines
    }

    fn render_transcript(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let horizontal_margin = content_horizontal_margin(area.width);
        let inner = inset_rect(area, horizontal_margin, 0);
        let lines = self.transcript_lines(inner.width);
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        // Use Ratatui's own word-wrapping implementation. Dividing the display
        // width by the viewport width undercounts lines whenever wrapping leaves
        // unused cells at a word boundary (especially in mixed CJK/Markdown
        // text), which can leave the newest transcript entry behind the composer.
        let visual_lines = paragraph.line_count(inner.width);
        let viewport = inner.height as usize;
        let max_scroll = visual_lines.saturating_sub(viewport).min(u16::MAX as usize) as u16;
        self.max_scroll = max_scroll;
        if self.follow_tail {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }
        let paragraph = paragraph.scroll((self.scroll, 0));
        frame.render_widget(paragraph, inner);
    }

    fn render_composer(&self, frame: &mut Frame<'_>, area: Rect, show_cursor: bool) {
        let text = self.composer.text();
        let content = if text.is_empty() {
            vec![Line::from(vec![
                Span::styled(
                    COMPOSER_PREFIX,
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    self.tr("Type a message…", "输入消息…"),
                    Style::default().fg(self.theme.text_muted),
                ),
            ])]
        } else {
            text.split('\n')
                .enumerate()
                .map(|(index, line)| {
                    Line::from(vec![
                        Span::styled(
                            if index == 0 {
                                COMPOSER_PREFIX.to_string()
                            } else {
                                " ".repeat(UnicodeWidthStr::width(COMPOSER_PREFIX))
                            },
                            Style::default()
                                .fg(self.theme.focus)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            line.to_string(),
                            Style::default()
                                .fg(self.theme.brand)
                                .add_modifier(Modifier::BOLD),
                        ),
                    ])
                })
                .collect::<Vec<_>>()
        };
        let horizontal_margin = content_horizontal_margin(area.width);
        let box_area = inset_rect(area, horizontal_margin, 0);
        let composer_block = Block::default()
            .title_bottom(
                Line::from(format!(
                    " {} · Alt+S ",
                    match self.permission_mode {
                        PermissionMode::AutoReview => self.tr("Auto Approval", "自动审批"),
                        PermissionMode::RequestApproval => {
                            self.tr("Request Approval", "请求审批")
                        }
                        PermissionMode::FullAccess => self.tr("Full Access", "完全访问"),
                        PermissionMode::Custom => self.tr("Custom Permissions", "自定义权限"),
                    }
                ))
                .style(Style::default().fg(self.theme.text_muted))
                .right_aligned(),
            )
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(if self.focus == UiFocus::Composer {
                self.theme.border_strong
            } else {
                self.theme.border_subtle
            }))
            .padding(ratatui::widgets::Padding::horizontal(1));
        let inner = composer_block.inner(box_area);
        frame.render_widget(composer_block, box_area);
        frame.render_widget(Paragraph::new(content), inner);
        if show_cursor
            && self.focus == UiFocus::Composer
            && self.pending_approval.is_none()
            && !self.show_help
            && !self.show_objectives
            && !self.show_sessions
            && !self.show_control
            && self.info_panel.is_none()
        {
            let (row, column) = self.composer.row_col();
            let x = inner
                .x
                .saturating_add(UnicodeWidthStr::width(COMPOSER_PREFIX) as u16)
                .saturating_add(column as u16)
                .min(inner.right().saturating_sub(1));
            let y = inner
                .y
                .saturating_add(row as u16)
                .min(inner.bottom().saturating_sub(1));
            frame.set_cursor_position((x, y));
        }
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let horizontal_margin = content_horizontal_margin(area.width);
        let inner = inset_rect(area, horizontal_margin, 0);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(58), Constraint::Percentage(42)])
            .split(inner);
        if self.busy && self.cancel_confirmation_armed {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled("●  ", Style::default().fg(self.theme.warning)),
                    Span::styled(
                        self.tr("Cancel the current session task?", "取消当前会话任务？"),
                        Style::default()
                            .fg(self.theme.warning)
                            .add_modifier(Modifier::BOLD),
                    ),
                ])),
                columns[0],
            );
            frame.render_widget(
                Paragraph::new(self.tr(
                    "Press Esc again to confirm  ·  any other key to continue",
                    "再按 Esc 确认  ·  按其他键继续",
                ))
                .style(Style::default().fg(self.theme.warning))
                .alignment(Alignment::Right),
                columns[1],
            );
            return;
        }
        let hints = if area.width < 112 {
            self.tr("Ctrl+P Control · ? Help", "Ctrl+P 控制 · ? 帮助")
        } else if self.active_view == UiView::Tasks && self.focus == UiFocus::Content {
            self.tr(
                "↑↓ · D diagnostics · Tab · Ctrl+P Control",
                "↑↓ · D 诊断 · Tab · Ctrl+P 控制",
            )
        } else if self.active_view == UiView::Mind && self.focus == UiFocus::Content {
            self.tr(
                "↑↓ select · Tab · Ctrl+P Control",
                "↑↓ 选择 · Tab · Ctrl+P 控制",
            )
        } else if self.active_view != UiView::Conversation {
            self.tr(
                "Tab content · Ctrl+P Control · ? help",
                "Tab 内容 · Ctrl+P 控制 · ? 帮助",
            )
        } else {
            self.tr(
                "Ctrl+P Control · Ctrl+T Tasks · Ctrl+K Mind",
                "Ctrl+P 控制 · Ctrl+T 任务 · Ctrl+K 认知",
            )
        };
        let mut state = if self.busy {
            self.cognitive_activity_spans(true)
        } else {
            vec![Span::styled("● ", Style::default().fg(self.theme.success))]
        };
        state.extend([
            Span::styled(
                self.status.clone(),
                Style::default().fg(self.theme.text_secondary),
            ),
            Span::styled("  ·  ", Style::default().fg(self.theme.border_subtle)),
            Span::styled(
                self.model.clone(),
                Style::default().fg(self.theme.text_muted),
            ),
        ]);
        if area.width >= 140 {
            let (frames, version, tokens, hard_limit) = self
                .context_view
                .as_ref()
                .map(|view| {
                    (
                        view.state.frames.len(),
                        view.state.version,
                        view.pressure.estimated_tokens,
                        view.pressure.hard_limit,
                    )
                })
                .unwrap_or_default();
            state.push(Span::styled(
                if self.locale.is_chinese() {
                    format!(
                        "  ·  {frames} 帧 · {} / {} · r{version}",
                        compact_count(tokens),
                        compact_count(hard_limit)
                    )
                } else {
                    format!(
                        "  ·  {frames} frames · {} / {} · r{version}",
                        compact_count(tokens),
                        compact_count(hard_limit)
                    )
                },
                Style::default().fg(self.theme.text_muted),
            ));
        }
        if area.width < 92 {
            frame.render_widget(Paragraph::new(Line::from(state)), columns[0]);
            frame.render_widget(
                Paragraph::new(hints)
                    .style(Style::default().fg(self.theme.text_muted))
                    .alignment(Alignment::Right),
                columns[1],
            );
            return;
        }

        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(40),
                Constraint::Percentage(26),
                Constraint::Percentage(34),
            ])
            .split(inner);
        frame.render_widget(Paragraph::new(Line::from(state)), columns[0]);
        let session_label = self
            .session_title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
            .map(|title| truncate(title, 22))
            .unwrap_or_else(|| short_id(&self.session_id));
        let location = if area.width >= 180 {
            format!(
                "{} / {} / {}  ·  {}",
                short_id(&self.agent_id),
                short_id(&self.context_id),
                session_label,
                self.working_directory
            )
        } else {
            format!("{} / {}", short_id(&self.context_id), session_label)
        };
        frame.render_widget(
            Paragraph::new(location)
                .style(Style::default().fg(self.theme.text_muted))
                .alignment(Alignment::Center),
            columns[1],
        );
        frame.render_widget(
            Paragraph::new(hints)
                .style(Style::default().fg(self.theme.text_muted))
                .alignment(Alignment::Right),
            columns[2],
        );
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let help_lines = if self.locale.is_chinese() {
            vec![
                Line::from("键盘快捷键"),
                Line::from("  Enter 默认发送  ·  Option+Enter 并发发送"),
                Line::from("  Ctrl/Command+Enter 跟进  ·  Shift+Enter/Ctrl+J 换行"),
                Line::from(""),
                Line::from("导航与视图"),
                Line::from("  ? 帮助  ·  Alt+T 主题  ·  Alt+S 权限  ·  Ctrl+G 会话"),
                Line::from("  Ctrl+T 任务  ·  Ctrl+K 认知帧  ·  Ctrl+P 控制"),
                Line::from("  Tab 切换焦点  ·  ↑/↓ 选择  ·  Home/End 首项/末项"),
                Line::from("  D 任务诊断  ·  Ctrl+O 目标  ·  Ctrl+R 推理摘要"),
                Line::from("  PageUp/PageDown 滚动/跨页  ·  Ctrl+Home/End 对话首尾"),
                Line::from("  Esc 返回/二次确认取消  ·  Ctrl+C 取消/退出  ·  Ctrl+D 退出"),
                Line::from(""),
                Line::from("鼠标拖选使用终端原生选择与复制；Morphz 默认不捕获鼠标。"),
                Line::from(""),
                Line::from("控制面"),
                Line::from("  Ctrl+P 搜索并执行当前可用操作；Composer 中的 / 始终作为消息发送。"),
                Line::from("  内嵌终端中 Ctrl+P 保持 Shell 历史语义；按 Ctrl+] 返回 Morphz。"),
                Line::from(""),
                Line::from("按 Esc 或 ? 关闭。"),
            ]
        } else {
            vec![
                Line::from("Keyboard shortcuts"),
                Line::from("  Enter default  ·  Option+Enter parallel"),
                Line::from("  Ctrl/Command+Enter follow-up  ·  Shift+Enter/Ctrl+J newline"),
                Line::from(""),
                Line::from("Navigation and views"),
                Line::from("  ? help  ·  Alt+T theme  ·  Alt+S permissions  ·  Ctrl+G Sessions"),
                Line::from("  Ctrl+T Tasks  ·  Ctrl+K Mind  ·  Ctrl+P Control"),
                Line::from("  Tab focus  ·  ↑/↓ select  ·  Home/End first/last"),
                Line::from("  D diagnostics  ·  Ctrl+O Objectives  ·  Ctrl+R reasoning"),
                Line::from("  PageUp/PageDown scroll/page  ·  Ctrl+Home/End transcript ends"),
                Line::from("  Esc back/cancel confirmation  ·  Ctrl+C cancel/quit  ·  Ctrl+D quit"),
                Line::from(""),
                Line::from("Mouse drag uses native terminal selection and copy; Morphz does not capture it."),
                Line::from(""),
                Line::from("Control plane"),
                Line::from("  Ctrl+P searches and runs available actions; / in Composer is always message text."),
                Line::from("  Inside the embedded shell Ctrl+P keeps shell-history semantics; Ctrl+] returns to Morphz."),
                Line::from(""),
                Line::from("Press Esc or ? to close."),
            ]
        };
        let help = Paragraph::new(help_lines)
            .block(
                Block::default()
                    .title(self.tr(" Keyboard shortcuts ", " 键盘快捷键 "))
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.focus))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().fg(self.theme.text_primary));
        frame.render_widget(help, area);
    }

    fn render_objectives(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let mut lines = vec![Line::from(vec![
            Span::styled(
                self.tr("Objectives", "目标"),
                Style::default()
                    .fg(self.theme.brand)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                if self.locale.is_chinese() {
                    format!("  {} 个非终态目标", self.objectives.len())
                } else {
                    format!("  {} non-terminal", self.objectives.len())
                },
                Style::default().fg(self.theme.text_muted),
            ),
        ])];
        lines.push(Line::from(""));
        if self.objectives.is_empty() {
            lines.push(Line::from(Span::styled(
                self.tr(
                    "The current context has no active, paused, or blocked objectives.",
                    "当前上下文没有进行中、暂停或受阻的目标。",
                ),
                Style::default().fg(self.theme.text_muted),
            )));
        } else {
            for objective in ordered_objectives(&self.objectives, &self.session_id) {
                let status = localized_objective_status(self.locale, objective.status);
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{} ", objective_status_marker(objective.status)),
                        Style::default()
                            .fg(objective_status_color(objective.status, &self.theme))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        status,
                        Style::default()
                            .fg(objective_status_color(objective.status, &self.theme))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {}", short_id(&objective.id)),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
                for statement_line in objective.stated_objective.lines() {
                    lines.push(Line::from(Span::styled(
                        format!("   {statement_line}"),
                        Style::default().fg(self.theme.text_primary),
                    )));
                }
                if let Some(reason) = objective.status_reason.as_deref() {
                    for reason_line in reason.lines() {
                        lines.push(Line::from(vec![
                            Span::styled(
                                self.tr("   Reason  ", "   原因  "),
                                Style::default().fg(self.theme.text_muted),
                            ),
                            Span::styled(reason_line, Style::default().fg(self.theme.text_primary)),
                        ]));
                    }
                }
                let mut facts = vec![if self.locale.is_chinese() {
                    format!("修订 {}", objective.revision)
                } else {
                    format!("revision {}", objective.revision)
                }];
                if objective.coordinator_session_id == self.session_id {
                    facts.push(self.tr("current session", "当前会话").to_string());
                } else {
                    facts.push(if self.locale.is_chinese() {
                        format!("会话 {}", short_id(&objective.coordinator_session_id))
                    } else {
                        format!("session {}", short_id(&objective.coordinator_session_id))
                    });
                }
                if let Some(wait) = objective.wait_condition.as_ref() {
                    facts.push(format!(
                        "{}: {}",
                        self.tr("waiting", "等待"),
                        format_objective_wait(wait, self.locale)
                    ));
                } else if objective.active_evaluation_id.is_some() {
                    facts.push(self.tr("evaluation running", "求值正在进行").to_string());
                }
                if let Some(budget) = objective.token_budget {
                    facts.push(format!("{} / {} tok", objective.tokens_used, budget));
                } else if objective.tokens_used > 0 {
                    facts.push(format!("{} tok", objective.tokens_used));
                }
                if objective.time_used_seconds > 0 {
                    facts.push(format_duration_localized(
                        objective.time_used_seconds,
                        self.locale,
                    ));
                }
                lines.push(Line::from(Span::styled(
                    format!("   {}", facts.join("  ·  ")),
                    Style::default().fg(self.theme.text_muted),
                )));
                if let Some(parent) = objective.parent_objective_id.as_deref() {
                    lines.push(Line::from(Span::styled(
                        if self.locale.is_chinese() {
                            format!("   子目标，父目标为 {}", short_id(parent))
                        } else {
                            format!("   child of {}", short_id(parent))
                        },
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines.push(Line::from(""));
            }
        }
        lines.push(Line::from(Span::styled(
            self.tr(
                "Ctrl+O / Esc to close  ·  PageUp / PageDown to scroll",
                "按 Ctrl+O 或 Esc 收起  ·  按 PageUp 或 PageDown 滚动",
            ),
            Style::default().fg(self.theme.text_muted),
        )));
        let panel = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((self.objective_scroll, 0))
            .block(
                Block::default()
                    .title(self.tr(" Context Objectives ", " 上下文目标 "))
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.focus))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().fg(self.theme.text_primary));
        frame.render_widget(panel, area);
    }

    fn render_control(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let block = Block::default()
            .title(self.tr(" Control ", " 控制 "))
            .title_bottom(Line::from(self.tr(
                " ↑/↓ select  ·  Enter run  ·  Esc close ",
                " ↑/↓ 选择  ·  Enter 执行  ·  Esc 关闭 ",
            )))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(self.theme.focus))
            .padding(ratatui::widgets::Padding::uniform(1));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if inner.width == 0 || inner.height == 0 {
            return;
        }

        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Min(1),
                Constraint::Length(1),
            ])
            .split(inner);
        let query = self.control_input.text();
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    self.tr("Control › ", "控制 › "),
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(query.clone(), Style::default().fg(self.theme.text_primary)),
                if query.is_empty() {
                    Span::styled(
                        self.tr("Search actions…", "搜索操作…"),
                        Style::default().fg(self.theme.text_muted),
                    )
                } else {
                    Span::raw("")
                },
            ])),
            rows[0],
        );
        frame.render_widget(
            Paragraph::new("─".repeat(usize::from(rows[1].width)))
                .style(Style::default().fg(self.theme.border_subtle)),
            rows[1],
        );

        let items = self.filtered_control_items();
        let visible_items = usize::from(rows[2].height / 2).max(1);
        let scroll = self
            .control_selection
            .saturating_add(1)
            .saturating_sub(visible_items);
        let mut lines = Vec::new();
        if items.is_empty() {
            lines.push(Line::from(Span::styled(
                self.tr("No matching actions", "没有匹配的操作"),
                Style::default().fg(self.theme.text_muted),
            )));
        } else {
            for (index, item) in items.iter().enumerate().skip(scroll).take(visible_items) {
                let selected = index == self.control_selection;
                let primary = if item.enabled {
                    if selected {
                        self.theme.focus
                    } else {
                        self.theme.text_primary
                    }
                } else {
                    self.theme.text_muted
                };
                let mut headline = vec![
                    Span::styled(
                        if selected { "▌ " } else { "  " },
                        Style::default().fg(if selected {
                            self.theme.focus
                        } else {
                            self.theme.border_subtle
                        }),
                    ),
                    Span::styled(
                        item.label.clone(),
                        Style::default().fg(primary).add_modifier(if selected {
                            Modifier::BOLD
                        } else {
                            Modifier::empty()
                        }),
                    ),
                    Span::styled(
                        format!("  {}", item.command),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ];
                if let Some(shortcut) = item.shortcut {
                    headline.push(Span::styled(
                        format!("  {shortcut}"),
                        Style::default().fg(self.theme.brand),
                    ));
                }
                lines.push(Line::from(headline));
                lines.push(Line::from(vec![
                    Span::raw("    "),
                    Span::styled(
                        item.disabled_reason
                            .as_deref()
                            .unwrap_or(item.description.as_str())
                            .to_string(),
                        Style::default().fg(if item.enabled {
                            self.theme.text_secondary
                        } else {
                            self.theme.warning
                        }),
                    ),
                ]));
            }
        }
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), rows[2]);
        let feedback = self.control_feedback.as_deref().unwrap_or_else(|| {
            self.tr(
                "Composer draft is preserved; Control actions never enter the dialogue.",
                "Composer 草稿保持不变；控制操作不会进入对话。",
            )
        });
        frame.render_widget(
            Paragraph::new(feedback).style(Style::default().fg(
                if self.control_feedback.is_some() {
                    self.theme.warning
                } else {
                    self.theme.text_muted
                },
            )),
            rows[3],
        );

        let (_, column) = self.control_input.row_col();
        frame.set_cursor_position((
            rows[0]
                .x
                .saturating_add(UnicodeWidthStr::width(self.tr("Control › ", "控制 › ")) as u16)
                .saturating_add(column as u16)
                .min(rows[0].right().saturating_sub(1)),
            rows[0].y,
        ));
    }

    fn render_info_panel(&self, frame: &mut Frame<'_>, area: Rect) {
        let Some(panel) = self.info_panel.as_ref() else {
            return;
        };
        frame.render_widget(Clear, area);
        let content = if panel.formatted_sexpr {
            sexpr_reader_lines(&panel.body, &self.theme)
        } else {
            panel
                .body
                .lines()
                .map(|line| Line::from(line.to_string()))
                .collect()
        };
        frame.render_widget(
            Paragraph::new(content)
                .wrap(Wrap { trim: false })
                .scroll((self.info_scroll, 0))
                .block(
                    Block::default()
                        .title(format!(" {} ", panel.title))
                        .title_bottom(Line::from(self.tr(
                            " PageUp/PageDown scroll  ·  Esc close ",
                            " PageUp/PageDown 滚动  ·  Esc 关闭 ",
                        )))
                        .borders(Borders::ALL)
                        .border_type(BorderType::Rounded)
                        .border_style(Style::default().fg(self.theme.focus))
                        .padding(ratatui::widgets::Padding::uniform(1)),
                )
                .style(Style::default().fg(self.theme.text_primary)),
            area,
        );
    }

    fn render_approval(&self, frame: &mut Frame<'_>, area: Rect) {
        let Some(approval) = &self.pending_approval else {
            return;
        };
        frame.render_widget(Clear, area);
        let body = format!(
            "{}\n\n{}",
            approval.text,
            self.tr("[y] Allow once    [n] Deny", "[y] 允许一次    [n] 拒绝")
        );
        let dialog = Paragraph::new(body)
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(self.tr(" Permission approval ", " 权限审批 "))
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.warning))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().fg(self.theme.text_primary));
        frame.render_widget(dialog, area);
    }

    fn render_sessions(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let mut lines = Vec::new();
        if self.sessions.is_empty() {
            lines.extend([
                Line::from(""),
                Line::from(Span::styled(
                    self.tr("No active Sessions are visible", "没有可见的活跃会话"),
                    Style::default().fg(self.theme.text_secondary),
                )),
            ]);
        } else {
            for (index, session) in self.sessions.iter().enumerate() {
                let selected = index == self.session_selection;
                let current = session.id == self.session_id;
                lines.push(Line::from(vec![
                    Span::styled(
                        if selected { "▌ " } else { "  " },
                        Style::default().fg(if selected {
                            self.theme.focus
                        } else {
                            self.theme.border_subtle
                        }),
                    ),
                    Span::styled(
                        if current { "● " } else { "○ " },
                        Style::default().fg(if current {
                            self.theme.success
                        } else {
                            self.theme.text_muted
                        }),
                    ),
                    Span::styled(
                        truncate(&session.title, 36),
                        Style::default()
                            .fg(self.theme.text_primary)
                            .add_modifier(if selected {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                    Span::styled(
                        format!("  {}", short_id(&session.id)),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
                lines.push(Line::from(vec![
                    Span::raw("      "),
                    Span::styled(
                        format!(
                            "{}  ·  {}  ·  {}",
                            short_id(&session.context_id),
                            short_id(&session.agent_id),
                            crate::local_time::format_utc_for_local(session.last_activity_at)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
        }
        let title = if self.locale.is_chinese() {
            format!(" 会话  {} ", self.sessions.len())
        } else {
            format!(" Sessions  {} ", self.sessions.len())
        };
        let visible_rows = usize::from(area.height.saturating_sub(4)).max(1);
        let selected_row = self.session_selection.saturating_mul(2);
        let scroll = selected_row
            .saturating_add(2)
            .saturating_sub(visible_rows)
            .min(u16::MAX as usize) as u16;
        let dialog = Paragraph::new(lines)
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(title)
                    .title_bottom(Line::from(self.tr(
                        " ↑/↓ select  ·  Enter switch  ·  Esc close ",
                        " ↑/↓ 选择  ·  Enter 切换  ·  Esc 关闭 ",
                    )))
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.focus))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            );
        frame.render_widget(dialog, area);
    }
}

enum UiAction {
    None,
    Submit {
        text: String,
        dispatch_mode: Option<MessageDispatchMode>,
    },
    OpenControl,
    ExecuteControl(ControlAction),
    SwitchSession(String),
    Approve(bool),
}

enum ControlEffect {
    None,
    OpenShell,
    Quit,
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    keyboard_enhancement_enabled: bool,
    detected_appearance: Option<TerminalAppearance>,
}

impl TerminalSession {
    fn enter() -> Result<Self, TuiError> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        let detected_appearance = query_terminal_appearance();
        let keyboard_enhancement_enabled = supports_keyboard_enhancement().unwrap_or(false);
        drain_terminal_probe_events();
        // Do not enable Crossterm mouse capture here. Native terminal drag
        // selection and copy are part of the TUI interaction contract; every
        // application-level navigation path therefore has a keyboard binding.
        execute!(stdout, EnterAlternateScreen, EnableBracketedPaste)?;
        if keyboard_enhancement_enabled {
            execute!(
                stdout,
                PushKeyboardEnhancementFlags(keyboard_enhancement_flags())
            )?;
        }
        let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        terminal.show_cursor()?;
        Ok(Self {
            terminal,
            keyboard_enhancement_enabled,
            detected_appearance,
        })
    }
}

fn keyboard_enhancement_flags() -> KeyboardEnhancementFlags {
    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
        | KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES
        | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
        | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        if self.keyboard_enhancement_enabled {
            let _ = execute!(self.terminal.backend_mut(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(
            self.terminal.backend_mut(),
            Show,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = self.terminal.show_cursor();
    }
}

/// Runs the full-screen terminal frontend. Streamed assistant text is transient until the
/// Runtime commits the corresponding `chat/reply` terminal fact.
pub async fn run(
    runtime: MorphzRuntime,
    mut session: SessionHandle,
    initial_prompt: Option<String>,
    initial_harness: Option<crate::harness::ExactHarnessRef>,
) -> Result<(), TuiError> {
    let mut state = UiState::new(&runtime, &session);
    if let Ok(Some(record)) = session.record().await {
        state.model = effective_tui_session_model(&runtime, &record);
        state.permission_mode = effective_tui_session_permission_mode(&runtime, &record);
        state.context_id = record.context_id;
        state.session_title = Some(record.title);
    }
    let history = session.events(None).await.unwrap_or_default();
    for event in &history {
        state.ingest_history(event);
    }
    let mut durable_event_cursor = history
        .iter()
        .filter_map(|event| event.sequence)
        .max()
        .unwrap_or_default();
    let mut recent_event_ids = RecentTuiEventIds::default();
    for event in &history {
        recent_event_ids.insert(event.id.clone());
    }
    if let Ok(view) = session.inspect_context_view().await {
        state.update_context(&view);
    }
    if let Ok(delegations) = runtime.list_delegations().await {
        state.delegations = delegations;
    }
    if let Ok(model_options) = runtime.inference_model_options().await {
        state.model_options = model_options;
    }
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    if let Ok(sessions) = sdk.list_sessions(&principal.principal_id, false).await {
        state.set_sessions(sessions);
    }

    let mut runtime_events = runtime.subscribe("*", 2_048);
    let mut pending_harness = initial_harness;
    if let Some(prompt) = initial_prompt.filter(|value| !value.trim().is_empty()) {
        submit_prompt(
            &runtime,
            &session,
            &mut state,
            prompt,
            pending_harness.take(),
            None,
        )
        .await;
    }

    let mut terminal = TerminalSession::enter()?;
    if let Some(appearance) = terminal.detected_appearance {
        state.set_appearance(appearance);
    }
    let mut input_events = EventStream::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(80));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut durable_event_tick = tokio::time::interval(std::time::Duration::from_millis(500));
    durable_event_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let shell_cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let mut embedded_shell: Option<shell::EmbeddedShell> = None;
    let mut shell_visible = false;

    loop {
        if let Some(shell) = embedded_shell.as_mut() {
            shell.poll();
        }
        if shell_visible
            && embedded_shell
                .as_mut()
                .is_some_and(shell::EmbeddedShell::is_finished)
        {
            shell_visible = false;
            embedded_shell = None;
        }
        terminal.terminal.draw(|frame| {
            if shell_visible && state.pending_approval.is_none() {
                state.render_with_composer_cursor(frame, false);
                if let Some(shell) = embedded_shell.as_mut() {
                    shell.render(frame, state.theme);
                }
            } else {
                state.render(frame);
            }
        })?;
        tokio::select! {
            maybe_event = input_events.next() => {
                let Some(event) = maybe_event else { break; };
                match event? {
                    Event::Key(key) if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
                        if shell_visible && state.pending_approval.is_none() {
                            if is_shell_escape_key(key) {
                                shell_visible = false;
                            } else if let Some(shell) = embedded_shell.as_mut() {
                                shell.send_key(key);
                            }
                            continue;
                        }
                        match key_action(&mut state, key) {
                            UiAction::None => {}
                            UiAction::Approve(allow) => {
                                if let Some(approval) = state.pending_approval.take() {
                                    let decision = if allow {
                                        ApprovalDecision::AllowOnce {
                                            rationale: state.tr(
                                                "The user approved in the Morphz terminal interface",
                                                "用户已在 Morphz 终端界面中批准",
                                            ).to_string(),
                                            risk_tags: vec!["human-approved".to_string()],
                                        }
                                    } else {
                                        ApprovalDecision::Deny {
                                            rationale: state.tr(
                                                "The user denied in the Morphz terminal interface",
                                                "用户已在 Morphz 终端界面中拒绝",
                                            ).to_string(),
                                            risk_tags: vec!["human-denied".to_string()],
                                        }
                                    };
                                    match runtime.decide_approval(&approval.id, decision).await {
                                        Ok(()) => state.push(EntryKind::System, if allow {
                                            state.tr("Permission approved once.", "权限请求已批准一次。")
                                        } else {
                                            state.tr("Permission request denied.", "权限请求已拒绝。")
                                        }),
                                        Err(error) => state.push(EntryKind::Error, error),
                                    }
                                }
                            }
                            UiAction::Submit { text, dispatch_mode } => {
                                submit_prompt(
                                    &runtime,
                                    &session,
                                    &mut state,
                                    text,
                                    pending_harness.take(),
                                    dispatch_mode,
                                )
                                .await;
                            }
                            UiAction::OpenControl => {
                                if let Ok(model_options) = runtime.inference_model_options().await {
                                    state.model_options = model_options;
                                }
                                state.tool_names = runtime.tool_names();
                                state.open_control();
                            }
                            UiAction::ExecuteControl(action) => {
                                match execute_control_action(&runtime, &session, &mut state, action).await {
                                    ControlEffect::None => {}
                                    ControlEffect::Quit => break,
                                    ControlEffect::OpenShell => {
                                        let needs_shell = embedded_shell
                                            .as_mut()
                                            .is_none_or(shell::EmbeddedShell::is_finished);
                                        if needs_shell {
                                            match shell::EmbeddedShell::spawn(&shell_cwd) {
                                                Ok(shell) => embedded_shell = Some(shell),
                                                Err(error) => {
                                                    state.status = if state.locale.is_chinese() {
                                                        format!("无法打开内嵌终端：{error}")
                                                    } else {
                                                        format!("Could not open the embedded shell: {error}")
                                                    };
                                                    embedded_shell = None;
                                                }
                                            }
                                        }
                                        shell_visible = embedded_shell.is_some();
                                    }
                                }
                            }
                            UiAction::SwitchSession(session_id) => {
                                if let Err(error) = switch_tui_session(
                                    &runtime,
                                    &mut session,
                                    &mut state,
                                    &session_id,
                                ).await {
                                    state.push(
                                        EntryKind::Error,
                                        if state.locale.is_chinese() {
                                            format!("切换会话失败：{error}")
                                        } else {
                                            format!("Could not switch Session: {error}")
                                        },
                                    );
                                } else if let Ok(history) = session.events(None).await {
                                    for event in history {
                                        if let Some(sequence) = event.sequence {
                                            durable_event_cursor = durable_event_cursor.max(sequence);
                                        }
                                        recent_event_ids.insert(event.id);
                                    }
                                }
                            }
                        }
                    }
                    Event::Paste(text) if shell_visible && state.pending_approval.is_none() => {
                        if let Some(shell) = embedded_shell.as_mut() {
                            shell.send_paste(&text);
                        }
                    }
                    Event::Paste(text) if state.show_control && state.pending_approval.is_none() => {
                        state
                            .control_input
                            .insert_str(&text.replace(['\r', '\n'], " "));
                        state.control_selection = 0;
                        state.control_feedback = None;
                        state.reconcile_control_selection();
                    }
                    Event::Paste(_)
                        if state.pending_approval.is_some()
                            || state.show_help
                            || state.show_objectives
                            || state.show_sessions
                            || state.info_panel.is_some() => {}
                    Event::Paste(text) => {
                        state.focus = UiFocus::Composer;
                        state.composer.insert_str(&text);
                    }
                    _ => {}
                }
            }
            event = runtime_events.recv() => {
                let Some(event) = event else {
                    state.push(EntryKind::Error, state.tr(
                        "The Runtime event channel has closed.",
                        "运行时事件通道已关闭。",
                    ));
                    state.busy = false;
                    continue;
                };
                if let Some(sequence) = event.sequence {
                    durable_event_cursor = durable_event_cursor.max(sequence);
                }
                if recent_event_ids.insert(event.id.clone()) {
                    ingest_tui_runtime_event(&runtime, &session, &mut state, event).await;
                }
            }
            _ = durable_event_tick.tick() => {
                // EventBus is intentionally process-local. Tail the durable
                // Session log as the cross-Runtime observation channel while
                // retaining EventBus for low-latency and transient model deltas.
                if let Ok(events) = session.events(Some(durable_event_cursor)).await {
                    for event in events {
                        if let Some(sequence) = event.sequence {
                            durable_event_cursor = durable_event_cursor.max(sequence);
                        }
                        if recent_event_ids.insert(event.id.clone()) {
                            ingest_tui_runtime_event(&runtime, &session, &mut state, event).await;
                        }
                    }
                }
            }
            _ = tick.tick() => {
                state.spinner = state.spinner.wrapping_add(1);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct RecentTuiEventIds {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentTuiEventIds {
    fn insert(&mut self, event_id: String) -> bool {
        if !self.ids.insert(event_id.clone()) {
            return false;
        }
        self.order.push_back(event_id);
        while self.order.len() > TUI_RECENT_EVENT_ID_CAPACITY {
            if let Some(expired) = self.order.pop_front() {
                self.ids.remove(&expired);
            }
        }
        true
    }
}

async fn ingest_tui_runtime_event(
    runtime: &MorphzRuntime,
    session: &SessionHandle,
    state: &mut UiState,
    event: RuntimeEvent,
) {
    let refresh = matches!(
        event.topic.as_str(),
        "chat/user_message"
            | "chat/reply"
            | "chat/no_reply"
            | "chat/outbound_message"
            | "chat/session_signal"
            | "chat/tool_output"
            | "context/transaction"
            | "runtime/model_attempt_state"
            | "runtime/tool_calls_selected"
            | "runtime/session_restored"
    ) || event.topic.starts_with("objective/");
    state.on_runtime_event(event);
    if refresh {
        if let Ok(view) = session.inspect_context_view().await {
            state.update_context(&view);
        }
        if let Ok(delegations) = runtime.list_delegations().await {
            state.delegations = delegations;
        }
    }
}

fn effective_tui_session_model(runtime: &MorphzRuntime, record: &SessionRecord) -> String {
    record
        .model_alias
        .clone()
        .unwrap_or_else(|| runtime.model())
}

fn effective_tui_session_permission_mode(
    runtime: &MorphzRuntime,
    record: &SessionRecord,
) -> PermissionMode {
    if let Some(mode) = record.permission_mode {
        return mode;
    }
    match record.sandbox_mode {
        Some(SandboxMode::DangerFullAccess) => PermissionMode::FullAccess,
        Some(sandbox_mode) => {
            let (_, approval_policy, reviewer) = runtime.config().permissions.preset();
            PermissionMode::from_effective_controls(sandbox_mode, approval_policy, reviewer)
        }
        None => runtime.config().permissions.effective_mode(),
    }
}

async fn persist_tui_session_model(
    runtime: &MorphzRuntime,
    session_id: &str,
    model: &str,
) -> Result<SessionRecord, RuntimeError> {
    let model = model.trim();
    let options = runtime.inference_model_options().await?;
    if !options.iter().any(|option| option.id == model) {
        return Err(format!(
            "model '{model}' is not present in the discovered and enabled model catalog"
        )
        .into());
    }
    runtime
        .update_session(
            session_id,
            SessionUpdate {
                model_alias: Some(Some(model.to_string())),
                ..SessionUpdate::default()
            },
        )
        .await?
        .ok_or_else(|| format!("Session '{session_id}' does not exist").into())
}

async fn persist_tui_session_reasoning_effort(
    runtime: &MorphzRuntime,
    session_id: &str,
    effort: Option<ReasoningEffort>,
) -> Result<SessionRecord, RuntimeError> {
    runtime
        .update_session(
            session_id,
            SessionUpdate {
                reasoning_effort: Some(effort.map(|value| value.as_str().to_string())),
                ..SessionUpdate::default()
            },
        )
        .await?
        .ok_or_else(|| format!("Session '{session_id}' does not exist").into())
}

async fn persist_tui_session_permission_mode(
    runtime: &MorphzRuntime,
    session_id: &str,
    permission_mode: PermissionMode,
) -> Result<SessionRecord, RuntimeError> {
    runtime
        .update_session(
            session_id,
            SessionUpdate {
                permission_mode: Some(Some(permission_mode)),
                ..SessionUpdate::default()
            },
        )
        .await?
        .ok_or_else(|| format!("Session '{session_id}' does not exist").into())
}

async fn execute_control_action(
    runtime: &MorphzRuntime,
    session: &SessionHandle,
    state: &mut UiState,
    action: ControlAction,
) -> ControlEffect {
    state.close_control();
    match action {
        ControlAction::ShowHelp => {
            state.close_nonapproval_overlays();
            state.show_help = true;
        }
        ControlAction::ShowConversation => state.set_active_view(UiView::Conversation),
        ControlAction::ShowTasks => state.set_active_view(UiView::Tasks),
        ControlAction::ShowMind => state.set_active_view(UiView::Mind),
        ControlAction::ShowSessions => {
            let sdk = MorphzSdk::new(runtime.clone());
            let principal = sdk.default_principal();
            match sdk.list_sessions(&principal.principal_id, false).await {
                Ok(sessions) => {
                    state.set_sessions(sessions);
                    state.close_nonapproval_overlays();
                    state.show_sessions = true;
                }
                Err(error) => {
                    state.status = if state.locale.is_chinese() {
                        format!("读取会话列表失败：{error}")
                    } else {
                        format!("Could not load Sessions: {error}")
                    };
                }
            }
        }
        ControlAction::ShowObjectives => {
            state.close_nonapproval_overlays();
            state.show_objectives = true;
            state.objective_scroll = 0;
        }
        ControlAction::ShowTools => {
            let mut tools = runtime.tool_names();
            tools.sort();
            tools.dedup();
            let body = if tools.is_empty() {
                state
                    .tr(
                        "Runtime currently exposes no tools.",
                        "Runtime 当前没有暴露工具。",
                    )
                    .to_string()
            } else {
                tools
                    .iter()
                    .enumerate()
                    .map(|(index, name)| format!("{:>3}. {name}", index + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let title = if state.locale.is_chinese() {
                format!("可用工具 · {}", tools.len())
            } else {
                format!("Available tools · {}", tools.len())
            };
            state.show_info_panel(title, body);
        }
        ControlAction::ShowExecutionJobs => {
            let tasks = get_tasks_map();
            let mut jobs = tasks
                .iter()
                .filter(|task| task.context_id == state.context_id)
                .map(|task| {
                    (
                        task.id.clone(),
                        task.session_id.clone(),
                        task.cmd_str.clone(),
                        task.status,
                        task.started_at,
                    )
                })
                .collect::<Vec<_>>();
            jobs.sort_by(|left, right| right.4.cmp(&left.4).then_with(|| left.0.cmp(&right.0)));
            let body = if jobs.is_empty() {
                state
                    .tr(
                        "The current Context has no retained Execution Jobs.",
                        "当前 Context 没有保留的执行任务。",
                    )
                    .to_string()
            } else {
                jobs.iter()
                    .map(|(id, session_id, command, status, started_at)| {
                        format!(
                            "{}  [{}]\n  {} · {}\n  {}",
                            id,
                            localized_background_status(state.locale, *status),
                            state.tr("session", "会话"),
                            short_id(session_id),
                            truncate(&command.replace('\n', " "), 160),
                        ) + &format!(
                            "\n  {}",
                            crate::local_time::format_utc_for_local(*started_at)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n")
            };
            let title = if state.locale.is_chinese() {
                format!("执行任务 · {}", jobs.len())
            } else {
                format!("Execution Jobs · {}", jobs.len())
            };
            state.show_info_panel(title, body);
        }
        ControlAction::ShowDelegations => match runtime.list_delegations().await {
            Ok(delegations) => {
                state.delegations.clone_from(&delegations);
                let body = if delegations.is_empty() {
                    state
                        .tr("There are no subagent delegations.", "当前没有子代理委派。")
                        .to_string()
                } else {
                    delegations
                        .iter()
                        .map(|delegation| {
                            format!(
                                "{}  [{}]\n  {}",
                                delegation.id,
                                localized_delegation_status(state.locale, &delegation.status),
                                delegation.task.replace('\n', " ")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                let title = if state.locale.is_chinese() {
                    format!("子代理委派 · {}", delegations.len())
                } else {
                    format!("Delegations · {}", delegations.len())
                };
                state.show_info_panel(title, body);
            }
            Err(error) => {
                state.status = if state.locale.is_chinese() {
                    format!("读取委派失败：{error}")
                } else {
                    format!("Could not read delegations: {error}")
                };
            }
        },
        ControlAction::InspectContext => match session.inspect_context_view().await {
            Ok(view) => {
                let body = view.sexpr.clone();
                state.update_context(&view);
                state.show_sexpr_panel(state.tr("Context encoding", "Context 编码"), body);
            }
            Err(error) => {
                state.status = if state.locale.is_chinese() {
                    format!("读取 Context 失败：{error}")
                } else {
                    format!("Could not inspect the Context: {error}")
                };
            }
        },
        ControlAction::OpenShell => return ControlEffect::OpenShell,
        ControlAction::SetToolDetails(show) => {
            state.show_tool_details = show;
            state.status = if show {
                state.tr("tool details shown", "已展开工具详情")
            } else {
                state.tr("tool details hidden", "已收起工具详情")
            }
            .to_string();
        }
        ControlAction::SetReasoningDetails(show) => {
            state.show_reasoning_details = show;
            state.follow_tail = true;
            state.status = if show {
                state.tr("reasoning summaries shown", "已展开推理摘要")
            } else {
                state.tr("reasoning summaries hidden", "已收起推理摘要")
            }
            .to_string();
        }
        ControlAction::CycleTheme => {
            let theme = state.cycle_theme();
            state.status = if state.locale.is_chinese() {
                format!("主题 · {}", theme.as_str())
            } else {
                format!("theme · {}", theme.as_str())
            };
        }
        ControlAction::SetTheme(theme) => {
            state.set_theme(theme);
            state.status = if state.locale.is_chinese() {
                format!("主题 · {}", theme.as_str())
            } else {
                format!("theme · {}", theme.as_str())
            };
        }
        ControlAction::SetModel(model) => {
            match persist_tui_session_model(runtime, session.id(), &model).await {
                Ok(record) => {
                    state.model = effective_tui_session_model(runtime, &record);
                    state.status = if state.locale.is_chinese() {
                        format!("当前会话模型 · {}", state.model)
                    } else {
                        format!("Session model · {}", state.model)
                    };
                }
                Err(error) => {
                    state.status = if state.locale.is_chinese() {
                        format!("切换模型失败：{error}")
                    } else {
                        format!("Could not switch model: {error}")
                    };
                }
            }
        }
        ControlAction::SetReasoningEffort(effort) => {
            match persist_tui_session_reasoning_effort(runtime, session.id(), effort).await {
                Ok(_) => {
                    let value = effort.map(ReasoningEffort::as_str).unwrap_or("default");
                    state.status = if state.locale.is_chinese() {
                        format!("当前会话推理强度 · {value}")
                    } else {
                        format!("Session reasoning effort · {value}")
                    };
                }
                Err(error) => {
                    state.status = if state.locale.is_chinese() {
                        format!("设置推理强度失败：{error}")
                    } else {
                        format!("Could not set reasoning effort: {error}")
                    };
                }
            }
        }
        ControlAction::SetPermissionMode(permission_mode) => {
            match persist_tui_session_permission_mode(runtime, session.id(), permission_mode).await
            {
                Ok(record) => {
                    state.permission_mode = effective_tui_session_permission_mode(runtime, &record);
                    state.status = if state.locale.is_chinese() {
                        format!("当前会话权限 · {} · 已立即生效", permission_mode.as_str())
                    } else {
                        format!(
                            "Session permissions · {} · effective now",
                            permission_mode.as_str()
                        )
                    };
                }
                Err(error) => {
                    state.status = if state.locale.is_chinese() {
                        format!("切换权限预设失败：{error}")
                    } else {
                        format!("Could not switch permission preset: {error}")
                    };
                }
            }
        }
        ControlAction::CancelEvaluation => {
            state.status = match session
                .cancel_durable("Session evaluation cancelled from terminal UI")
                .await
            {
                Ok(cancelled) if cancelled > 0 => state
                    .tr("cancelling current evaluation", "正在取消当前求值")
                    .to_string(),
                Ok(_) => state
                    .tr("nothing to cancel", "没有可取消的求值")
                    .to_string(),
                Err(error) => {
                    if state.locale.is_chinese() {
                        format!("取消求值失败：{error}")
                    } else {
                        format!("Could not cancel evaluation: {error}")
                    }
                }
            };
        }
        ControlAction::ClearView => {
            state.entries.clear();
            state.live_attempts.clear();
            state.status = state
                .tr(
                    "local transcript cleared · durable history unchanged",
                    "已清空本地显示 · 持久历史未改变",
                )
                .to_string();
        }
        ControlAction::Quit => return ControlEffect::Quit,
    }
    ControlEffect::None
}

async fn switch_tui_session(
    runtime: &MorphzRuntime,
    session: &mut SessionHandle,
    state: &mut UiState,
    target_session_id: &str,
) -> Result<(), TuiError> {
    if target_session_id == session.id() {
        state.show_sessions = false;
        state.focus = UiFocus::Composer;
        return Ok(());
    }

    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    let record = sdk
        .get_session(&principal.principal_id, target_session_id)
        .await?;
    if record.status == SessionStatus::Archived {
        return Err(format!("Session '{}' is archived", record.id).into());
    }
    let target = runtime.session(record.id.clone());
    let history = target.events(None).await?;
    let context_view = target.inspect_context_view().await?;
    let delegations = runtime.list_delegations().await?;
    let sessions = sdk.list_sessions(&principal.principal_id, false).await?;

    state
        .session_drafts
        .insert(session.id().to_string(), state.composer.text());
    let target_draft = state.session_drafts.remove(target_session_id);
    state.agent_id.clone_from(&record.agent_id);
    state.context_id.clone_from(&record.context_id);
    state.session_id.clone_from(&record.id);
    state.model = effective_tui_session_model(runtime, &record);
    state.permission_mode = effective_tui_session_permission_mode(runtime, &record);
    state.session_title = Some(record.title);
    state.entries.clear();
    state.live_attempts.clear();
    state.objectives.clear();
    state.context_view = None;
    state.delegations = delegations;
    state.selected_objective_id = None;
    state.selected_frame_id = None;
    state.composer.clear();
    if let Some(draft) = target_draft {
        state.composer.insert_str(&draft);
    }
    state.scroll = 0;
    state.max_scroll = 0;
    state.follow_tail = true;
    state.view_scroll = 0;
    state.close_nonapproval_overlays();
    state.cancel_confirmation_armed = false;
    for event in &history {
        state.ingest_history(event);
    }
    let busy = context_view
        .active_activations
        .iter()
        .any(|activation| activation.session_id == record.id);
    state.update_context(&context_view);
    state.busy = busy;
    state.status = if busy {
        state.tr("running", "执行中")
    } else {
        state.tr("ready", "就绪")
    }
    .to_string();
    state.set_sessions(sessions);
    state.set_active_view(UiView::Conversation);
    *session = target;
    Ok(())
}

async fn submit_prompt(
    runtime: &MorphzRuntime,
    session: &SessionHandle,
    state: &mut UiState,
    prompt: String,
    harness: Option<crate::harness::ExactHarnessRef>,
    dispatch_mode: Option<MessageDispatchMode>,
) {
    state.begin_request(&prompt);
    if let Some(mode) = dispatch_mode {
        state.status = match (state.locale.is_chinese(), mode) {
            (true, MessageDispatchMode::Parallel) => "已排队 · 并发".to_string(),
            (true, MessageDispatchMode::FollowUp) => "已排队 · 跟进".to_string(),
            (true, MessageDispatchMode::Interrupt) => "已排队 · 打断".to_string(),
            (false, MessageDispatchMode::Parallel) => "queued · parallel".to_string(),
            (false, MessageDispatchMode::FollowUp) => "queued · follow-up".to_string(),
            (false, MessageDispatchMode::Interrupt) => "queued · interrupt".to_string(),
        };
    }
    let message_id = format!(
        "tui_{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let sdk = MorphzSdk::new(runtime.clone());
    let principal = sdk.default_principal();
    if let Err(error) = sdk
        .send_message(
            &principal,
            SendMessageCommand {
                session_id: session.id().to_string(),
                text: prompt,
                actor: "User".to_string(),
                client_message_id: Some(message_id),
                attachments: Vec::new(),
                staged_attachment_ids: Vec::new(),
                references: Vec::new(),
                harness,
                dispatch_mode,
                model_alias: None,
                reasoning_effort: None,
                target_id: None,
            },
        )
        .await
    {
        state.push(
            EntryKind::Error,
            if state.locale.is_chinese() {
                format!("发送消息失败：{error}")
            } else {
                format!("Could not send the message: {error}")
            },
        );
        state.busy = false;
        state.status = state.tr("send failed", "发送失败").to_string();
    }
}

fn key_action(state: &mut UiState, key: KeyEvent) -> UiAction {
    if state.pending_approval.is_some() {
        return match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => UiAction::Approve(true),
            KeyCode::Char('n') | KeyCode::Char('N') => UiAction::Approve(false),
            _ => UiAction::None,
        };
    }
    if state.show_control {
        return control_key_action(state, key);
    }
    if state.info_panel.is_some() {
        if is_control_palette_key(key) {
            return UiAction::OpenControl;
        }
        match key.code {
            KeyCode::Esc => state.info_panel = None,
            KeyCode::PageUp => state.info_scroll = state.info_scroll.saturating_sub(8),
            KeyCode::PageDown => state.info_scroll = state.info_scroll.saturating_add(8),
            KeyCode::Home => state.info_scroll = 0,
            _ => {}
        }
        return UiAction::None;
    }
    if is_control_palette_key(key) {
        return UiAction::OpenControl;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('d') {
        return UiAction::ExecuteControl(ControlAction::Quit);
    }
    if is_theme_cycle_key(key) {
        return UiAction::ExecuteControl(ControlAction::CycleTheme);
    }
    if is_permission_cycle_key(key) {
        let permission_mode = match state.permission_mode {
            PermissionMode::AutoReview => PermissionMode::RequestApproval,
            PermissionMode::RequestApproval => PermissionMode::FullAccess,
            PermissionMode::FullAccess | PermissionMode::Custom => PermissionMode::AutoReview,
        };
        return UiAction::ExecuteControl(ControlAction::SetPermissionMode(permission_mode));
    }
    if state.show_help {
        if key.code == KeyCode::Esc || is_shortcuts_key(key) {
            state.show_help = false;
        }
        return UiAction::None;
    }
    if state.show_sessions {
        return match key.code {
            KeyCode::Esc => {
                state.show_sessions = false;
                UiAction::None
            }
            KeyCode::Up => {
                state.move_session_selection(-1);
                UiAction::None
            }
            KeyCode::Down => {
                state.move_session_selection(1);
                UiAction::None
            }
            KeyCode::PageUp => {
                state.move_session_selection(-8);
                UiAction::None
            }
            KeyCode::PageDown => {
                state.move_session_selection(8);
                UiAction::None
            }
            KeyCode::Home => {
                state.session_selection = 0;
                UiAction::None
            }
            KeyCode::End => {
                state.session_selection = state.sessions.len().saturating_sub(1);
                UiAction::None
            }
            KeyCode::Enter => state
                .selected_session_id()
                .map(|id| UiAction::SwitchSession(id.to_string()))
                .unwrap_or(UiAction::None),
            _ if is_session_directory_key(key) => {
                state.show_sessions = false;
                UiAction::None
            }
            _ => UiAction::None,
        };
    }
    if state.show_objectives {
        match key.code {
            KeyCode::Esc => {
                state.show_objectives = false;
                state.objective_scroll = 0;
            }
            KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                state.show_objectives = false;
                state.objective_scroll = 0;
            }
            KeyCode::PageUp => state.objective_scroll = state.objective_scroll.saturating_sub(8),
            KeyCode::PageDown => state.objective_scroll = state.objective_scroll.saturating_add(8),
            KeyCode::Home => state.objective_scroll = 0,
            _ => {}
        }
        return UiAction::None;
    }
    if is_shortcuts_key(key) && state.composer.text().is_empty() {
        return UiAction::ExecuteControl(ControlAction::ShowHelp);
    }
    if is_session_directory_key(key) {
        return UiAction::ExecuteControl(ControlAction::ShowSessions);
    }
    if !state.busy || (state.cancel_confirmation_armed && key.code != KeyCode::Esc) {
        state.cancel_confirmation_armed = false;
    }
    if state.busy && state.active_view == UiView::Conversation && key.code == KeyCode::Esc {
        if state.cancel_confirmation_armed {
            state.cancel_confirmation_armed = false;
            return UiAction::ExecuteControl(ControlAction::CancelEvaluation);
        }
        state.cancel_confirmation_armed = true;
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('r') | KeyCode::Char('R'))
    {
        return UiAction::ExecuteControl(ControlAction::SetReasoningDetails(
            !state.show_reasoning_details,
        ));
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return UiAction::ExecuteControl(if state.busy {
            ControlAction::CancelEvaluation
        } else {
            ControlAction::Quit
        });
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('t') | KeyCode::Char('T'))
    {
        return UiAction::ExecuteControl(if state.active_view == UiView::Tasks {
            ControlAction::ShowConversation
        } else {
            ControlAction::ShowTasks
        });
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('k') | KeyCode::Char('K'))
    {
        return UiAction::ExecuteControl(if state.active_view == UiView::Mind {
            ControlAction::ShowConversation
        } else {
            ControlAction::ShowMind
        });
    }
    if key.code == KeyCode::Tab && state.active_view != UiView::Conversation {
        state.toggle_secondary_focus();
        return UiAction::None;
    }
    if key.code == KeyCode::Esc && state.active_view != UiView::Conversation {
        if state.focus == UiFocus::Composer {
            state.focus = UiFocus::Content;
        } else {
            state.set_active_view(UiView::Conversation);
        }
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('o') {
        return UiAction::ExecuteControl(ControlAction::ShowObjectives);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Home {
        if state.active_view == UiView::Conversation {
            state.scroll_transcript_to_top();
        } else {
            state.view_scroll = 0;
        }
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::End {
        if state.active_view == UiView::Conversation {
            state.scroll_transcript_to_bottom();
        } else {
            state.view_scroll = u16::MAX;
        }
        return UiAction::None;
    }
    if state.active_view != UiView::Conversation && state.focus == UiFocus::Content {
        match key.code {
            KeyCode::Up => match state.active_view {
                UiView::Tasks => state.move_objective_selection(-1),
                UiView::Mind => state.move_frame_selection(-1),
                UiView::Conversation => {}
            },
            KeyCode::Down => match state.active_view {
                UiView::Tasks => state.move_objective_selection(1),
                UiView::Mind => state.move_frame_selection(1),
                UiView::Conversation => {}
            },
            KeyCode::PageUp => match state.active_view {
                UiView::Tasks => state.move_objective_selection(-8),
                UiView::Mind => state.move_frame_selection(-8),
                UiView::Conversation => {}
            },
            KeyCode::PageDown => match state.active_view {
                UiView::Tasks => state.move_objective_selection(8),
                UiView::Mind => state.move_frame_selection(8),
                UiView::Conversation => {}
            },
            KeyCode::Home => state.select_first_content_item(),
            KeyCode::End => state.select_last_content_item(),
            KeyCode::Char('d') | KeyCode::Char('D') if state.active_view == UiView::Tasks => {
                state.show_task_diagnostics = !state.show_task_diagnostics;
                state.view_scroll = 0;
            }
            KeyCode::Char(_)
                if !key.modifiers.intersects(
                    KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                ) =>
            {
                state.focus = UiFocus::Composer;
            }
            _ => {}
        }
        if state.focus == UiFocus::Content {
            return UiAction::None;
        }
    }
    match key.code {
        KeyCode::Esc => state.composer.clear(),
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
            state.composer.insert('\n')
        }
        KeyCode::Enter if key.modifiers.contains(KeyModifiers::ALT) => {
            return submit_composer(state, Some(MessageDispatchMode::Parallel));
        }
        KeyCode::Enter
            if key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER) =>
        {
            return submit_composer(state, Some(MessageDispatchMode::FollowUp));
        }
        KeyCode::Enter => {
            return submit_composer(state, None);
        }
        KeyCode::Char('j') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            state.composer.insert('\n')
        }
        KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            state.composer.insert(character)
        }
        KeyCode::Backspace => state.composer.backspace(),
        KeyCode::Delete => state.composer.delete(),
        KeyCode::Left => state.composer.cursor = state.composer.cursor.saturating_sub(1),
        KeyCode::Right => {
            state.composer.cursor = (state.composer.cursor + 1).min(state.composer.chars.len())
        }
        KeyCode::Home => state.composer.cursor = 0,
        KeyCode::End => state.composer.cursor = state.composer.chars.len(),
        KeyCode::PageUp if state.active_view != UiView::Conversation => {
            state.view_scroll = state.view_scroll.saturating_sub(8)
        }
        KeyCode::PageDown if state.active_view != UiView::Conversation => {
            state.view_scroll = state.view_scroll.saturating_add(8)
        }
        KeyCode::PageUp => {
            state.scroll_transcript_up(8);
        }
        KeyCode::PageDown => state.scroll_transcript_down(8),
        _ => {}
    }
    UiAction::None
}

fn control_key_action(state: &mut UiState, key: KeyEvent) -> UiAction {
    match key.code {
        KeyCode::Esc => state.close_control(),
        _ if is_control_palette_key(key) => state.close_control(),
        KeyCode::Up => {
            state.control_selection = state.control_selection.saturating_sub(1);
            state.control_feedback = None;
        }
        KeyCode::Down => {
            let len = state.filtered_control_items().len();
            state.control_selection = (state.control_selection + 1).min(len.saturating_sub(1));
            state.control_feedback = None;
        }
        KeyCode::PageUp => {
            state.control_selection = state.control_selection.saturating_sub(8);
            state.control_feedback = None;
        }
        KeyCode::PageDown => {
            let len = state.filtered_control_items().len();
            state.control_selection = (state.control_selection + 8).min(len.saturating_sub(1));
            state.control_feedback = None;
        }
        KeyCode::Home => state.control_selection = 0,
        KeyCode::End => {
            state.control_selection = state.filtered_control_items().len().saturating_sub(1)
        }
        KeyCode::Enter => {
            let items = state.filtered_control_items();
            if let Some(item) = items.get(state.control_selection) {
                if item.enabled {
                    return UiAction::ExecuteControl(item.action.clone());
                }
                state.control_feedback = item.disabled_reason.clone();
            }
        }
        KeyCode::Backspace => {
            state.control_input.backspace();
            state.control_selection = 0;
            state.control_feedback = None;
        }
        KeyCode::Delete => {
            state.control_input.delete();
            state.control_selection = 0;
            state.control_feedback = None;
        }
        KeyCode::Left => state.control_input.cursor = state.control_input.cursor.saturating_sub(1),
        KeyCode::Right => {
            state.control_input.cursor =
                (state.control_input.cursor + 1).min(state.control_input.chars.len())
        }
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            state.control_input.clear();
            state.control_selection = 0;
            state.control_feedback = None;
        }
        KeyCode::Char(character)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) =>
        {
            state.control_input.insert(character);
            state.control_selection = 0;
            state.control_feedback = None;
        }
        _ => {}
    }
    state.reconcile_control_selection();
    UiAction::None
}

fn submit_composer(state: &mut UiState, dispatch_mode: Option<MessageDispatchMode>) -> UiAction {
    let text = state.composer.take_trimmed();
    if text.is_empty() {
        return UiAction::None;
    }
    UiAction::Submit {
        text,
        dispatch_mode,
    }
}

fn move_selection(current: usize, len: usize, amount: isize) -> usize {
    if len == 0 {
        return 0;
    }
    match amount {
        isize::MIN => 0,
        isize::MAX => len - 1,
        amount if amount.is_negative() => current.saturating_sub(amount.unsigned_abs()),
        amount => current.saturating_add(amount as usize).min(len - 1),
    }
}

fn moved_selection_id(current: Option<&str>, ids: &[String], amount: isize) -> Option<String> {
    let current = current
        .and_then(|id| ids.iter().position(|candidate| candidate == id))
        .unwrap_or_default();
    ids.get(move_selection(current, ids.len(), amount)).cloned()
}

fn is_shortcuts_key(key: KeyEvent) -> bool {
    key.code == KeyCode::Char('?')
        && !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
}

fn is_theme_cycle_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::ALT)
        && !key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('t') | KeyCode::Char('T'))
}

fn is_permission_cycle_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::ALT)
        && !key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('s') | KeyCode::Char('S'))
}

fn is_session_directory_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && !key.modifiers.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char('g') | KeyCode::Char('G'))
}

fn is_control_palette_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && !key.modifiers.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char('p') | KeyCode::Char('P'))
}

fn is_shell_escape_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && !key.modifiers.contains(KeyModifiers::ALT)
        && key.code == KeyCode::Char(']')
}

fn section_title(
    title: &'static str,
    count: usize,
    title_color: Color,
    count_color: Color,
) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            title,
            Style::default()
                .fg(title_color)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {count}"), Style::default().fg(count_color)),
    ])
}

fn push_more_hint(
    lines: &mut Vec<Line<'static>>,
    total: usize,
    shown: usize,
    color: Color,
    locale: Locale,
) {
    if total > shown {
        lines.push(Line::from(Span::styled(
            if locale.is_chinese() {
                format!("     … 另有 {} 项，按 D 查看详情", total - shown)
            } else {
                format!("     … {} more; press D for details", total - shown)
            },
            Style::default().fg(color),
        )));
    }
}

fn empty_state_line(message: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(Span::styled(
        format!("  — {}", message.into()),
        Style::default().fg(color),
    ))
}

fn task_status_color(status: &str, theme: &Theme) -> Color {
    match status {
        "running" | "active" | "succeeded" | "completed" => theme.success,
        "queued" | "waiting_tool" | "waiting_external" | "starting" | "kill_requested"
        | "cancel_requested" => theme.warning,
        "failed" | "killed" | "cancelled" => theme.error,
        _ => theme.text_secondary,
    }
}

fn pressure_color(level: &str, theme: &Theme) -> Color {
    match level {
        "critical" | "hard" | "overflow" => theme.error,
        "warning" | "soft" => theme.warning,
        _ => theme.success,
    }
}

fn background_status_str(status: BackgroundTaskStatus) -> &'static str {
    match status {
        BackgroundTaskStatus::Starting => "starting",
        BackgroundTaskStatus::Running => "running",
        BackgroundTaskStatus::KillRequested => "kill_requested",
        BackgroundTaskStatus::Succeeded => "succeeded",
        BackgroundTaskStatus::Failed => "failed",
        BackgroundTaskStatus::Killed => "killed",
    }
}

fn localized_runtime_status(locale: Locale, status: &str) -> String {
    if !locale.is_chinese() {
        return status.replace('_', " ").to_uppercase();
    }
    match status {
        "running" | "active" => "运行中",
        "queued" => "已排队",
        "waiting_tool" => "等待工具",
        "waiting_external" => "等待外部事件",
        "starting" => "正在启动",
        "kill_requested" | "cancel_requested" => "等待终止",
        "succeeded" | "completed" => "已完成",
        "failed" => "已失败",
        "killed" => "已终止",
        "cancelled" => "已取消",
        other => return other.replace('_', " "),
    }
    .to_string()
}

fn localized_objective_status(locale: Locale, status: ObjectiveStatus) -> &'static str {
    match (locale.is_chinese(), status) {
        (false, ObjectiveStatus::Active) => "ACTIVE",
        (false, ObjectiveStatus::Paused) => "PAUSED",
        (false, ObjectiveStatus::Blocked) => "BLOCKED",
        (false, ObjectiveStatus::Completed) => "COMPLETED",
        (false, ObjectiveStatus::Cancelled) => "CANCELLED",
        (false, ObjectiveStatus::Failed) => "FAILED",
        (true, ObjectiveStatus::Active) => "进行中",
        (true, ObjectiveStatus::Paused) => "已暂停",
        (true, ObjectiveStatus::Blocked) => "受阻",
        (true, ObjectiveStatus::Completed) => "已完成",
        (true, ObjectiveStatus::Cancelled) => "已取消",
        (true, ObjectiveStatus::Failed) => "已失败",
    }
}

fn localized_background_status(locale: Locale, status: BackgroundTaskStatus) -> &'static str {
    if !locale.is_chinese() {
        return background_status_str(status);
    }
    match status {
        BackgroundTaskStatus::Starting => "正在启动",
        BackgroundTaskStatus::Running => "运行中",
        BackgroundTaskStatus::KillRequested => "等待终止",
        BackgroundTaskStatus::Succeeded => "已完成",
        BackgroundTaskStatus::Failed => "已失败",
        BackgroundTaskStatus::Killed => "已终止",
    }
}

fn localized_delegation_status(locale: Locale, status: &DelegationStatus) -> &'static str {
    if !locale.is_chinese() {
        return status.as_str();
    }
    match status {
        DelegationStatus::Queued => "已排队",
        DelegationStatus::Running => "运行中",
        DelegationStatus::Completed => "已完成",
        DelegationStatus::Failed => "已失败",
        DelegationStatus::Cancelled => "已取消",
    }
}

fn localized_pressure(locale: Locale, pressure: &str) -> String {
    if !locale.is_chinese() {
        return pressure.to_uppercase();
    }
    match pressure {
        "normal" | "healthy" => "正常",
        "warning" | "soft" => "预警",
        "critical" | "hard" => "紧张",
        "overflow" => "超限",
        "loading" => "加载中",
        other => return other.to_string(),
    }
    .to_string()
}

fn ordered_objectives<'a>(
    objectives: &'a [ObjectiveRecord],
    session_id: &str,
) -> Vec<&'a ObjectiveRecord> {
    let mut ordered = objectives.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        let left_current =
            left.coordinator_session_id == session_id || left.delivery_session_id == session_id;
        let right_current =
            right.coordinator_session_id == session_id || right.delivery_session_id == session_id;
        right_current
            .cmp(&left_current)
            .then_with(|| {
                objective_status_rank(left.status).cmp(&objective_status_rank(right.status))
            })
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    ordered
}

fn objective_status_rank(status: ObjectiveStatus) -> u8 {
    match status {
        ObjectiveStatus::Active => 0,
        ObjectiveStatus::Blocked => 1,
        ObjectiveStatus::Paused => 2,
        ObjectiveStatus::Completed => 3,
        ObjectiveStatus::Failed => 4,
        ObjectiveStatus::Cancelled => 5,
    }
}

fn objective_status_marker(status: ObjectiveStatus) -> &'static str {
    match status {
        ObjectiveStatus::Active => "●",
        ObjectiveStatus::Paused => "Ⅱ",
        ObjectiveStatus::Blocked => "◆",
        ObjectiveStatus::Completed => "✓",
        ObjectiveStatus::Cancelled => "○",
        ObjectiveStatus::Failed => "!",
    }
}

fn objective_status_color(status: ObjectiveStatus, theme: &Theme) -> Color {
    match status {
        ObjectiveStatus::Active => theme.success,
        ObjectiveStatus::Paused => theme.warning,
        ObjectiveStatus::Blocked => theme.warning,
        ObjectiveStatus::Completed => theme.success,
        ObjectiveStatus::Cancelled => theme.text_muted,
        ObjectiveStatus::Failed => theme.error,
    }
}

fn sexpr_reader_lines(source: &str, theme: &Theme) -> Vec<Line<'static>> {
    let Ok(expression) = crate::sexpr::parse(source) else {
        return source
            .lines()
            .map(|line| {
                Line::from(vec![
                    Span::styled("│ ", Style::default().fg(theme.focus)),
                    Span::styled(line.to_string(), Style::default().fg(theme.text_primary)),
                ])
            })
            .collect();
    };

    fn atom_text(atom: &str) -> String {
        SExpr::Atom(atom.to_string()).to_string()
    }

    fn push_expression(
        expression: &SExpr,
        depth: usize,
        theme: &Theme,
        lines: &mut Vec<Line<'static>>,
    ) {
        let indent = "  ".repeat(depth);
        match expression {
            SExpr::Atom(atom) => lines.push(Line::from(vec![
                Span::styled(indent, Style::default().fg(theme.border_subtle)),
                Span::styled(atom_text(atom), Style::default().fg(theme.text_primary)),
            ])),
            SExpr::List(items) if items.is_empty() => lines.push(Line::from(vec![
                Span::styled(indent, Style::default().fg(theme.border_subtle)),
                Span::styled("()", Style::default().fg(theme.text_secondary)),
            ])),
            SExpr::List(items)
                if items.iter().all(|item| matches!(item, SExpr::Atom(_)))
                    && items
                        .iter()
                        .map(ToString::to_string)
                        .map(|value| UnicodeWidthStr::width(value.as_str()) + 1)
                        .sum::<usize>()
                        + depth * 2
                        <= 72 =>
            {
                let mut spans = vec![
                    Span::styled(indent, Style::default().fg(theme.border_subtle)),
                    Span::styled("(", Style::default().fg(theme.text_secondary)),
                ];
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        spans.push(Span::raw(" "));
                    }
                    spans.push(Span::styled(
                        item.to_string(),
                        Style::default().fg(if index == 0 {
                            theme.focus
                        } else {
                            theme.text_primary
                        }),
                    ));
                }
                spans.push(Span::styled(")", Style::default().fg(theme.text_secondary)));
                lines.push(Line::from(spans));
            }
            SExpr::List(items) => {
                let mut first = vec![
                    Span::styled(indent.clone(), Style::default().fg(theme.border_subtle)),
                    Span::styled("(", Style::default().fg(theme.text_secondary)),
                ];
                let mut remaining = items.as_slice();
                if let Some(SExpr::Atom(operator)) = items.first() {
                    first.push(Span::styled(
                        atom_text(operator),
                        Style::default().fg(theme.focus),
                    ));
                    remaining = &items[1..];
                }
                lines.push(Line::from(first));
                for child in remaining {
                    push_expression(child, depth + 1, theme, lines);
                }
                lines.push(Line::from(vec![
                    Span::styled(indent, Style::default().fg(theme.border_subtle)),
                    Span::styled(")", Style::default().fg(theme.text_secondary)),
                ]));
            }
        }
    }

    let mut lines = Vec::new();
    push_expression(&expression, 0, theme, &mut lines);
    lines
}

fn compact_count(value: usize) -> String {
    if value >= 1_000_000 {
        let tenths = value / 100_000;
        if tenths.is_multiple_of(10) {
            format!("{}m", tenths / 10)
        } else {
            format!("{}.{}m", tenths / 10, tenths % 10)
        }
    } else if value >= 1_000 {
        format!("{}k", (value + 500) / 1_000)
    } else {
        value.to_string()
    }
}

fn content_horizontal_margin(width: u16) -> u16 {
    match width {
        0..=79 => 1,
        80..=119 => 2,
        120..=179 => 3,
        _ => 4,
    }
}

fn inset_rect(area: Rect, horizontal: u16, vertical: u16) -> Rect {
    let horizontal = horizontal.min(area.width / 2);
    let vertical = vertical.min(area.height / 2);
    Rect::new(
        area.x.saturating_add(horizontal),
        area.y.saturating_add(vertical),
        area.width.saturating_sub(horizontal.saturating_mul(2)),
        area.height.saturating_sub(vertical.saturating_mul(2)),
    )
}

fn format_objective_wait(wait: &ObjectiveWaitCondition, locale: Locale) -> String {
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            if locale.is_chinese() {
                format!("工具任务 {}", short_id(task_id))
            } else {
                format!("tool task {}", short_id(task_id))
            }
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => {
            if locale.is_chinese() {
                format!("委派 {}", short_id(delegation_id))
            } else {
                format!("delegation {}", short_id(delegation_id))
            }
        }
        ObjectiveWaitCondition::Timer { deadline } => {
            if locale.is_chinese() {
                format!("定时器 {}", deadline.format("%m-%d %H:%M UTC"))
            } else {
                format!("timer {}", deadline.format("%m-%d %H:%M UTC"))
            }
        }
        ObjectiveWaitCondition::Permission { request_id } => {
            if locale.is_chinese() {
                format!("权限审批 {}", short_id(request_id))
            } else {
                format!("permission {}", short_id(request_id))
            }
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            if locale.is_chinese() {
                format!("用户输入 {}", short_id(session_id))
            } else {
                format!("user input {}", short_id(session_id))
            }
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => {
            if locale.is_chinese() {
                format!("事件 {topic} / {}", short_id(correlation_id))
            } else {
                format!("event {topic} / {}", short_id(correlation_id))
            }
        }
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            if locale.is_chinese() {
                format!("资源 {resource}")
            } else {
                format!("resource {resource}")
            }
        }
        ObjectiveWaitCondition::ThreadGroup { group_id } => {
            if locale.is_chinese() {
                format!("线程组 {}", short_id(group_id))
            } else {
                format!("thread group {}", short_id(group_id))
            }
        }
    }
}

fn format_duration(seconds: u64) -> String {
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

fn format_duration_localized(seconds: u64, locale: Locale) -> String {
    if !locale.is_chinese() {
        return format_duration(seconds);
    }
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let seconds = seconds % 60;
    if hours > 0 {
        format!("{hours}小时{minutes}分")
    } else if minutes > 0 {
        format!("{minutes}分{seconds}秒")
    } else {
        format!("{seconds}秒")
    }
}

fn display_working_directory() -> String {
    let current = std::env::current_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());
    let Some(home) = std::env::var_os("HOME") else {
        return current;
    };
    let home = home.to_string_lossy();
    current
        .strip_prefix(home.as_ref())
        .filter(|suffix| suffix.is_empty() || suffix.starts_with(std::path::MAIN_SEPARATOR))
        .map(|suffix| format!("~{suffix}"))
        .unwrap_or(current)
}

#[derive(Debug, Clone)]
struct ToolActivity {
    compact: String,
    detail: String,
}

#[derive(Debug, Clone)]
struct ToolSummary {
    title: String,
    target: String,
    meta: Vec<String>,
}

fn format_tool_activity(
    payload: &serde_json::Map<String, Value>,
    locale: Locale,
) -> Option<ToolActivity> {
    let calls = payload
        .get("calls")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let deduplicated = payload
        .get("deduplicated_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let rejected = payload
        .get("rejected_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if calls.is_empty() && deduplicated == 0 && rejected == 0 {
        return None;
    }
    let mut compact = Vec::new();
    let mut detail = Vec::new();
    for call in calls {
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("missing-call-id");
        let arguments = call
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let summary = summarize_tool_call(name, arguments, Some(id), locale);
        let mut lines = vec![if locale.is_chinese() {
            format!("调用 {}", summary.title)
        } else {
            format!("Using {}", summary.title)
        }];
        if !summary.target.is_empty() {
            lines.push(format!("   {}", summary.target));
        }
        if !summary.meta.is_empty() {
            lines.push(format!("   {}", summary.meta.join("  ·  ")));
        }
        compact.push(lines.join("\n"));
        let route = format_causal_route(payload, locale);
        detail.push(format!(
            "{} · {}{}\n{}",
            name,
            short_call_id(id),
            route,
            pretty_json(arguments)
        ));
    }
    if deduplicated > 0 {
        compact.push(if locale.is_chinese() {
            format!("↷ 跳过 {deduplicated} 次重复的上下文更新")
        } else {
            format!("↷ Skipped {deduplicated} duplicate context update(s)")
        });
    }
    if rejected > 0 {
        compact.push(if locale.is_chinese() {
            format!("! 拒绝 {rejected} 个不可用的工具调用")
        } else {
            format!("! Rejected {rejected} unavailable tool call(s)")
        });
    }
    if compact.is_empty() {
        return None;
    }
    Some(ToolActivity {
        compact: compact.join("\n\n"),
        detail: detail.join("\n\n"),
    })
}

fn format_tool_result(
    payload: &serde_json::Map<String, Value>,
    locale: Locale,
) -> Option<ToolActivity> {
    let name = payload.get("tool_name").and_then(Value::as_str)?;
    let status = payload
        .get("tool_status")
        .and_then(Value::as_str)
        .unwrap_or("success");
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(text).ok();
    let failed = matches!(status, "error" | "timeout" | "rejected" | "failed")
        || parsed
            .as_ref()
            .and_then(|value| value.get("process_status"))
            .and_then(Value::as_str)
            == Some("failed");
    let mut facts = Vec::new();
    if let Some(value) = &parsed {
        if let Some(execution) = value.get("execution").and_then(Value::as_str) {
            facts.push(localized_tool_fact(execution, locale).to_string());
        }
        if let Some(exit_code) = value.get("exit_code").and_then(Value::as_i64) {
            facts.push(if locale.is_chinese() {
                format!("退出码 {exit_code}")
            } else {
                format!("exit {exit_code}")
            });
        }
        if let Some(task_status) = value.get("task_status").and_then(Value::as_str) {
            facts.push(localized_tool_fact(task_status, locale).to_string());
        }
        if let Some(output_empty) = value.get("output_empty").and_then(Value::as_bool) {
            if output_empty {
                facts.push(locale.text("no output", "没有输出").to_string());
            }
        }
    }
    if facts.is_empty() {
        facts.push(localized_tool_fact(status, locale).to_string());
    }
    let title = tool_title(name, locale);
    let compact = if failed && locale.is_chinese() {
        format!("{title}失败  ·  {}", facts.join("  ·  "))
    } else if failed {
        format!("Failed {title}  ·  {}", facts.join("  ·  "))
    } else if locale.is_chinese() {
        format!("已完成{title}  ·  {}", facts.join("  ·  "))
    } else {
        format!("Used {title}  ·  {}", facts.join("  ·  "))
    };
    let call_id = payload
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(short_call_id)
        .unwrap_or_else(|| locale.text("no call id", "无调用标识").to_string());
    let detail = format!(
        "{} · {} · {}{}\n{}",
        name,
        call_id,
        status,
        format_causal_route(payload, locale),
        truncate(text, 2_000)
    );
    Some(ToolActivity { compact, detail })
}

fn localized_tool_fact(value: &str, locale: Locale) -> &str {
    if !locale.is_chinese() {
        return value;
    }
    match value {
        "sandboxed" => "沙箱执行",
        "escalated" => "权限扩张执行",
        "background" => "后台执行",
        "direct" => "直接执行",
        "success" | "succeeded" | "completed" => "已完成",
        "running" => "执行中",
        "queued" => "排队中",
        "waiting" => "等待中",
        "failed" | "error" => "失败",
        "timeout" => "超时",
        "rejected" => "已拒绝",
        "killed" => "已终止",
        _ => value,
    }
}

fn format_causal_route(payload: &serde_json::Map<String, Value>, locale: Locale) -> String {
    let mut fields = Vec::new();
    for (english, chinese, key) in [
        ("execution", "执行", "activation_id"),
        ("root", "根轮次", "root_turn_id"),
        ("trigger", "触发", "trigger_event_id"),
        ("cause", "原因", "caused_by"),
    ] {
        if let Some(value) = payload.get(key).and_then(Value::as_str) {
            fields.push(format!(
                "{} {}",
                locale.text(english, chinese),
                short_id(value)
            ));
        }
    }
    if fields.is_empty() {
        String::new()
    } else {
        format!(" · {}", fields.join(" · "))
    }
}

fn event_causal_id(payload: &serde_json::Map<String, Value>) -> Option<&str> {
    payload
        .get("activation_id")
        .and_then(Value::as_str)
        .or_else(|| payload.get("attempt_id").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

fn event_thread_kind(payload: &serde_json::Map<String, Value>) -> &str {
    payload
        .get("thread_kind")
        .and_then(Value::as_str)
        .unwrap_or("dialogue_turn")
}

fn summarize_tool_call(
    name: &str,
    arguments: &str,
    _call_id: Option<&str>,
    locale: Locale,
) -> ToolSummary {
    let value = serde_json::from_str::<Value>(arguments).unwrap_or(Value::Null);
    let string = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let mut target = match name {
        "read" | "write" | "edit" => string("path"),
        "exec" => string("command"),
        "search" => {
            let query = string("query");
            let path = string("path");
            if path.is_empty() {
                query
            } else {
                format!("{query}  {}  {path}", locale.text("in", "位于"))
            }
        }
        "list_files" => string("path"),
        "recall" => string("query"),
        "delegate" => string("task"),
        "check_task_after" | "wait_task" | "task_status" | "kill_task" => string("task_id"),
        "context_tx" => locale
            .text("Mind / Frame transaction", "认知事务")
            .to_string(),
        "send_message" => format!("{} · {}", string("session_id"), string("content")),
        "no_reply" => locale
            .text("No message to active Session", "不向当前会话发送消息")
            .to_string(),
        _ => first_scalar(&value),
    };
    target = truncate(&target.replace('\n', " "), 180);
    let mut meta = Vec::new();
    if name == "exec" {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            meta.push(format!("{} {cwd}", locale.text("cwd", "工作目录")));
        }
        if value
            .pointer("/requested_permissions/network")
            .and_then(Value::as_bool)
            == Some(true)
        {
            meta.push(locale.text("network", "网络").to_string());
        }
        if value.get("sandbox_permissions").and_then(Value::as_str) == Some("require_escalated") {
            meta.push(locale.text("approval required", "需要审批").to_string());
        }
        if let Some(wait_ms) = value.get("wait_ms").and_then(Value::as_u64) {
            meta.push(if locale.is_chinese() {
                format!("等待 {} 秒", wait_ms as f64 / 1_000.0)
            } else {
                format!("wait {}s", wait_ms as f64 / 1_000.0)
            });
        }
    }
    ToolSummary {
        title: tool_title(name, locale).to_string(),
        target,
        meta,
    }
}

fn tool_title(name: &str, locale: Locale) -> &'static str {
    let (english, chinese) = match name {
        "read" => ("Read file", "读取文件"),
        "write" => ("Write file", "写入文件"),
        "edit" => ("Edit file", "修改文件"),
        "exec" => ("Run command", "执行命令"),
        "search" => ("Search workspace", "搜索工作区"),
        "list_files" => ("Browse files", "浏览文件"),
        "recall" => ("Recall evidence", "召回证据"),
        "context_tx" => ("Update context", "维护认知"),
        "delegate" => ("Delegate work", "委派工作"),
        "list_tasks" => ("List background tasks", "列出后台任务"),
        "check_task_after" | "wait_task" => ("Schedule task checkpoint", "设置任务检查点"),
        "task_status" => ("Inspect background task", "检查后台任务"),
        "kill_task" => ("Stop background task", "终止后台任务"),
        "send_message" => ("Send Session message", "发送会话消息"),
        "no_reply" => ("Finish without message", "静默结束"),
        _ => ("Use tool", "调用工具"),
    };
    locale.text(english, chinese)
}

fn first_scalar(value: &Value) -> String {
    let Some(object) = value.as_object() else {
        return String::new();
    };
    object
        .values()
        .find_map(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            Value::Bool(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn short_call_id(id: &str) -> String {
    if id.chars().count() <= 24 {
        return id.to_string();
    }
    let suffix = id
        .chars()
        .rev()
        .take(10)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("…{suffix}")
}

fn pretty_json(value: &str) -> String {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| value.to_string())
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push('…');
    }
    output
}

fn wrap_display_lines(value: &str, max_width: usize) -> Vec<String> {
    let max_width = max_width.max(1);
    let mut lines = Vec::new();
    for source_line in value.lines() {
        if source_line.is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut line = String::new();
        let mut width: usize = 0;
        for character in source_line.chars() {
            let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
            if width > 0 && width.saturating_add(character_width) > max_width {
                lines.push(std::mem::take(&mut line));
                width = 0;
            }
            line.push(character);
            width = width.saturating_add(character_width);
        }
        lines.push(line);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn short_id(id: &str) -> String {
    if id.chars().count() <= 24 {
        id.to_string()
    } else {
        let suffix = id
            .chars()
            .rev()
            .take(12)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        format!("…{suffix}")
    }
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1])[1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use crate::llm::{Client, Message, Response, ToolDefinition};
    use crate::memory::{NewAgent, NewCognitiveContext, NewSession, SessionMountKind};
    use async_trait::async_trait;
    use ratatui::backend::TestBackend;
    use std::collections::BTreeSet;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    struct OfflineTuiClient;

    #[async_trait]
    impl Client for OfflineTuiClient {
        async fn create_completion(
            &self,
            _messages: Vec<Message>,
            _tools: Vec<ToolDefinition>,
        ) -> Result<Response, Box<dyn std::error::Error + Send + Sync>> {
            Err("offline".into())
        }
    }

    fn test_state(composer: Composer) -> UiState {
        UiState {
            locale: Locale::English,
            agent_id: "agent-default".to_string(),
            context_id: "context-default".to_string(),
            session_id: "s".to_string(),
            session_title: Some("main".to_string()),
            model: "m".to_string(),
            permission_mode: PermissionMode::AutoReview,
            working_directory: "~/Codes/Morphz".to_string(),
            entries: Vec::new(),
            composer,
            live_attempts: BTreeMap::new(),
            status: "ready".to_string(),
            context_status: "normal".to_string(),
            objectives: Vec::new(),
            context_view: None,
            delegations: Vec::new(),
            sessions: Vec::new(),
            session_selection: 0,
            session_drafts: BTreeMap::new(),
            model_options: Vec::new(),
            tool_names: vec!["read".to_string(), "search".to_string()],
            active_view: UiView::Conversation,
            focus: UiFocus::Composer,
            selected_objective_id: None,
            selected_frame_id: None,
            view_scroll: 0,
            busy: false,
            follow_tail: true,
            scroll: 0,
            max_scroll: 0,
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_reasoning_details: false,
            show_task_diagnostics: false,
            show_objectives: false,
            show_sessions: false,
            show_control: false,
            control_input: Composer::new(),
            control_selection: 0,
            control_feedback: None,
            info_panel: None,
            info_scroll: 0,
            objective_scroll: 0,
            cancel_confirmation_armed: false,
            appearance: TerminalAppearance::Dark,
            theme_kind: TuiTheme::Mono,
            theme: Theme::for_appearance(TuiTheme::Mono, TerminalAppearance::Dark),
        }
    }

    #[tokio::test]
    async fn tui_model_selection_is_persisted_per_session_and_restored_on_reentry() {
        let database = NamedTempFile::new().unwrap();
        let mut config = AppConfig::default();
        config.llm.model = "model-a".to_string();
        config.llm.models = vec!["model-a".to_string(), "model-b".to_string()];
        let runtime = MorphzRuntime::builder(config, Arc::new(OfflineTuiClient))
            .database_path(database.path().to_str().unwrap())
            .provider_auth_registry(crate::provider::auth::AuthAdapterRegistry::default())
            .build()
            .await
            .unwrap();
        runtime
            .ensure_agent(NewAgent {
                id: "agent-tui-model".to_string(),
                title: "TUI model".to_string(),
                root_context_id: "context-tui-model".to_string(),
            })
            .await
            .unwrap();
        runtime
            .ensure_context(NewCognitiveContext {
                id: "context-tui-model".to_string(),
                agent_id: "agent-tui-model".to_string(),
                title: "TUI model".to_string(),
            })
            .await
            .unwrap();
        let session_a = runtime
            .ensure_session(NewSession {
                id: "session-tui-model-a".to_string(),
                agent_id: "agent-tui-model".to_string(),
                context_id: "context-tui-model".to_string(),
                parent_session_id: None,
                title: "Session A".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();
        let session_b = runtime
            .ensure_session(NewSession {
                id: "session-tui-model-b".to_string(),
                agent_id: "agent-tui-model".to_string(),
                context_id: "context-tui-model".to_string(),
                parent_session_id: None,
                title: "Session B".to_string(),
                mount_kind: SessionMountKind::ExistingContext,
            })
            .await
            .unwrap();

        let mut state = UiState::new(&runtime, &session_a);
        execute_control_action(
            &runtime,
            &session_a,
            &mut state,
            ControlAction::SetModel("model-b".to_string()),
        )
        .await;
        execute_control_action(
            &runtime,
            &session_a,
            &mut state,
            ControlAction::SetReasoningEffort(Some(ReasoningEffort::High)),
        )
        .await;
        execute_control_action(
            &runtime,
            &session_a,
            &mut state,
            ControlAction::SetPermissionMode(PermissionMode::FullAccess),
        )
        .await;

        let persisted = session_a.record().await.unwrap().unwrap();
        assert_eq!(persisted.model_alias.as_deref(), Some("model-b"));
        assert_eq!(persisted.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(persisted.permission_mode, Some(PermissionMode::FullAccess));
        assert_eq!(persisted.sandbox_mode, None);
        assert_eq!(state.model, "model-b");
        assert_eq!(state.permission_mode, PermissionMode::FullAccess);
        assert_eq!(runtime.model(), "model-a");
        assert_eq!(session_b.record().await.unwrap().unwrap().model_alias, None);
        assert_eq!(
            session_b.record().await.unwrap().unwrap().sandbox_mode,
            None
        );
        assert_eq!(
            session_b.record().await.unwrap().unwrap().permission_mode,
            None
        );

        let mut reentered = UiState::new(&runtime, &session_a);
        reentered.model = effective_tui_session_model(&runtime, &persisted);
        reentered.permission_mode = effective_tui_session_permission_mode(&runtime, &persisted);
        assert_eq!(reentered.model, "model-b");
        assert_eq!(reentered.permission_mode, PermissionMode::FullAccess);
    }

    fn key_action(state: &mut UiState, key: KeyEvent) -> UiAction {
        let action = super::key_action(state, key);
        match &action {
            UiAction::OpenControl => state.open_control(),
            UiAction::ExecuteControl(action) => match action {
                ControlAction::ShowHelp => {
                    state.close_nonapproval_overlays();
                    state.show_help = true;
                }
                ControlAction::ShowConversation => state.set_active_view(UiView::Conversation),
                ControlAction::ShowTasks => state.set_active_view(UiView::Tasks),
                ControlAction::ShowMind => state.set_active_view(UiView::Mind),
                ControlAction::ShowSessions => {
                    state.close_nonapproval_overlays();
                    state.show_sessions = true;
                }
                ControlAction::ShowObjectives => {
                    state.close_nonapproval_overlays();
                    state.show_objectives = true;
                }
                ControlAction::SetToolDetails(show) => state.show_tool_details = *show,
                ControlAction::SetReasoningDetails(show) => state.show_reasoning_details = *show,
                ControlAction::CycleTheme => {
                    state.cycle_theme();
                }
                ControlAction::SetTheme(theme) => state.set_theme(*theme),
                ControlAction::ClearView => {
                    state.entries.clear();
                    state.live_attempts.clear();
                }
                ControlAction::ShowTools
                | ControlAction::ShowExecutionJobs
                | ControlAction::ShowDelegations
                | ControlAction::InspectContext
                | ControlAction::OpenShell
                | ControlAction::SetModel(_)
                | ControlAction::SetReasoningEffort(_)
                | ControlAction::SetPermissionMode(_)
                | ControlAction::CancelEvaluation
                | ControlAction::Quit => {}
            },
            UiAction::None
            | UiAction::Submit { .. }
            | UiAction::SwitchSession(_)
            | UiAction::Approve(_) => {}
        }
        action
    }

    fn stream_runtime_event(
        attempt_id: &str,
        activation_id: &str,
        thread_kind: &str,
        stream: ModelStreamEvent,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            format!("stream-{attempt_id}"),
            "Model-Provider".to_string(),
            "runtime_ephemeral".to_string(),
            "runtime/model_stream".to_string(),
            serde_json::json!({
                "session_id": "s",
                "attempt_id": attempt_id,
                "activation_id": activation_id,
                "thread_kind": thread_kind,
                "stream": stream,
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    }

    fn terminal_runtime_event(
        topic: &str,
        attempt_id: &str,
        activation_id: &str,
        text: &str,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            format!("terminal-{attempt_id}"),
            "Runtime".to_string(),
            "agent_call".to_string(),
            topic.to_string(),
            serde_json::json!({
                "session_id": "s",
                "attempt_id": attempt_id,
                "activation_id": activation_id,
                "thread_kind": "dialogue_turn",
                "text": text,
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    }

    fn reasoning_summary_event(
        attempt_id: &str,
        activation_id: &str,
        thread_kind: &str,
        text: &str,
    ) -> RuntimeEvent {
        RuntimeEvent::new(
            format!("reasoning-{attempt_id}"),
            "Model-Provider".to_string(),
            "runtime_control".to_string(),
            "runtime/model_reasoning_summary".to_string(),
            serde_json::json!({
                "session_id": "s",
                "attempt_id": attempt_id,
                "activation_id": activation_id,
                "thread_kind": thread_kind,
                "text": text,
                "complete": true,
            })
            .as_object()
            .unwrap()
            .clone(),
        )
    }

    fn transcript_text(state: &UiState) -> String {
        state
            .transcript_lines(120)
            .into_iter()
            .flat_map(|line| {
                line.spans
                    .into_iter()
                    .map(|span| span.content.into_owned())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn footer_text(state: &UiState) -> String {
        let mut terminal = Terminal::new(TestBackend::new(120, 1)).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                state.render_footer(frame, area);
            })
            .unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
    }

    #[test]
    fn concurrent_stream_attempts_remain_isolated_and_close_by_causal_activation() {
        let mut state = test_state(Composer::new());
        for (attempt_id, activation_id, thread_kind, text) in [
            ("attempt-a", "work-a", "dialogue_turn", "alpha draft"),
            ("attempt-b", "work-b", "delivery", "beta draft"),
        ] {
            state.on_runtime_event(stream_runtime_event(
                attempt_id,
                activation_id,
                thread_kind,
                ModelStreamEvent::Started,
            ));
            state.on_runtime_event(stream_runtime_event(
                attempt_id,
                activation_id,
                thread_kind,
                ModelStreamEvent::TextDelta {
                    text: text.to_string(),
                },
            ));
        }

        assert_eq!(state.live_attempts["attempt-a"].text, "alpha draft");
        assert_eq!(state.live_attempts["attempt-b"].text, "beta draft");
        assert!(state.busy);
        let rendered = transcript_text(&state);
        assert!(rendered.contains("alpha draft"));
        assert!(rendered.contains("beta draft"));

        // A retry Attempt can have a different id from the durable Activation;
        // the terminal fact must close only the Activation's own stream.
        state.on_runtime_event(terminal_runtime_event(
            "chat/reply",
            "terminal-attempt-a",
            "work-a",
            "alpha final",
        ));
        assert!(!state.live_attempts.contains_key("attempt-a"));
        assert!(state.live_attempts.contains_key("attempt-b"));
        assert!(state.busy);
        assert!(transcript_text(&state).contains("beta draft"));

        state.on_runtime_event(terminal_runtime_event(
            "chat/no_reply",
            "attempt-b",
            "work-b",
            "",
        ));
        assert!(state.live_attempts.is_empty());
        assert!(!state.busy);
    }

    #[test]
    fn execution_stream_is_tracked_but_never_rendered_as_conversation_draft() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-work",
            "work-hidden",
            "execution",
            ModelStreamEvent::Started,
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-work",
            "work-hidden",
            "execution",
            ModelStreamEvent::TextDelta {
                text: "internal chain must stay out of chat".to_string(),
            },
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-work",
            "work-hidden",
            "execution",
            ModelStreamEvent::ToolCallStarted {
                index: 0,
                id: "call-1".to_string(),
                name: "read".to_string(),
            },
        ));

        assert!(state.live_attempts.contains_key("attempt-work"));
        let rendered = transcript_text(&state);
        assert!(!rendered.contains("internal chain must stay out of chat"));
        assert!(!rendered.contains("Read file"));

        state.on_runtime_event(terminal_runtime_event(
            "runtime/thread_result",
            "attempt-work",
            "work-hidden",
            "internal result",
        ));
        assert!(state.live_attempts.is_empty());
        assert!(!state.busy);
    }

    #[test]
    fn provider_reasoning_summary_survives_completion_and_history_reload() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        let first_frame = transcript_text(&state);
        assert!(first_frame.contains("❨"));
        assert!(first_frame.contains("·"));
        assert!(first_frame.contains("❩ "));
        assert!(first_frame.contains("Thinking…"));
        state.spinner = 6;
        let next_frame = transcript_text(&state);
        assert!(next_frame.contains("∙"));
        assert!(next_frame.contains("Thinking…"));
        state.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::ReasoningSummaryDelta {
                text: "Checking the event contract before editing.".to_string(),
            },
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-hidden",
            "work-hidden",
            "execution",
            ModelStreamEvent::Started,
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-hidden",
            "work-hidden",
            "execution",
            ModelStreamEvent::ReasoningSummaryDelta {
                text: "private execution summary".to_string(),
            },
        ));

        let rendered = transcript_text(&state);
        assert!(rendered.contains("Checking the event contract before editing."));
        assert!(!rendered.contains("private execution summary"));

        state.on_runtime_event(terminal_runtime_event(
            "chat/reply",
            "attempt-chat",
            "work-chat",
            "Done",
        ));
        let rendered = transcript_text(&state);
        assert!(rendered.contains("Checking the event contract before editing."));
        assert!(rendered.contains("Done"));
        assert!(state.live_attempts.contains_key("attempt-hidden"));
        assert!(!state.live_attempts.contains_key("attempt-chat"));

        state.on_runtime_event(reasoning_summary_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            "Checking the event contract before editing.",
        ));
        state.on_runtime_event(reasoning_summary_event(
            "attempt-hidden",
            "work-hidden",
            "execution",
            "private execution summary",
        ));
        assert_eq!(
            state
                .entries
                .iter()
                .filter(|entry| entry.kind == EntryKind::Reasoning)
                .count(),
            1
        );
        assert!(!transcript_text(&state).contains("private execution summary"));

        let mut restored = test_state(Composer::new());
        restored.ingest_history(&reasoning_summary_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            "Checking the event contract before editing.",
        ));
        restored.ingest_history(&terminal_runtime_event(
            "chat/reply",
            "attempt-chat",
            "work-chat",
            "Done",
        ));
        let restored_text = transcript_text(&restored);
        assert!(restored_text.contains("Checking the event contract before editing."));
        assert!(restored_text.contains("Done"));
    }

    #[test]
    fn reasoning_summary_collapses_to_two_lines_and_ctrl_r_expands_it() {
        let mut state = test_state(Composer::new());
        state.ingest_history(&reasoning_summary_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            "first line\nsecond line\nthird line\nfourth line",
        ));

        let collapsed = transcript_text(&state);
        assert!(collapsed.contains("first line"));
        assert!(collapsed.contains("second line"));
        assert!(!collapsed.contains("third line"));
        assert!(collapsed.contains("2 more lines · Ctrl+R to expand"));

        let ctrl_r = KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert!(matches!(
            key_action(&mut state, ctrl_r),
            UiAction::ExecuteControl(ControlAction::SetReasoningDetails(true))
        ));
        assert!(state.show_reasoning_details);
        let expanded = transcript_text(&state);
        assert!(expanded.contains("third line"));
        assert!(expanded.contains("fourth line"));
        assert!(!expanded.contains("more lines · Ctrl+R to expand"));

        assert!(matches!(
            key_action(&mut state, ctrl_r),
            UiAction::ExecuteControl(ControlAction::SetReasoningDetails(false))
        ));
        assert!(!state.show_reasoning_details);
    }

    #[test]
    fn assistant_markdown_is_styled_in_durable_and_streaming_responses() {
        let mut state = test_state(Composer::new());
        state.push(
            EntryKind::Assistant,
            "# Result\n\n**bold** and `code`\n\n- one\n- two",
        );
        let lines = state.transcript_lines(100);
        let rendered = lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.content.as_ref()))
            .collect::<String>();
        assert!(rendered.contains("Result"));
        assert!(rendered.contains("bold and code"));
        assert!(rendered.contains("• one"));
        assert!(!rendered.contains("**"));
        assert!(!rendered.contains("`code`"));
        let bold = lines
            .iter()
            .flat_map(|line| &line.spans)
            .find(|span| span.content == "bold")
            .expect("bold response span");
        assert!(bold.style.add_modifier.contains(Modifier::BOLD));

        let mut streaming = test_state(Composer::new());
        streaming.on_runtime_event(stream_runtime_event(
            "attempt-markdown",
            "work-markdown",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        streaming.on_runtime_event(stream_runtime_event(
            "attempt-markdown",
            "work-markdown",
            "dialogue_turn",
            ModelStreamEvent::TextDelta {
                text: "**live bold**".to_string(),
            },
        ));
        let lines = streaming.transcript_lines(100);
        let live_bold = lines
            .iter()
            .flat_map(|line| &line.spans)
            .find(|span| span.content == "live bold")
            .expect("streaming bold span");
        assert!(live_bold.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn footer_is_the_single_persistent_home_for_runtime_status() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));

        assert!(transcript_text(&state).contains("Thinking…"));
        let conversation_footer = footer_text(&state);
        assert!(conversation_footer.contains("thinking"));
        assert!(conversation_footer.contains("m"));

        state.set_active_view(UiView::Tasks);
        let task_footer = footer_text(&state);
        assert!(task_footer.contains("thinking"));
    }

    #[test]
    fn failed_stream_discards_partial_draft_and_closes_single_stream_busy_state() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-failed",
            "work-failed",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-failed",
            "work-failed",
            "dialogue_turn",
            ModelStreamEvent::TextDelta {
                text: "half of a sentence".to_string(),
            },
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-failed",
            "work-failed",
            "dialogue_turn",
            ModelStreamEvent::Failed {
                message: "provider disconnected".to_string(),
            },
        ));

        assert!(state.live_attempts.is_empty());
        assert!(!state.busy);
        assert_eq!(state.status, "model error");
        let rendered = transcript_text(&state);
        assert!(!rendered.contains("half of a sentence"));
        assert!(rendered.contains("provider disconnected"));
    }

    #[test]
    fn durable_progress_replaces_its_exact_draft_without_duplicate_text() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-progress",
            "work-progress",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        state.on_runtime_event(stream_runtime_event(
            "attempt-progress",
            "work-progress",
            "dialogue_turn",
            ModelStreamEvent::TextDelta {
                text: "checkpoint reached".to_string(),
            },
        ));
        state.on_runtime_event(terminal_runtime_event(
            "chat/progress",
            "attempt-progress",
            "work-progress",
            "checkpoint reached",
        ));

        assert!(state.live_attempts.is_empty());
        assert_eq!(
            transcript_text(&state)
                .matches("checkpoint reached")
                .count(),
            1
        );
    }

    #[test]
    fn protocol_correction_clears_old_attempt_without_erasing_new_retry() {
        let mut state = test_state(Composer::new());
        for attempt_id in ["attempt-base", "attempt-base_response_retry_1"] {
            state.on_runtime_event(stream_runtime_event(
                attempt_id,
                "shared-work",
                "dialogue_turn",
                ModelStreamEvent::Started,
            ));
            state.on_runtime_event(stream_runtime_event(
                attempt_id,
                "shared-work",
                "dialogue_turn",
                ModelStreamEvent::TextDelta {
                    text: format!("draft from {attempt_id}"),
                },
            ));
        }

        state.on_runtime_event(terminal_runtime_event(
            "runtime/response_protocol_error",
            "attempt-base",
            "shared-work",
            "",
        ));

        assert!(!state.live_attempts.contains_key("attempt-base"));
        assert!(state
            .live_attempts
            .contains_key("attempt-base_response_retry_1"));
        assert!(state.busy);
        let rendered = transcript_text(&state);
        assert!(!rendered.contains("draft from attempt-base\n"));
        assert!(rendered.contains("draft from attempt-base_response_retry_1"));
    }

    fn test_objective() -> ObjectiveRecord {
        let now = Utc::now();
        ObjectiveRecord {
            id: "objective-1".to_string(),
            agent_id: "agent-default".to_string(),
            context_id: "context-default".to_string(),
            coordinator_session_id: "s".to_string(),
            delivery_session_id: "s".to_string(),
            parent_objective_id: None,
            source_event_id: "event-1".to_string(),
            initiating_principal_id: None,
            stated_objective: "Win TankWar and keep improving strategy".to_string(),
            revision: 3,
            generation: 1,
            status: ObjectiveStatus::Active,
            status_reason: Some("等待后台比赛结束后继续分析".to_string()),
            wait_condition: Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-123".to_string(),
            }),
            completion_intent: None,
            active_evaluation_id: None,
            evaluation_lease_expires_at: None,
            continuation_sequence: 2,
            token_budget: Some(256_000),
            tokens_used: 32_000,
            time_used_seconds: 125,
            created_at: now,
            updated_at: now,
        }
    }

    fn test_session(id: &str, title: &str, activity_offset_seconds: i64) -> SessionRecord {
        let now = Utc::now();
        SessionRecord {
            id: id.to_string(),
            agent_id: "agent-default".to_string(),
            context_id: "context-default".to_string(),
            parent_session_id: None,
            title: title.to_string(),
            status: SessionStatus::Active,
            model_alias: None,
            reasoning_effort: None,
            permission_mode: None,
            sandbox_mode: None,
            default_target_id: None,
            context_sharing: crate::memory::SessionContextSharing::Shared,
            created_at: now,
            updated_at: now,
            last_activity_at: now + chrono::Duration::seconds(activity_offset_seconds),
            attention_state: crate::memory::SessionAttentionState::default(),
            attention_revision: 0,
            attention_reason: None,
            attention_changed_at: None,
            attention_event_id: None,
        }
    }

    #[test]
    fn composer_edits_unicode_by_character_not_byte() {
        let mut composer = Composer::new();
        composer.insert_str("你好");
        composer.cursor = 1;
        composer.insert('，');
        composer.backspace();
        assert_eq!(composer.text(), "你好");
        composer.cursor = composer.chars.len();
        assert_eq!(composer.row_col(), (0, 4));
    }

    #[test]
    fn compact_count_keeps_context_chrome_readable() {
        assert_eq!(compact_count(999), "999");
        assert_eq!(compact_count(1_000), "1k");
        assert_eq!(compact_count(202_473), "202k");
        assert_eq!(compact_count(1_000_000), "1m");
        assert_eq!(compact_count(1_250_000), "1.2m");
    }

    #[test]
    fn conversation_has_no_fixed_header_and_keeps_location_in_the_footer() {
        let mut state = test_state(Composer::new());
        state.push(EntryKind::User, "hello");
        let width = 160usize;
        let height = 16usize;
        let mut terminal = Terminal::new(TestBackend::new(width as u16, height as u16)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();

        let buffer = terminal.backend().buffer();
        let top = buffer.content()[..width * 3]
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let footer = buffer.content()[width * (height - 1)..]
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(!top.contains("CONTEXT"));
        assert!(!top.contains("SESSION"));
        assert!(footer.contains("ready"));
        assert!(footer.contains("context-default"));
        assert!(footer.contains("main"));
    }

    #[test]
    fn enter_submits_and_shift_enter_inserts_newline() {
        let mut composer = Composer::new();
        composer.insert_str("hello");
        let mut state = test_state(composer);
        assert!(matches!(
            key_action(&mut state, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            UiAction::Submit {
                text,
                dispatch_mode: None,
            } if text == "hello"
        ));
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT)
            ),
            UiAction::None
        ));
        assert_eq!(state.composer.text(), "\n");

        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL)
            ),
            UiAction::None
        ));
        assert_eq!(state.composer.text(), "\n\n");
    }

    #[test]
    fn modified_enter_exposes_parallel_and_follow_up_dispatch_modes() {
        let mut parallel = test_state(Composer::new());
        parallel.composer.insert_str("parallel work");
        assert!(matches!(
            key_action(
                &mut parallel,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT)
            ),
            UiAction::Submit {
                text,
                dispatch_mode: Some(MessageDispatchMode::Parallel),
            } if text == "parallel work"
        ));

        let mut follow_up = test_state(Composer::new());
        follow_up.composer.insert_str("after that");
        assert!(matches!(
            key_action(
                &mut follow_up,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)
            ),
            UiAction::Submit {
                text,
                dispatch_mode: Some(MessageDispatchMode::FollowUp),
            } if text == "after that"
        ));
    }

    #[test]
    fn composer_never_interprets_slash_prefixed_text_as_local_control() {
        for text in ["/quit", "/tools", "/theme iris", "/sessions"] {
            let mut state = test_state(Composer::new());
            state.composer.insert_str(text);
            assert!(matches!(
                super::key_action(
                    &mut state,
                    KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
                ),
                UiAction::Submit {
                    text: submitted,
                    dispatch_mode: None,
                } if submitted == text
            ));
        }
    }

    #[test]
    fn ctrl_p_opens_control_without_destroying_the_composer_draft() {
        let mut state = test_state(Composer::new());
        state.composer.insert_str("unfinished thought");
        let ctrl_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);

        assert!(matches!(
            key_action(&mut state, ctrl_p),
            UiAction::OpenControl
        ));
        assert!(state.show_control);
        assert_eq!(state.composer.text(), "unfinished thought");
        assert!(state.control_input.text().is_empty());

        assert!(matches!(key_action(&mut state, ctrl_p), UiAction::None));
        assert!(!state.show_control);
        assert_eq!(state.composer.text(), "unfinished thought");
    }

    #[test]
    fn control_searches_localized_labels_and_stable_command_keys() {
        let mut state = test_state(Composer::new());
        state.locale = Locale::SimplifiedChinese;
        state.open_control();
        state.control_input.insert_str("工具");
        let localized = state.filtered_control_items();
        assert!(localized
            .iter()
            .any(|item| item.action == ControlAction::ShowTools));

        state.control_input.clear();
        state.control_input.insert_str("reasoning effort high");
        let stable = state.filtered_control_items();
        assert!(stable.iter().any(|item| {
            item.action == ControlAction::SetReasoningEffort(Some(ReasoningEffort::High))
        }));
    }

    #[test]
    fn unavailable_control_action_is_visible_but_cannot_execute() {
        let mut state = test_state(Composer::new());
        state.open_control();
        state.control_input.insert_str("runtime cancel");
        let items = state.filtered_control_items();
        assert!(!items.is_empty());
        assert_eq!(items[0].action, ControlAction::CancelEvaluation);
        assert!(!items[0].enabled);

        assert!(matches!(
            super::key_action(
                &mut state,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
            ),
            UiAction::None
        ));
        assert!(state
            .control_feedback
            .as_deref()
            .is_some_and(|message| { message.contains("no active evaluation") }));
    }

    #[test]
    fn control_commands_are_unique_and_shell_has_a_distinct_escape_key() {
        let state = test_state(Composer::new());
        let items = state.control_items();
        let commands = items
            .iter()
            .map(|item| item.command.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(commands.len(), items.len());

        let ctrl_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        let ctrl_bracket = KeyEvent::new(KeyCode::Char(']'), KeyModifiers::CONTROL);
        assert!(is_control_palette_key(ctrl_p));
        assert!(!is_shell_escape_key(ctrl_p));
        assert!(is_shell_escape_key(ctrl_bracket));
    }

    #[test]
    fn control_and_help_render_the_separate_control_plane_contract() {
        let mut state = test_state(Composer::new());
        state.open_control();
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let control = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(control.contains("Control"));
        assert!(control.contains("List available tools"));
        assert!(control.contains("tool list"));
        assert!(control.contains("Composer draft is preserved"));
        assert!(!control.contains("/tools"));

        state.close_control();
        state.show_help = true;
        terminal.draw(|frame| state.render(frame)).unwrap();
        let help = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(help.contains("Ctrl+P Control"));
        assert!(help.contains("Ctrl+] returns to Morphz"));
        assert!(!help.contains("/sessions"));
    }

    #[test]
    fn secondary_views_have_real_content_focus_and_stable_objective_selection() {
        let mut first = test_objective();
        first.id = "objective-first".to_string();
        first.stated_objective = "First objective".to_string();
        let mut second = test_objective();
        second.id = "objective-second".to_string();
        second.stated_objective = "Second objective".to_string();
        let mut state = test_state(Composer::new());
        state.objectives = vec![first, second];
        state.reconcile_content_selections();
        state.set_active_view(UiView::Tasks);

        assert_eq!(state.focus, UiFocus::Content);
        assert_eq!(
            state.selected_objective_id.as_deref(),
            Some("objective-first")
        );
        key_action(&mut state, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
        assert_eq!(
            state.selected_objective_id.as_deref(),
            Some("objective-second")
        );

        state.objectives.reverse();
        state.reconcile_content_selections();
        assert_eq!(
            state.selected_objective_id.as_deref(),
            Some("objective-second")
        );

        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
        );
        assert_eq!(state.focus, UiFocus::Composer);
        assert_eq!(state.composer.text(), "x");
    }

    #[test]
    fn selection_by_stable_id_supports_mind_frame_navigation() {
        let ids = vec![
            "frame-alpha".to_string(),
            "frame-beta".to_string(),
            "frame-gamma".to_string(),
        ];
        assert_eq!(
            moved_selection_id(Some("frame-alpha"), &ids, 1).as_deref(),
            Some("frame-beta")
        );
        assert_eq!(
            moved_selection_id(Some("frame-beta"), &ids, isize::MAX).as_deref(),
            Some("frame-gamma")
        );
        assert_eq!(
            moved_selection_id(Some("frame-gamma"), &ids, isize::MIN).as_deref(),
            Some("frame-alpha")
        );
    }

    #[test]
    fn session_directory_sorts_by_activity_and_returns_selected_stable_id() {
        let mut state = test_state(Composer::new());
        state.set_sessions(vec![
            test_session("session-old", "Old", 0),
            test_session("session-new", "New", 20),
            test_session("session-middle", "Middle", 10),
        ]);
        assert_eq!(state.sessions[0].id, "session-new");
        assert_eq!(state.sessions[1].id, "session-middle");
        assert_eq!(state.sessions[2].id, "session-old");

        state.show_sessions = true;
        assert!(matches!(
            key_action(&mut state, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE)),
            UiAction::None
        ));
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
            ),
            UiAction::SwitchSession(id) if id == "session-middle"
        ));
    }

    #[test]
    fn ctrl_g_opens_the_session_directory_without_destroying_the_draft() {
        let mut state = test_state(Composer::new());
        state.composer.insert_str("unfinished message");
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL)
            ),
            UiAction::ExecuteControl(ControlAction::ShowSessions)
        ));
        assert_eq!(state.composer.text(), "unfinished message");
    }

    #[test]
    fn session_directory_keeps_a_deep_selection_visible() {
        let mut state = test_state(Composer::new());
        state.set_sessions(
            (0..14)
                .map(|index| {
                    test_session(
                        &format!("session-{index:02}"),
                        &format!("Session {index:02}"),
                        index,
                    )
                })
                .collect(),
        );
        state.session_selection = state.sessions.len() - 1;
        let selected_title = state.sessions.last().unwrap().title.clone();
        let mut terminal = Terminal::new(TestBackend::new(80, 14)).unwrap();
        terminal
            .draw(|frame| state.render_sessions(frame, frame.area()))
            .unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains(&selected_title));
        assert!(terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
    }

    #[test]
    fn enhanced_keyboard_protocol_preserves_modified_enter() {
        let flags = keyboard_enhancement_flags();
        assert!(flags.contains(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
        assert!(flags.contains(KeyboardEnhancementFlags::REPORT_ALL_KEYS_AS_ESCAPE_CODES));
        assert!(flags.contains(KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS));
        assert!(flags.contains(KeyboardEnhancementFlags::REPORT_EVENT_TYPES));
    }

    #[test]
    fn question_mark_toggles_shortcuts_only_when_the_composer_is_empty() {
        let question_mark = KeyEvent::new(KeyCode::Char('?'), KeyModifiers::SHIFT);
        let mut state = test_state(Composer::new());

        assert!(matches!(
            key_action(&mut state, question_mark),
            UiAction::ExecuteControl(ControlAction::ShowHelp)
        ));
        assert!(state.show_help);

        assert!(matches!(
            key_action(&mut state, question_mark),
            UiAction::None
        ));
        assert!(!state.show_help);

        state.composer.insert_str("why");
        assert!(matches!(
            key_action(&mut state, question_mark),
            UiAction::None
        ));
        assert_eq!(state.composer.text(), "why?");
        assert!(!state.show_help);
    }

    #[test]
    fn function_keys_are_not_application_shortcuts() {
        let mut state = test_state(Composer::new());
        let original_theme = state.theme_kind;
        for number in [1, 2, 3] {
            assert!(matches!(
                key_action(
                    &mut state,
                    KeyEvent::new(KeyCode::F(number), KeyModifiers::NONE)
                ),
                UiAction::None
            ));
        }
        assert!(!state.show_help);
        assert!(!state.show_sessions);
        assert_eq!(state.theme_kind, original_theme);
    }

    #[test]
    fn welcome_wordmark_is_branded_and_responsive() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Iris);
        let styled = state.transcript_lines(120);
        let wordmark_start = 2;
        let wordmark_end = wordmark_start + MORPHZ_WORDMARK.len();
        let wordmark_colors = styled[wordmark_start..wordmark_end]
            .iter()
            .map(|line| line.spans[0].style.fg.expect("wordmark line has color"))
            .collect::<Vec<_>>();
        assert_eq!(wordmark_colors.first(), Some(&state.theme.wordmark_start));
        assert_eq!(wordmark_colors.last(), Some(&state.theme.wordmark_end));
        assert_ne!(wordmark_colors[1], wordmark_colors[4]);
        let leading_spaces = styled[wordmark_start..wordmark_end]
            .iter()
            .map(|line| {
                line.spans[0]
                    .content
                    .chars()
                    .take_while(|character| *character == ' ')
                    .count()
            })
            .collect::<Vec<_>>();
        assert_eq!(leading_spaces, vec![2, 2, 1, 1, 0, 0]);
        assert!(styled[wordmark_start..wordmark_end]
            .iter()
            .all(|line| !line.spans[0].style.add_modifier.contains(Modifier::ITALIC)));

        let wide = state
            .transcript_lines(120)
            .into_iter()
            .flat_map(|line| line.spans.into_iter().map(|span| span.content.into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(wide.contains("███╗   ███╗"));
        assert!(wide.contains("Morphz"));
        assert!(wide.contains(MORPHZ_MACHINE_NAME_EN));
        assert!(!wide.contains("persistent coding agent"));

        let medium = state
            .transcript_lines(60)
            .into_iter()
            .flat_map(|line| line.spans.into_iter().map(|span| span.content.into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(medium.contains(r"|  \/  | ___"));
        assert!(!medium.contains("███╗   ███╗"));

        let narrow = state
            .transcript_lines(48)
            .into_iter()
            .flat_map(|line| line.spans.into_iter().map(|span| span.content.into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(narrow.contains("◆"));
        assert!(narrow.contains("Morphz"));
        assert!(narrow.contains(MORPHZ_MACHINE_NAME_EN));
        assert!(narrow.contains(r"|  \/  | ___"));
        assert!(!narrow.contains("███╗   ███╗"));

        let tiny = state
            .transcript_lines(32)
            .into_iter()
            .flat_map(|line| line.spans.into_iter().map(|span| span.content.into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(tiny.contains("Morphz"));
        assert!(!tiny.contains(MORPHZ_MACHINE_NAME_EN));

        assert_eq!(
            interpolate_color(Color::Reset, Color::Rgb(1, 2, 3), 3, 5),
            Color::Reset
        );
    }

    #[test]
    fn ctrl_d_quits_from_normal_busy_and_modal_states() {
        let ctrl_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);

        let mut normal = test_state(Composer::new());
        assert!(matches!(
            key_action(&mut normal, ctrl_d),
            UiAction::ExecuteControl(ControlAction::Quit)
        ));

        let mut busy = test_state(Composer::new());
        busy.busy = true;
        assert!(matches!(
            key_action(&mut busy, ctrl_d),
            UiAction::ExecuteControl(ControlAction::Quit)
        ));

        let mut modal = test_state(Composer::new());
        modal.show_help = true;
        assert!(matches!(
            key_action(&mut modal, ctrl_d),
            UiAction::ExecuteControl(ControlAction::Quit)
        ));
    }

    #[test]
    fn escape_requires_a_visible_second_confirmation_before_cancelling() {
        let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        let mut composer = Composer::new();
        composer.insert_str("draft");
        let mut state = test_state(composer);
        state.locale = Locale::SimplifiedChinese;
        state.busy = true;

        assert!(matches!(key_action(&mut state, escape), UiAction::None));
        assert!(state.cancel_confirmation_armed);
        assert_eq!(state.composer.text(), "draft");

        let mut terminal = Terminal::new(TestBackend::new(120, 1)).unwrap();
        terminal
            .draw(|frame| state.render_footer(frame, frame.area()))
            .unwrap();
        let confirmation = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let compact_confirmation = confirmation.replace(' ', "");
        assert!(compact_confirmation.contains("取消当前会话任务"));
        assert!(compact_confirmation.contains("再按Esc确认"));
        assert!(terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.warning));

        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)
            ),
            UiAction::None
        ));
        assert!(!state.cancel_confirmation_armed);
        assert_eq!(state.composer.text(), "draftx");

        key_action(&mut state, escape);
        assert!(state.cancel_confirmation_armed);
        assert!(matches!(
            key_action(&mut state, escape),
            UiAction::ExecuteControl(ControlAction::CancelEvaluation)
        ));
        assert!(!state.cancel_confirmation_armed);
    }

    #[test]
    fn escape_from_a_secondary_view_returns_to_chat_before_arming_cancel() {
        let mut state = test_state(Composer::new());
        state.busy = true;
        state.set_active_view(UiView::Tasks);

        assert!(matches!(
            key_action(&mut state, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            UiAction::None
        ));
        assert_eq!(state.active_view, UiView::Conversation);
        assert!(!state.cancel_confirmation_armed);
    }

    #[test]
    fn ctrl_t_toggles_tasks_view_and_ctrl_w_is_not_an_alias() {
        let mut state = test_state(Composer::new());
        assert!(!state.show_tool_details);
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
            ),
            UiAction::ExecuteControl(ControlAction::ShowTasks)
        ));
        assert_eq!(state.active_view, UiView::Tasks);
        assert!(!state.show_tool_details);

        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Conversation);
        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Conversation);
    }

    #[test]
    fn ctrl_o_expands_and_collapses_objectives() {
        let mut state = test_state(Composer::new());
        state.objectives.push(test_objective());
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL)
            ),
            UiAction::ExecuteControl(ControlAction::ShowObjectives)
        ));
        assert!(state.show_objectives);
        assert!(matches!(
            key_action(&mut state, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
            UiAction::None
        ));
        assert!(!state.show_objectives);
    }

    #[test]
    fn tool_activity_prefers_semantic_summary_over_raw_json() {
        let payload = serde_json::json!({
            "calls": [{
                "id": "call_1784046108314504000_3",
                "name": "exec",
                "arguments": r#"{"command":"cargo test","cwd":"/workspace","requested_permissions":{"network":true},"sandbox_permissions":"require_escalated"}"#
            }]
        });
        let activity = format_tool_activity(payload.as_object().unwrap(), Locale::English).unwrap();
        assert!(activity.compact.contains("Run command"));
        assert!(activity.compact.contains("cargo test"));
        assert!(activity.compact.contains("network"));
        assert!(activity.compact.contains("approval required"));
        assert!(!activity.compact.contains("requested_permissions"));
        assert!(!activity.compact.contains("call_178"));
        assert!(activity.detail.contains("requested_permissions"));
    }

    #[test]
    fn tool_result_has_compact_status() {
        let payload = serde_json::json!({
            "tool_name": "exec",
            "tool_call_id": "call_1",
            "tool_status": "success",
            "text": r#"{"execution":"sandboxed","exit_code":0,"output_empty":true}"#
        });
        let activity = format_tool_result(payload.as_object().unwrap(), Locale::English).unwrap();
        assert!(activity.compact.contains("Used Run command"));
        assert!(activity.compact.contains("sandboxed"));
        assert!(activity.compact.contains("exit 0"));
        assert!(activity.compact.contains("no output"));
    }

    #[test]
    fn chinese_tool_activity_does_not_mix_english_product_copy() {
        let payload = serde_json::json!({
            "calls": [{
                "id": "call_1",
                "name": "exec",
                "arguments": r#"{"command":"cargo test","cwd":"/workspace","requested_permissions":{"network":true},"sandbox_permissions":"require_escalated"}"#
            }]
        });
        let activity =
            format_tool_activity(payload.as_object().unwrap(), Locale::SimplifiedChinese).unwrap();
        assert!(activity.compact.contains("调用 执行命令"));
        assert!(activity.compact.contains("工作目录 /workspace"));
        assert!(activity.compact.contains("网络"));
        assert!(activity.compact.contains("需要审批"));
        assert!(!activity.compact.contains("Using"));
        assert!(!activity.compact.contains("approval required"));
    }

    #[test]
    fn tui_renders_compact_tools_and_visible_input_cursor() {
        let mut state = test_state(Composer::new());
        state.objectives.push(test_objective());
        state.push_tool(
            "Using Run command\n   cargo test\n   network  ·  approval required",
            r#"exec · call_1
{
  "requested_permissions": { "network": true }
}"#,
        );
        let mut terminal = Terminal::new(TestBackend::new(120, 24)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();

        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("Morphz"));
        assert!(screen.contains(MORPHZ_MACHINE_NAME_EN));
        assert!(screen.contains("Directory"));
        assert!(screen.contains("context-default"));
        assert!(screen.contains("Using"));
        assert!(screen.contains("Run command"));
        assert!(screen.contains("cargo test"));
        assert!(!screen.contains("TASK DIAGNOSTICS"));
        assert!(!screen.contains("Win TankWar and keep improving strategy"));
        assert!(!screen.contains("requested_permissions"));
        assert!(terminal.backend().cursor_visible());
    }

    #[test]
    fn request_uses_theme_color_while_response_uses_plain_text_color() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Coral);
        state.push(EntryKind::User, "accented input");
        state.push(EntryKind::Assistant, "plain response");
        assert_eq!(UnicodeWidthStr::width(USER_MESSAGE_PREFIX), 4);
        assert_eq!(UnicodeWidthStr::width(COMPOSER_PREFIX), 2);

        let transcript = state.transcript_lines(120);
        let user_line = transcript
            .iter()
            .find(|line| {
                line.spans
                    .iter()
                    .any(|span| span.content == "accented input")
            })
            .expect("user line is rendered");
        assert_eq!(user_line.spans[0].content, "❨");
        assert_eq!(user_line.spans[1].content, "ᴍ");
        assert_eq!(user_line.spans[2].content, "❩ ");
        assert_eq!(user_line.spans[3].content, "accented input");
        assert_eq!(
            user_line.spans[0].style.fg,
            Some(state.theme.motion_palette[0])
        );
        assert_eq!(
            user_line.spans[1].style.fg,
            Some(state.theme.motion_palette[0])
        );
        assert_eq!(
            user_line.spans[2].style.fg,
            Some(state.theme.motion_palette[0])
        );
        assert_eq!(user_line.spans[3].style.fg, Some(state.theme.brand));
        assert!(user_line
            .spans
            .iter()
            .all(|span| span.style.add_modifier.contains(Modifier::BOLD)));
        let response_line = transcript
            .iter()
            .find(|line| {
                line.spans
                    .iter()
                    .any(|span| span.content == "plain response")
            })
            .expect("assistant response is rendered");
        assert_eq!(response_line.spans[0].content, "● ");
        assert!(response_line
            .spans
            .iter()
            .all(|span| span.style.fg == Some(state.theme.text_primary)));

        state.composer.insert_str("draft");
        let mut terminal = Terminal::new(TestBackend::new(60, 3)).unwrap();
        terminal
            .draw(|frame| {
                let area = frame.area();
                state.render_composer(frame, area, true);
            })
            .unwrap();
        let draft_cell = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .find(|cell| cell.symbol() == "d")
            .expect("composer text is rendered");
        assert_eq!(draft_cell.fg, state.theme.brand);
        assert!(draft_cell.modifier.contains(Modifier::BOLD));
        let marker_cell = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .find(|cell| cell.symbol() == "❯")
            .expect("composer marker is rendered");
        assert_eq!(marker_cell.fg, state.theme.focus);

        let mut streaming = test_state(Composer::new());
        streaming.set_theme(TuiTheme::Coral);
        streaming.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        streaming.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::TextDelta {
                text: "live response".to_string(),
            },
        ));
        let transcript = streaming.transcript_lines(120);
        let response_line = transcript
            .iter()
            .find(|line| {
                line.spans
                    .iter()
                    .any(|span| span.content == "live response")
            })
            .expect("streaming assistant response is rendered");
        assert_eq!(response_line.spans[0].content, "● ");
        assert!(response_line
            .spans
            .iter()
            .all(|span| span.style.fg == Some(streaming.theme.text_primary)));
    }

    #[test]
    fn latest_user_message_mark_morphs_as_one_symmetric_theme_colored_glyph() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Iris);
        state.spinner = 0;
        let initial = state.user_message_marker_spans(true);
        state.spinner = THEME_COLOR_MORPH_TICKS / 2;
        let midpoint = state.user_message_marker_spans(true);
        state.spinner = THEME_COLOR_MORPH_TICKS;
        let next = state.user_message_marker_spans(true);
        state.spinner = THEME_COLOR_MORPH_TICKS * 3;
        let full_cycle = state.user_message_marker_spans(true);

        let marker_text = initial
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert_eq!(marker_text, USER_MESSAGE_PREFIX);
        assert_eq!(UnicodeWidthStr::width(marker_text.as_str()), 4);

        for component in 0..3 {
            assert_eq!(
                initial[component].style.fg,
                Some(state.theme.motion_palette[0])
            );
            assert_eq!(
                midpoint[component].style.fg,
                Some(interpolate_color(
                    state.theme.motion_palette[0],
                    state.theme.motion_palette[1],
                    THEME_COLOR_MORPH_TICKS / 2,
                    THEME_COLOR_MORPH_TICKS - 1,
                ))
            );
            assert_eq!(
                next[component].style.fg,
                Some(state.theme.motion_palette[1])
            );
            assert_eq!(full_cycle[component].style.fg, initial[component].style.fg);
        }
        assert_eq!(initial[0].style.fg, initial[2].style.fg);
        assert_eq!(midpoint[0].style.fg, midpoint[2].style.fg);
        assert_eq!(next[0].style.fg, next[2].style.fg);
        assert!(initial
            .iter()
            .all(|span| span.style.add_modifier.contains(Modifier::BOLD)));

        let static_marker = state.user_message_marker_spans(false);
        assert!(static_marker
            .iter()
            .all(|span| span.style.fg == Some(state.theme.motion_palette[0])));

        state.set_theme(TuiTheme::NoColor);
        state.spinner = 0;
        let no_color = state.user_message_marker_spans(true);
        assert!(no_color
            .iter()
            .all(|span| span.style.fg == Some(Color::Reset)));
    }

    #[test]
    fn thinking_uses_a_slow_eased_cognitive_pulse_instead_of_a_rotating_circle() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Cyan);
        let frames = [0, 4, 8, 12, 18, 22, 26, 28]
            .into_iter()
            .map(|spinner| {
                state.spinner = spinner;
                state
                    .cognitive_activity_spans(true)
                    .into_iter()
                    .map(|span| span.content.into_owned())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();

        assert_eq!(
            frames,
            [
                "❨·❩ ",
                "❨∙❩ ",
                "❨•❩ ",
                "❨●❩ ",
                "❨•❩ ",
                "❨∙❩ ",
                "❨·❩ ",
                "❨·❩ "
            ]
        );
        assert!(frames
            .iter()
            .all(|frame| UnicodeWidthStr::width(frame.as_str()) == 4));
        assert!(frames
            .iter()
            .all(|frame| !["◐", "◓", "◑", "◒"].iter().any(|old| frame.contains(old))));

        state.spinner = 0;
        let quiet = state.cognitive_activity_spans(true);
        assert!(quiet[1].style.add_modifier.contains(Modifier::DIM));
        assert_eq!(quiet[0].style.fg, quiet[1].style.fg);
        assert_eq!(quiet[0].style.fg, quiet[2].style.fg);
        state.spinner = 12;
        let full = state.cognitive_activity_spans(true);
        assert!(full[1].style.add_modifier.contains(Modifier::BOLD));
        assert_eq!(full[0].style.fg, full[1].style.fg);
        assert_eq!(full[0].style.fg, full[2].style.fg);
    }

    #[test]
    #[ignore = "manual Ratatui visual snapshot"]
    fn print_modern_shell_snapshot() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Iris);
        state.objectives.push(test_objective());
        state.push(
            EntryKind::User,
            "请检查当前 Provider 的流式响应是否符合契约，并补上缺失的异常场景测试。",
        );
        state.push(
            EntryKind::Assistant,
            "我会先对照三套适配器的事件边界，再运行已有契约测试。工作已经启动，你可以继续给我消息。",
        );
        state.push_tool("Using Run command\n   cargo test --workspace", "");
        state.on_runtime_event(stream_runtime_event(
            "attempt-thinking",
            "work-thinking",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));
        let width = 160usize;
        let mut terminal = Terminal::new(TestBackend::new(width as u16, 40)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        for row in terminal.backend().buffer().content().chunks(width) {
            println!(
                "{}",
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .trim_end()
            );
        }
    }

    #[test]
    #[ignore = "manual Ratatui visual snapshot"]
    fn print_tasks_view_snapshot() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Cyan);
        state.locale = Locale::SimplifiedChinese;
        let mut objective = test_objective();
        objective.stated_objective = "完成 Provider 契约审计并交付稳定性报告".to_string();
        objective.status_reason = Some("等待后台兼容性测试完成".to_string());
        state.objectives.push(objective);
        state.set_active_view(UiView::Tasks);
        let width = 160usize;
        let mut terminal = Terminal::new(TestBackend::new(width as u16, 34)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        for row in terminal.backend().buffer().content().chunks(width) {
            println!(
                "{}",
                row.iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
                    .trim_end()
            );
        }
    }

    #[test]
    fn empty_state_hides_objective_chrome_and_inherits_terminal_background() {
        let mut state = test_state(Composer::new());
        state.locale = Locale::SimplifiedChinese;
        let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();

        let buffer = terminal.backend().buffer();
        let screen = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let compact_screen = screen
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        assert!(screen.contains("Morphz"));
        assert_eq!(state.tagline(), MORPHZ_MACHINE_NAME_ZH);
        assert!(compact_screen.contains("Ctrl+P控制"));
        assert!(!screen.contains("F1"));
        assert!(compact_screen.contains("输入消息"));
        assert!(!screen.contains("OBJECTIVE"));
        assert!(!screen.contains("Objective  none"));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.brand));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
        assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));
    }

    #[test]
    fn terminal_chrome_uses_one_language_at_a_time() {
        let render = |locale| {
            let mut state = test_state(Composer::new());
            state.locale = locale;
            let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
            terminal.draw(|frame| state.render(frame)).unwrap();
            terminal
                .backend()
                .buffer()
                .content()
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
        };

        let english = render(Locale::English);
        assert!(english.contains("Typeamessage"));
        assert!(english.contains("Ctrl+PControl"));
        assert!(!english.contains("输入消息"));
        assert!(!english.contains("快捷键"));

        let chinese = render(Locale::SimplifiedChinese);
        assert!(chinese.contains("输入消息") || chinese.contains("请选择会话"));
        assert!(chinese.contains("Ctrl+P控制"));
        assert!(!chinese.contains("Typeamessage"));
        assert!(!chinese.contains("shortcuts"));
    }

    #[test]
    fn themes_change_semantic_accents_without_owning_the_background() {
        let mono = Theme::for_appearance(TuiTheme::Mono, TerminalAppearance::Dark);
        let iris = Theme::for_appearance(TuiTheme::Iris, TerminalAppearance::Dark);
        let cyan = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Dark);
        let coral = Theme::for_appearance(TuiTheme::Coral, TerminalAppearance::Dark);
        let no_color = Theme::for_appearance(TuiTheme::NoColor, TerminalAppearance::Dark);

        assert_eq!(mono.brand, Color::Rgb(210, 211, 218));
        assert_eq!(iris.brand, Color::Rgb(165, 140, 255));
        assert_eq!(cyan.brand, Color::Rgb(86, 208, 222));
        assert_eq!(coral.brand, Color::Rgb(240, 138, 126));
        assert_eq!(iris.motion_palette, [iris.brand, cyan.brand, coral.brand]);
        assert_eq!(cyan.motion_palette, [cyan.brand, coral.brand, iris.brand]);
        assert_eq!(coral.motion_palette, [coral.brand, iris.brand, cyan.brand]);
        assert_eq!(mono.motion_palette[0], mono.brand);
        assert_eq!(cyan.success, Color::Rgb(92, 224, 153));
        assert_eq!(cyan.warning, Color::Rgb(240, 193, 100));
        assert_eq!(cyan.error, Color::Rgb(255, 138, 146));
        assert_eq!(no_color.brand, Color::Reset);
        assert_eq!(no_color.success, Color::Reset);
    }

    #[test]
    fn four_palettes_have_contrast_correct_light_variants() {
        let light_iris = Theme::for_appearance(TuiTheme::Iris, TerminalAppearance::Light);
        let light_cyan = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Light);
        let light_coral = Theme::for_appearance(TuiTheme::Coral, TerminalAppearance::Light);
        let light_mono = Theme::for_appearance(TuiTheme::Mono, TerminalAppearance::Light);
        let dark_cyan = Theme::for_appearance(TuiTheme::Cyan, TerminalAppearance::Dark);

        for theme in [light_iris, light_cyan, light_coral, light_mono] {
            assert_eq!(theme.text_primary, Color::Reset);
            assert_ne!(theme.text_secondary, Color::Rgb(200, 198, 208));
            assert_ne!(theme.text_muted, Color::Rgb(154, 158, 176));
        }
        assert_eq!(light_iris.brand, Color::Rgb(103, 72, 194));
        assert_eq!(light_cyan.brand, Color::Rgb(8, 124, 138));
        assert_eq!(light_coral.brand, Color::Rgb(184, 71, 61));
        assert_eq!(light_mono.brand, Color::Rgb(57, 55, 64));
        assert_ne!(light_cyan.brand, dark_cyan.brand);
    }

    #[test]
    fn terminal_appearance_hints_parse_common_light_and_dark_forms() {
        assert_eq!(
            parse_appearance_hint("light"),
            Some(TerminalAppearance::Light)
        );
        assert_eq!(
            parse_appearance_hint("NIGHT"),
            Some(TerminalAppearance::Dark)
        );
        assert_eq!(
            appearance_from_colorfgbg("0;15"),
            Some(TerminalAppearance::Light)
        );
        assert_eq!(
            appearance_from_colorfgbg("15;0"),
            Some(TerminalAppearance::Dark)
        );
        assert_eq!(
            appearance_from_colorfgbg("15;8"),
            Some(TerminalAppearance::Dark)
        );
        assert_eq!(appearance_from_colorfgbg("invalid"), None);
        assert_eq!(
            appearance_from_background_response(b"\x1b]11;rgb:ffff/ffff/ffff\x07"),
            Some(TerminalAppearance::Light)
        );
        assert_eq!(
            appearance_from_background_response(b"\x1b]11;rgb:1010/1818/2020\x1b\\"),
            Some(TerminalAppearance::Dark)
        );
    }

    #[test]
    fn alt_t_cycles_the_four_terminal_palettes() {
        let mut state = test_state(Composer::new());
        let alt_t = KeyEvent::new(KeyCode::Char('t'), KeyModifiers::ALT);
        for expected in [
            TuiTheme::Cyan,
            TuiTheme::Iris,
            TuiTheme::Coral,
            TuiTheme::Mono,
            TuiTheme::Cyan,
        ] {
            assert!(matches!(
                key_action(&mut state, alt_t),
                UiAction::ExecuteControl(ControlAction::CycleTheme)
            ));
            assert_eq!(state.theme_kind, expected);
            assert_eq!(
                state.theme,
                Theme::for_appearance(expected, TerminalAppearance::Dark)
            );
        }

        let before = state.theme_kind;
        let ctrl_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        assert!(is_control_palette_key(ctrl_p));
        assert!(matches!(
            key_action(&mut state, ctrl_p),
            UiAction::OpenControl
        ));
        assert!(state.show_control);
        assert_eq!(state.theme_kind, before, "Ctrl+P opens Control");
    }

    #[test]
    fn task_layout_and_mind_shortcuts_are_terminal_compatible() {
        let mut state = test_state(Composer::new());
        state.objectives.push(test_objective());
        assert_eq!(state.active_view, UiView::Conversation);

        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
            ),
            UiAction::ExecuteControl(ControlAction::ShowTasks)
        ));
        assert_eq!(state.active_view, UiView::Tasks);
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let task_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(task_screen.contains("OBJECTIVES"));
        assert!(task_screen.contains("EXECUTION"));
        assert!(task_screen.contains("DELEGATIONS"));
        assert!(task_screen.contains("Win TankWar and keep improving strategy"));
        assert!(!task_screen.contains("WORK"));
        assert!(!terminal.backend().cursor_visible());
        assert_eq!(state.focus, UiFocus::Content);

        key_action(&mut state, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(state.focus, UiFocus::Composer);
        assert!(!state.show_task_diagnostics);
        key_action(&mut state, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(state.focus, UiFocus::Content);
        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('d'), KeyModifiers::NONE),
        );
        assert!(state.show_task_diagnostics);
        terminal.draw(|frame| state.render(frame)).unwrap();
        let diagnostic_task_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(diagnostic_task_screen.contains("EXECUTION"));
        assert!(diagnostic_task_screen.contains("OBJECTIVES"));
        assert!(diagnostic_task_screen.contains("DELEGATIONS"));

        // Mind has one unambiguous shortcut across traditional and enhanced terminals.
        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Mind);
        terminal.draw(|frame| state.render(frame)).unwrap();
        let mind_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(mind_screen.contains("shared cognition"));

        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Conversation);

        // Neither an empty Return nor Ctrl+M silently changes navigation.
        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        );
        assert_eq!(state.active_view, UiView::Conversation);
        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('m'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Conversation);

        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('k'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.active_view, UiView::Mind);
        key_action(&mut state, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(state.active_view, UiView::Conversation);
    }

    #[test]
    fn tasks_view_uses_a_compact_empty_state_without_metric_cards() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Cyan);
        state.set_active_view(UiView::Tasks);
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();

        let buffer = terminal.backend().buffer();
        let screen = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("TASKS"));
        assert!(screen.contains("TASKS & EXECUTION"));
        assert!(!screen.contains("IN FLIGHT"));
        assert!(!screen.contains("WORK"));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
        assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));
    }

    #[test]
    fn empty_mind_uses_one_compact_cognitive_frame_surface() {
        let mut state = test_state(Composer::new());
        let mut terminal = Terminal::new(TestBackend::new(120, 16)).unwrap();
        terminal
            .draw(|frame| state.render_mind_empty_state(frame, frame.area(), 7))
            .unwrap();

        let buffer = terminal.backend().buffer();
        let screen = buffer
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("MIND FRAMES"));
        assert!(screen.contains("r7"));
        assert!(!screen.contains("CONTEXT INSPECTOR"));
        assert!(!screen.contains("SELF-MAINTAINED"));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
        assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));

        state.locale = Locale::SimplifiedChinese;
        let mut localized_terminal = Terminal::new(TestBackend::new(120, 16)).unwrap();
        localized_terminal
            .draw(|frame| state.render_mind_empty_state(frame, frame.area(), 7))
            .unwrap();
        let localized_screen = localized_terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
            .replace(' ', "");
        assert!(localized_screen.contains("认知帧"));
        assert!(!localized_screen.contains("认知框架"));
    }

    #[test]
    fn content_margins_grow_discretely_instead_of_drifting_with_terminal_width() {
        assert_eq!(content_horizontal_margin(40), 1);
        assert_eq!(content_horizontal_margin(79), 1);
        assert_eq!(content_horizontal_margin(80), 2);
        assert_eq!(content_horizontal_margin(119), 2);
        assert_eq!(content_horizontal_margin(120), 3);
        assert_eq!(content_horizontal_margin(179), 3);
        assert_eq!(content_horizontal_margin(180), 4);
        assert_eq!(content_horizontal_margin(320), 4);
    }

    #[test]
    fn wide_tasks_view_presents_outline_and_detail_instead_of_kpi_cards() {
        let mut state = test_state(Composer::new());
        state.objectives.push(test_objective());
        state.set_active_view(UiView::Tasks);
        let mut terminal = Terminal::new(TestBackend::new(140, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(screen.contains("OBJECTIVES"));
        assert!(screen.contains("OBJECTIVE ·"));
        assert!(screen.contains("Win TankWar"));
        assert!(screen.contains("CURRENT ACTIVITY"));
        assert!(!screen.contains("IN FLIGHT"));
    }

    #[test]
    fn redesigned_tasks_view_keeps_product_chrome_localized() {
        let mut state = test_state(Composer::new());
        state.locale = Locale::SimplifiedChinese;
        let mut objective = test_objective();
        objective.stated_objective = "完成运行时契约审计".to_string();
        objective.status_reason = Some("等待验证结果".to_string());
        state.objectives.push(objective);
        state.set_active_view(UiView::Tasks);
        let mut terminal = Terminal::new(TestBackend::new(140, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let compact_screen = screen
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();

        assert!(compact_screen.contains("目标"));
        assert!(compact_screen.contains("当前活动"));
        assert!(compact_screen.contains("完成运行时契约审计"));
        assert!(!screen.contains("OBJECTIVE"));
        assert!(!screen.contains("CURRENT ACTIVITY"));
    }

    #[test]
    fn sexpr_reader_formats_nested_frames_and_preserves_operator_emphasis() {
        let state = test_state(Composer::new());
        let lines = sexpr_reader_lines(
            r#"(frame (subject "Morphz") (constraint (scope runtime) (mode durable)))"#,
            &state.theme,
        );
        let screen = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");

        assert!(screen.lines().count() >= 5);
        assert!(screen.contains("frame"));
        assert!(screen.contains("subject"));
        assert!(screen.contains("constraint"));
        assert!(lines[0]
            .spans
            .iter()
            .any(|span| span.style.fg == Some(state.theme.focus)));
    }

    #[test]
    fn transcript_follow_tail_keeps_latest_message_above_composer_after_word_wrapping() {
        let mut state = test_state(Composer::new());
        let wrapped_line = "abcdefghijklmnopqrst abcdefghijklmnopqrst abcdefghijklmnopqrst";
        state.push(
            EntryKind::Assistant,
            std::iter::repeat_n(wrapped_line, 6)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        state.push(EntryKind::User, "TAIL_SENTINEL");

        let mut terminal = Terminal::new(TestBackend::new(40, 14)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();

        assert!(screen.contains("TAIL_SENTINEL"));
    }

    #[test]
    fn transcript_keyboard_scroll_and_jump_keys_reach_history_and_wordmark() {
        let mut state = test_state(Composer::new());
        for index in 0..30 {
            state.push(EntryKind::Assistant, format!("historical message {index}"));
        }
        let mut terminal = Terminal::new(TestBackend::new(80, 14)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        assert!(state.max_scroll > 3);
        assert_eq!(state.scroll, state.max_scroll);
        assert!(state.follow_tail);

        let page_up = KeyEvent::new(KeyCode::PageUp, KeyModifiers::NONE);
        assert!(matches!(key_action(&mut state, page_up), UiAction::None));
        let review_position = state.scroll;
        assert_eq!(review_position, state.max_scroll - 8);
        assert!(!state.follow_tail);

        state.push(EntryKind::Assistant, "NEW_TAIL_MESSAGE");
        terminal.draw(|frame| state.render(frame)).unwrap();
        assert_eq!(state.scroll, review_position);
        assert!(!state.follow_tail);

        let ctrl_home = KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL);
        assert!(matches!(key_action(&mut state, ctrl_home), UiAction::None));
        terminal.draw(|frame| state.render(frame)).unwrap();
        assert_eq!(state.scroll, 0);
        let top_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(top_screen.contains("███╗"));

        let ctrl_end = KeyEvent::new(KeyCode::End, KeyModifiers::CONTROL);
        assert!(matches!(key_action(&mut state, ctrl_end), UiAction::None));
        terminal.draw(|frame| state.render(frame)).unwrap();
        assert_eq!(state.scroll, state.max_scroll);
        assert!(state.follow_tail);
        let bottom_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(bottom_screen.contains("NEW_TAIL_MESSAGE"));
    }

    #[test]
    fn objective_panel_renders_lifecycle_and_progress() {
        let mut state = test_state(Composer::new());
        state.locale = Locale::SimplifiedChinese;
        state.objectives.push(test_objective());
        state.show_objectives = true;
        let mut terminal = Terminal::new(TestBackend::new(120, 32)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        let compact_screen = screen
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        assert!(compact_screen.contains("上下文目标"));
        assert!(compact_screen.contains("进行中"));
        assert!(compact_screen.contains("原因"));
        assert!(compact_screen.contains("等待后台比赛结束后继续分析"));
        assert!(compact_screen.contains("等待:工具任务task-123"));
        assert!(screen.contains("32000 / 256000 tok"));
        assert!(!terminal.backend().cursor_visible());
    }
}
