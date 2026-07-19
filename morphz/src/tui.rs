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
use crate::llm::ModelStreamEvent;
use crate::memory::{
    DelegationRecord, DelegationStatus, ObjectiveRecord, ObjectiveStatus, ObjectiveWaitCondition,
};
use crate::orchestrator::context::ContextView;
use crate::runtime::{MorphzRuntime, SessionHandle};
use crate::tool::{get_tasks_map, BackgroundTaskStatus};
use chrono::Utc;
use crossterm::cursor::Show;
use crossterm::event::{
    poll as poll_input_event, read as read_input_event, DisableBracketedPaste, DisableMouseCapture,
    EnableBracketedPaste, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, KeyboardEnhancementFlags, MouseEventKind, PopKeyboardEnhancementFlags,
    PushKeyboardEnhancementFlags,
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
use std::collections::BTreeMap;
use std::io::{self, Stdout};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

type TuiError = Box<dyn std::error::Error + Send + Sync>;

const USER_MESSAGE_PREFIX: &str = "✨ ";
const COMPOSER_PREFIX: &str = "❯ ";
const REASONING_PREVIEW_LINES: usize = 2;
const MOUSE_SCROLL_LINES: u16 = 3;
const MORPHZ_TAGLINE: &str = "Cognitive S-Expression Machine";
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
                    wordmark_start: Color::Rgb(38, 180, 199),
                    wordmark_end: Color::Rgb(185, 246, 250),
                    focus: Color::Rgb(86, 208, 222),
                    user: Color::Rgb(168, 238, 245),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(8, 124, 138),
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
                    wordmark_start: Color::Rgb(220, 93, 82),
                    wordmark_end: Color::Rgb(255, 211, 205),
                    focus: Color::Rgb(240, 138, 126),
                    user: Color::Rgb(255, 196, 189),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(184, 71, 61),
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
                    wordmark_start: Color::Rgb(156, 159, 170),
                    wordmark_end: Color::Rgb(255, 255, 255),
                    focus: Color::Rgb(210, 211, 218),
                    user: Color::Rgb(255, 255, 255),
                    ..dashboard
                },
                TerminalAppearance::Light => Self {
                    brand: Color::Rgb(57, 55, 64),
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
    matches!(thread_kind, "dialogue_turn" | "objective" | "delivery")
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
    agent_id: String,
    context_id: String,
    session_id: String,
    session_title: Option<String>,
    model: String,
    working_directory: String,
    entries: Vec<TranscriptEntry>,
    composer: Composer,
    live_attempts: BTreeMap<String, LiveAttempt>,
    status: String,
    context_status: String,
    objectives: Vec<ObjectiveRecord>,
    context_view: Option<ContextView>,
    delegations: Vec<DelegationRecord>,
    active_view: UiView,
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
    objective_scroll: u16,
    cancel_confirmation_armed: bool,
    appearance: TerminalAppearance,
    theme_kind: TuiTheme,
    theme: Theme,
}

impl UiState {
    fn new(runtime: &MorphzRuntime, session: &SessionHandle) -> Self {
        let configured_theme = runtime.config().tui.theme;
        let theme_kind = if std::env::var_os("NO_COLOR").is_some() {
            TuiTheme::NoColor
        } else {
            configured_theme
        };
        let appearance = detect_terminal_appearance();
        Self {
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            session_title: None,
            model: runtime.config().llm.model.clone(),
            working_directory: display_working_directory(),
            entries: Vec::new(),
            composer: Composer::new(),
            live_attempts: BTreeMap::new(),
            status: "ready".to_string(),
            context_status: "Context loading".to_string(),
            objectives: Vec::new(),
            context_view: None,
            delegations: Vec::new(),
            active_view: UiView::Conversation,
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
        let next = match self.theme_kind {
            TuiTheme::Cyan => TuiTheme::Iris,
            TuiTheme::Iris => TuiTheme::Coral,
            TuiTheme::Coral => TuiTheme::Mono,
            TuiTheme::Mono => TuiTheme::Cyan,
            TuiTheme::System | TuiTheme::NoColor => TuiTheme::Cyan,
        };
        self.set_theme(next);
        next
    }

    fn set_active_view(&mut self, active_view: UiView) {
        self.active_view = active_view;
        self.view_scroll = 0;
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
        self.status = "queued".to_string();
    }

    fn update_context(&mut self, view: &ContextView) {
        self.context_id.clone_from(&view.context_id);
        self.objectives = view.objectives.clone();
        let active_objectives = view
            .objectives
            .iter()
            .filter(|objective| objective.status == ObjectiveStatus::Active)
            .count();
        self.context_status = format!(
            "{} · {}/{} · {} frames · {}+{} sessions · {} work · {} goals",
            view.pressure.level,
            compact_count(view.pressure.estimated_tokens),
            compact_count(view.pressure.hard_limit),
            view.pressure.active_frames,
            view.session_working_set.full_session_ids.len(),
            view.session_working_set.metadata_only_session_ids.len(),
            view.active_activations.len(),
            active_objectives
        );
        self.context_view = Some(view.clone());
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

    fn conversation_activity_is_visible(&self) -> bool {
        self.active_view == UiView::Conversation
            && self
                .live_attempts
                .values()
                .any(LiveAttempt::is_conversation)
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
            "chat/progress" => self.push(EntryKind::Progress, text),
            "runtime/tool_calls_selected" => {
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_activity(&event.payload) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
            }
            "chat/tool_output" => {
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_result(&event.payload) {
                        self.push_tool(activity.compact, activity.detail);
                    }
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
                    if let Some(activity) = format_tool_activity(&event.payload) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
                self.busy = true;
                self.status = "running tools".to_string();
            }
            "chat/tool_output" => {
                if event_thread_kind(&event.payload) != "execution" {
                    if let Some(activity) = format_tool_result(&event.payload) {
                        self.push_tool(activity.compact, activity.detail);
                    }
                }
                self.status = "processing results".to_string();
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
                self.status = "correcting model response".to_string();
            }
            "runtime/response_protocol_fused" => {
                self.clear_exact_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    "response protocol error · other work continues"
                } else {
                    "response protocol error"
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
                self.status = if self.busy { "running" } else { "ready" }.to_string();
            }
            "chat/outbound_message" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.push(EntryKind::Assistant, text);
            }
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
                        format!("running · {background} background task(s)")
                    } else {
                        format!("ready · {background} background task(s)")
                    };
                } else {
                    self.refresh_busy_from_live_attempts();
                    self.status = if self.busy {
                        "running".to_string()
                    } else {
                        "ready · no reply".to_string()
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
                self.status = if self.busy { "running" } else { "cancelled" }.to_string();
            }
            "chat/runtime_error" => {
                self.clear_causal_live_attempt(&event);
                let message = event
                    .payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Runtime error");
                self.push(EntryKind::Error, message);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    "runtime error · other work continues"
                } else {
                    "runtime error"
                }
                .to_string();
            }
            "runtime/thread_result" => {
                self.resolve_causal_live_attempt(&event);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy { "running" } else { "ready" }.to_string();
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
                    .unwrap_or("权限请求需要用户决定")
                    .to_string();
                self.pending_approval = Some(PendingApproval { id, text });
                self.status = "approval required".to_string();
            }
            _ => {}
        }
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
                    "work evaluating"
                } else {
                    "thinking"
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
                self.status = "reasoning complete · waiting for final output".to_string();
            }
            ModelStreamEvent::ToolCallStarted { index, name, .. } => {
                if let Some(attempt) = self.live_attempts.get_mut(attempt_id) {
                    attempt.tools.entry(index).or_default().name = name.clone();
                }
                self.status = if name == "no_reply" {
                    "finishing silently".to_string()
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
            ModelStreamEvent::Completed => {
                self.status = "processing response".to_string();
            }
            ModelStreamEvent::Failed { message } => {
                self.live_attempts.remove(attempt_id);
                self.push(EntryKind::Error, message);
                self.refresh_busy_from_live_attempts();
                self.status = if self.busy {
                    "model error · other work continues"
                } else {
                    "model error"
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
            // The default surface is intentionally only the conversation and
            // its execution stream. Morphz-specific control planes stay one
            // shortcut away instead of permanently taking over the viewport.
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
            let compact = size.width < 88 || size.height < 18;
            let header_height = if compact { 3 } else { 4 };
            let status_height = if compact { 1 } else { 3 };
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(header_height),
                    Constraint::Length(status_height),
                    Constraint::Min(4),
                    Constraint::Length(input_lines + 2),
                    Constraint::Length(1),
                ])
                .split(size);
            self.render_header(frame, chunks[0]);
            self.render_chat_status(frame, chunks[1]);
            match self.active_view {
                UiView::Tasks => self.render_tasks_view(frame, chunks[2]),
                UiView::Mind => self.render_mind_view(frame, chunks[2]),
                UiView::Conversation => unreachable!(),
            }
            self.render_composer(frame, chunks[3], show_cursor);
            self.render_footer(frame, chunks[4]);
        }
        if self.show_help {
            self.render_help(frame, centered_rect(72, 70, size));
        }
        if self.show_objectives {
            self.render_objectives(frame, centered_rect(84, 78, size));
        }
        if self.pending_approval.is_some() {
            self.render_approval(frame, centered_rect(78, 62, size));
        }
    }

    fn render_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let spinner = ["◐", "◓", "◑", "◒"][self.spinner % 4];
        let activity = if self.busy { spinner } else { "●" };
        let activity_color = if self.busy {
            self.theme.warning
        } else {
            self.theme.success
        };
        if area.width < 88 {
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(vec![
                        Span::styled("◆ ", Style::default().fg(self.theme.brand)),
                        Span::styled(
                            "Morphz",
                            Style::default()
                                .fg(self.theme.brand)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled("   ", Style::default()),
                        Span::styled(activity, Style::default().fg(activity_color)),
                        Span::styled(
                            format!("  {}", self.status),
                            Style::default().fg(self.theme.text_secondary),
                        ),
                    ]),
                    self.render_legacy_identity_line(),
                ])
                .block(Block::default().padding(ratatui::widgets::Padding::horizontal(2))),
                area,
            );
            return;
        }
        let inner = inset_rect(area, control_plane_horizontal_margin(area.width), 0);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Fill(20),
                Constraint::Length(2),
                Constraint::Fill(27),
                Constraint::Length(2),
                Constraint::Fill(27),
                Constraint::Length(2),
                Constraint::Fill(26),
            ])
            .split(inner);
        for separator in [columns[1], columns[3], columns[5]] {
            frame.render_widget(
                Paragraph::new(vec![Line::from("│"), Line::from("│")])
                    .style(Style::default().fg(self.theme.border_subtle)),
                separator,
            );
        }
        let session_label = self
            .session_title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
            .map(|title| format!("{} · {}", truncate(title, 28), short_id(&self.session_id)))
            .unwrap_or_else(|| short_id(&self.session_id));
        let brand = vec![
            Line::from(vec![
                Span::styled("◆ ", Style::default().fg(self.theme.brand)),
                Span::styled(
                    "Morphz",
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("   ", Style::default()),
                Span::styled(activity, Style::default().fg(activity_color)),
                Span::styled(
                    format!("  {}", self.status),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(vec![
                Span::styled("agent/", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    short_id(&self.agent_id),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
        ];
        frame.render_widget(Paragraph::new(brand), columns[0]);

        let context = vec![
            Line::from(Span::styled(
                "CONTEXT",
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(vec![
                Span::styled(
                    short_id(&self.context_id),
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  shared", Style::default().fg(self.theme.focus)),
            ]),
        ];
        frame.render_widget(Paragraph::new(context), columns[2]);

        let session = vec![
            Line::from(Span::styled(
                "SESSION",
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(vec![
                Span::styled(
                    session_label,
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  active", Style::default().fg(self.theme.success)),
            ]),
        ];
        frame.render_widget(Paragraph::new(session), columns[4]);

        let (frames, version, pressure, tokens, hard_limit) = self
            .context_view
            .as_ref()
            .map(|view| {
                (
                    view.state.frames.len(),
                    view.state.version,
                    view.pressure.level.as_str(),
                    view.pressure.estimated_tokens,
                    view.pressure.hard_limit,
                )
            })
            .unwrap_or((0, 0, "loading", 0, 0));
        let runtime = vec![
            Line::from(vec![
                Span::styled("MIND  ", Style::default().fg(self.theme.focus)),
                Span::styled(
                    format!("{frames} frames"),
                    Style::default()
                        .fg(self.theme.text_primary)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  r{version} · {pressure}"),
                    Style::default().fg(pressure_color(pressure, &self.theme)),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    format!("{} / {}", compact_count(tokens), compact_count(hard_limit)),
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled("  ·  ", Style::default().fg(self.theme.border_subtle)),
                Span::styled(&self.model, Style::default().fg(self.theme.text_muted)),
            ]),
        ];
        frame.render_widget(
            Paragraph::new(runtime).alignment(Alignment::Right),
            columns[6],
        );
    }

    fn render_legacy_identity_line(&self) -> Line<'static> {
        Line::from(vec![
            Span::styled("AGENT ", Style::default().fg(self.theme.text_muted)),
            Span::styled(
                short_id(&self.agent_id),
                Style::default().fg(self.theme.text_secondary),
            ),
            Span::styled("  │  ", Style::default().fg(self.theme.border_strong)),
            Span::styled("CONTEXT ", Style::default().fg(self.theme.text_muted)),
            Span::styled(
                short_id(&self.context_id),
                Style::default().fg(self.theme.text_secondary),
            ),
            Span::styled("  │  ", Style::default().fg(self.theme.border_strong)),
            Span::styled("SESSION ", Style::default().fg(self.theme.text_muted)),
            Span::styled(
                short_id(&self.session_id),
                Style::default().fg(self.theme.text_primary),
            ),
        ])
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
        let background = get_tasks_map()
            .iter()
            .filter(|task| task.context_id == self.context_id && !task.status.is_terminal())
            .count();
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

    fn render_chat_status(&self, frame: &mut Frame<'_>, area: Rect) {
        let (view_label, view_color, view_detail) = match self.active_view {
            UiView::Tasks => ("TASKS", self.theme.focus, "目标、执行与委派"),
            UiView::Mind => ("MIND", self.theme.focus, "共享认知"),
            UiView::Conversation => ("CHAT", self.theme.user, "当前 Session"),
        };
        if area.height < 3 {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(
                        format!(" {view_label}  "),
                        Style::default().fg(view_color).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("context/{}", short_id(&self.context_id)),
                        Style::default().fg(self.theme.text_secondary),
                    ),
                    Span::styled("  ·  Esc", Style::default().fg(self.theme.text_muted)),
                ])),
                area,
            );
            return;
        }
        let strip = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(Style::default().fg(self.theme.border_subtle));
        let inner = inset_rect(
            strip.inner(area),
            control_plane_horizontal_margin(area.width),
            0,
        );
        frame.render_widget(strip, area);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!("{view_label}  "),
                    Style::default().fg(view_color).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("context/{}", short_id(&self.context_id)),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(
                    format!("  ·  {view_detail}"),
                    Style::default().fg(self.theme.text_muted),
                ),
            ])),
            inner,
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("对话输入可用  ", Style::default().fg(self.theme.text_muted)),
                Span::styled("Esc 返回", Style::default().fg(self.theme.user)),
            ]))
            .alignment(Alignment::Right),
            inner,
        );
    }

    fn task_overview_lines(&self) -> Vec<Line<'static>> {
        const MAX_ITEMS_PER_SECTION: usize = 4;
        let (activations, objectives, background_count, delegations) = self.runtime_task_counts();
        let total = activations + objectives + background_count + delegations;
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    "TASKS & EXECUTION",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {activations} activations  ·  {objectives} objectives  ·  {background_count} tasks  ·  {delegations} delegations"
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                "只显示当前可执行事实；Tab 展开诊断详情。",
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
        ];
        if total == 0 {
            lines.push(Line::from(vec![
                Span::styled("○  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    "当前没有活跃任务",
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]));
            return lines;
        }

        if let Some(view) = self.context_view.as_ref() {
            if !view.active_activations.is_empty() {
                lines.push(section_title(
                    "MODEL",
                    view.active_activations.len(),
                    self.theme.tool,
                    self.theme.text_muted,
                ));
                for item in view.active_activations.iter().take(MAX_ITEMS_PER_SECTION) {
                    lines.push(Line::from(vec![
                        Span::styled("  ◒  ", Style::default().fg(self.theme.tool)),
                        Span::styled(
                            item.status.as_str().to_uppercase(),
                            Style::default()
                                .fg(task_status_color(item.status.as_str(), &self.theme))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!(
                                "  {} · session/{}",
                                item.trigger_kind,
                                short_id(&item.session_id)
                            ),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]));
                }
                push_more_hint(
                    &mut lines,
                    view.active_activations.len(),
                    MAX_ITEMS_PER_SECTION,
                    self.theme.text_muted,
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
                "OBJECTIVES",
                active_objectives.len(),
                self.theme.warning,
                self.theme.text_muted,
            ));
            for objective in active_objectives.iter().take(MAX_ITEMS_PER_SECTION) {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("  {}  ", objective_status_marker(objective.status)),
                        Style::default().fg(objective_status_color(objective.status, &self.theme)),
                    ),
                    Span::styled(
                        truncate(&objective.stated_objective.replace('\n', " "), 110),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!("  ·  {}", objective.status.as_str()),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            push_more_hint(
                &mut lines,
                active_objectives.len(),
                MAX_ITEMS_PER_SECTION,
                self.theme.text_muted,
            );
            lines.push(Line::from(""));
        }

        let tasks = get_tasks_map();
        let background = tasks
            .iter()
            .filter(|task| task.context_id == self.context_id && !task.status.is_terminal())
            .collect::<Vec<_>>();
        if !background.is_empty() {
            lines.push(section_title(
                "BACKGROUND",
                background.len(),
                self.theme.success,
                self.theme.text_muted,
            ));
            for task in background.iter().take(MAX_ITEMS_PER_SECTION) {
                lines.push(Line::from(vec![
                    Span::styled("  ●  ", Style::default().fg(self.theme.success)),
                    Span::styled(
                        truncate(&task.cmd_str.replace('\n', " "), 110),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!("  ·  {}", background_status_str(task.status)),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            push_more_hint(
                &mut lines,
                background.len(),
                MAX_ITEMS_PER_SECTION,
                self.theme.text_muted,
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
                "DELEGATIONS",
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
                        format!("  ·  {}", job.status.as_str()),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            push_more_hint(
                &mut lines,
                active_delegations.len(),
                MAX_ITEMS_PER_SECTION,
                self.theme.text_muted,
            );
        }
        lines
    }

    fn task_diagnostic_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    "TASK DIAGNOSTICS",
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
                "只显示 Runtime 可验证的 Objective、Evaluation、后台物理任务与 Delegation。",
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
            "ACTIVATIONS",
            activations.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for item in activations {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    item.status.as_str().to_uppercase(),
                    Style::default()
                        .fg(task_status_color(item.status.as_str(), &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {}  ·  session/{}  ·  {}",
                        short_id(&item.id),
                        short_id(&item.session_id),
                        item.trigger_kind
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
        }
        if activations.is_empty() {
            lines.push(empty_state_line(
                "没有活跃的模型求值",
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
            "OBJECTIVES",
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
                    objective.status.as_str().to_uppercase(),
                    Style::default()
                        .fg(objective_status_color(objective.status, &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {}  ·  rev {}",
                        short_id(&objective.id),
                        objective.revision
                    ),
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
                    format!("     wait: {}", format_objective_wait(wait)),
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
                "没有非终态 Objective",
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));

        let tasks = get_tasks_map();
        let background = tasks
            .iter()
            .filter(|task| task.context_id == self.context_id && !task.status.is_terminal())
            .collect::<Vec<_>>();
        lines.push(section_title(
            "BACKGROUND TASKS",
            background.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for task in background {
            lines.push(Line::from(vec![
                Span::styled("  ◒ ", Style::default().fg(self.theme.warning)),
                Span::styled(
                    background_status_str(task.status).to_uppercase(),
                    Style::default()
                        .fg(task_status_color(
                            background_status_str(task.status),
                            &self.theme,
                        ))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {}  ·  session/{}  ·  {}s",
                        short_id(&task.id),
                        short_id(&task.session_id),
                        (Utc::now() - task.started_at).num_seconds().max(0)
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]));
            lines.push(Line::from(Span::styled(
                format!("     {}", truncate(&task.cmd_str.replace('\n', " "), 180)),
                Style::default().fg(self.theme.text_primary),
            )));
        }
        if !get_tasks_map()
            .iter()
            .any(|task| task.context_id == self.context_id && !task.status.is_terminal())
        {
            lines.push(empty_state_line(
                "没有运行中的后台物理任务",
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
            "DELEGATIONS",
            delegations.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for job in delegations {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    job.status.as_str().to_uppercase(),
                    Style::default()
                        .fg(task_status_color(job.status.as_str(), &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  {}  ·  child/{}",
                        short_id(&job.id),
                        short_id(&job.child_session_id)
                    ),
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
                "没有活跃的 Sub Agent Delegation",
                self.theme.text_muted,
            ));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Mind 中的自由 Frame 只在认知视图呈现；它们不会被 Runtime 猜测成任务。",
            Style::default().fg(self.theme.text_muted),
        )));
        lines
    }

    fn mind_lines(&self) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line(
                "MIND · Context 认知结构正在加载",
                self.theme.text_muted,
            )];
        };
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    "SHARED MIND",
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  ·  context/{}  ·  revision {}",
                        short_id(&view.context_id),
                        view.state.version
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]),
            Line::from(Span::styled(
                format!(
                    "{} tokens / {} hard limit · pressure {} · {} full + {} metadata sessions",
                    compact_count(view.pressure.estimated_tokens),
                    compact_count(view.pressure.hard_limit),
                    view.pressure.level,
                    view.session_working_set.full_session_ids.len(),
                    view.session_working_set.metadata_only_session_ids.len()
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
            section_title(
                "FRAMES",
                view.state.frames.len(),
                self.theme.text_secondary,
                self.theme.text_muted,
            ),
        ];
        for frame in &view.state.frames {
            let protected = if view.state.protected.contains(&frame.id) {
                " · protected"
            } else {
                ""
            };
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.focus)),
                Span::styled(
                    frame.id.clone(),
                    Style::default()
                        .fg(self.theme.text_secondary)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "  ·  rev {}  ·  updated v{}  ·  {} source(s){protected}",
                        frame.revision,
                        frame.updated_version,
                        frame.sources.len()
                    ),
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
                "当前 Mind 还没有形成认知 Frame",
                self.theme.text_muted,
            ));
            lines.push(Line::from(""));
        }

        lines.push(section_title(
            "RELATIONS",
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
            lines.push(empty_state_line("没有显式关系", self.theme.text_muted));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            format!(
                "RETIRED {}  ·  PROTECTED {}  ·  CHECKPOINTS {}  ·  Ctrl+K / Esc 返回对话",
                view.state.retired.len(),
                view.state.protected.len(),
                view.state.checkpoints.len()
            ),
            Style::default().fg(self.theme.text_muted),
        )));
        lines
    }

    fn render_view_lines(&mut self, frame: &mut Frame<'_>, area: Rect, lines: Vec<Line<'static>>) {
        let inner = inset_rect(area, (area.width / 14).clamp(3, 14), 1);
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        let visual_lines = paragraph.line_count(inner.width);
        let max_scroll = visual_lines
            .saturating_sub(inner.height as usize)
            .min(u16::MAX as usize) as u16;
        self.view_scroll = self.view_scroll.min(max_scroll);
        frame.render_widget(paragraph.scroll((self.view_scroll, 0)), inner);
    }

    fn render_metric_card(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        label: &str,
        value: String,
        detail: String,
        accent: Color,
    ) {
        let content = if area.height >= 3 {
            vec![
                Line::from(Span::styled(
                    label.to_string(),
                    Style::default().fg(self.theme.text_muted),
                )),
                Line::from(vec![
                    Span::styled(
                        value,
                        Style::default().fg(accent).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {detail}"),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]),
            ]
        } else {
            vec![Line::from(vec![
                Span::styled(
                    value,
                    Style::default().fg(accent).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {detail}"),
                    Style::default().fg(self.theme.text_muted),
                ),
            ])]
        };
        frame.render_widget(
            Paragraph::new(content).block(
                Block::default()
                    .borders(Borders::LEFT)
                    .border_style(Style::default().fg(accent))
                    .padding(ratatui::widgets::Padding::horizontal(1)),
            ),
            area,
        );
    }

    fn render_section_panel(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        title: &str,
        badge: impl std::fmt::Display,
        lines: Vec<Line<'static>>,
        accent: Color,
    ) {
        let title = Line::from(vec![
            Span::styled(
                format!(" {title} "),
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{badge} "),
                Style::default().fg(self.theme.text_muted),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(lines)
                .block(
                    Block::default()
                        .title(title)
                        .borders(Borders::TOP)
                        .border_style(Style::default().fg(self.theme.border_subtle))
                        .padding(ratatui::widgets::Padding::horizontal(1)),
                )
                .wrap(Wrap { trim: false }),
            area,
        );
    }

    fn evaluation_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line("Context 正在加载", self.theme.text_muted)];
        };
        if view.active_activations.is_empty() {
            return vec![empty_state_line(
                "没有活跃的模型求值",
                self.theme.text_muted,
            )];
        }
        view.active_activations
            .iter()
            .flat_map(|item| {
                let mut lines = vec![Line::from(vec![
                    Span::styled("◒ ", Style::default().fg(self.theme.tool)),
                    Span::styled(
                        item.status.as_str().to_uppercase(),
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
                            "  {} · session/{}",
                            short_id(&item.id),
                            short_id(&item.session_id)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines
            })
            .collect()
    }

    fn objective_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let objectives = self
            .objectives
            .iter()
            .filter(|objective| !objective.status.is_terminal())
            .collect::<Vec<_>>();
        if objectives.is_empty() {
            return vec![empty_state_line(
                "没有非终态 Objective",
                self.theme.text_muted,
            )];
        }
        objectives
            .into_iter()
            .flat_map(|objective| {
                let mut lines = vec![Line::from(vec![
                    Span::styled(
                        format!("{}  ", objective_status_marker(objective.status)),
                        Style::default().fg(objective_status_color(objective.status, &self.theme)),
                    ),
                    Span::styled(
                        truncate(&objective.stated_objective.replace('\n', " "), 120),
                        Style::default()
                            .fg(self.theme.text_primary)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  ·  {}", objective.status.as_str()),
                        Style::default().fg(objective_status_color(objective.status, &self.theme)),
                    ),
                ])];
                if detailed {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "   {} · revision {}",
                            short_id(&objective.id),
                            objective.revision
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                if let Some(wait) = objective.wait_condition.as_ref() {
                    lines.push(Line::from(Span::styled(
                        format!("   waiting · {}", format_objective_wait(wait)),
                        Style::default().fg(self.theme.warning),
                    )));
                }
                lines
            })
            .collect()
    }

    fn background_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let tasks = get_tasks_map();
        let tasks = tasks
            .iter()
            .filter(|task| task.context_id == self.context_id && !task.status.is_terminal())
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
        if tasks.is_empty() {
            return vec![empty_state_line(
                "没有运行中的后台物理任务",
                self.theme.text_muted,
            )];
        }
        tasks
            .into_iter()
            .flat_map(|(id, session_id, command, status, started_at)| {
                let mut lines = vec![Line::from(vec![
                    Span::styled("● ", Style::default().fg(self.theme.success)),
                    Span::styled(
                        truncate(&command.replace('\n', " "), 120),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!("  ·  {}", background_status_str(status)),
                        Style::default().fg(task_status_color(
                            background_status_str(status),
                            &self.theme,
                        )),
                    ),
                ])];
                if detailed {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  {} · session/{} · {}s",
                            short_id(&id),
                            short_id(&session_id),
                            (Utc::now() - started_at).num_seconds().max(0)
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines
            })
            .collect()
    }

    fn delegation_panel_lines(&self, detailed: bool) -> Vec<Line<'static>> {
        let jobs = self
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
        if jobs.is_empty() {
            return vec![empty_state_line(
                "没有活跃的 Sub Agent Delegation",
                self.theme.text_muted,
            )];
        }
        jobs.into_iter()
            .flat_map(|job| {
                let mut lines = vec![Line::from(vec![
                    Span::styled("◇ ", Style::default().fg(self.theme.tool)),
                    Span::styled(
                        truncate(&job.task.replace('\n', " "), 120),
                        Style::default().fg(self.theme.text_primary),
                    ),
                    Span::styled(
                        format!("  ·  {}", job.status.as_str()),
                        Style::default().fg(task_status_color(job.status.as_str(), &self.theme)),
                    ),
                ])];
                if detailed {
                    lines.push(Line::from(Span::styled(
                        format!(
                            "  {} · child/{}",
                            short_id(&job.id),
                            short_id(&job.child_session_id)
                        ),
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
        let background = get_tasks_map()
            .iter()
            .filter(|task| task.context_id == self.context_id && !task.status.is_terminal())
            .count();
        if activations + background == 0 {
            return vec![empty_state_line(
                "没有正在执行的模型求值或后台任务",
                self.theme.text_muted,
            )];
        }

        let mut lines = Vec::new();
        if activations > 0 {
            lines.push(section_title(
                "ACTIVATIONS",
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
                "BACKGROUND TASKS",
                background,
                self.theme.success,
                self.theme.text_muted,
            ));
            lines.extend(self.background_panel_lines(detailed));
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

        let inner = inset_rect(area, control_plane_horizontal_margin(area.width), 1);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(8)])
            .split(inner);
        let metrics = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(34),
                Constraint::Percentage(33),
                Constraint::Percentage(33),
            ])
            .split(rows[0]);
        let (activations, objectives, background, delegations) = self.runtime_task_counts();
        self.render_metric_card(
            frame,
            metrics[0],
            "OBJECTIVES",
            objectives.to_string(),
            "当前目标".to_string(),
            self.theme.focus,
        );
        self.render_metric_card(
            frame,
            metrics[1],
            "IN FLIGHT",
            (activations + background).to_string(),
            format!("{activations} activations · {background} tasks"),
            if activations + background > 0 {
                self.theme.success
            } else {
                self.theme.text_muted
            },
        );
        self.render_metric_card(
            frame,
            metrics[2],
            "DELEGATIONS",
            delegations.to_string(),
            "Sub Agents".to_string(),
            self.theme.tool,
        );

        let total = activations + objectives + background + delegations;
        if total == 0 {
            self.render_tasks_empty_state(frame, rows[1]);
            return;
        }

        let task_rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(40), Constraint::Percentage(60)])
            .split(rows[1]);
        self.render_section_panel(
            frame,
            task_rows[0],
            "OBJECTIVES",
            objectives,
            self.objective_panel_lines(self.show_task_diagnostics),
            self.theme.focus,
        );

        let execution = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(task_rows[1]);
        self.render_section_panel(
            frame,
            execution[0],
            "EXECUTION",
            activations + background,
            self.execution_panel_lines(self.show_task_diagnostics),
            self.theme.success,
        );
        self.render_section_panel(
            frame,
            execution[1],
            "DELEGATIONS",
            delegations,
            self.delegation_panel_lines(self.show_task_diagnostics),
            self.theme.tool,
        );
    }

    fn render_tasks_empty_state(&self, frame: &mut Frame<'_>, area: Rect) {
        let block = Block::default()
            .title(Line::from(vec![
                Span::styled(
                    " TASKS & EXECUTION ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("0 ", Style::default().fg(self.theme.text_muted)),
            ]))
            .borders(Borders::TOP)
            .border_style(Style::default().fg(self.theme.border_subtle));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let content_height = 3_u16.min(inner.height);
        let content = Rect::new(
            inner.x,
            inner
                .y
                .saturating_add(inner.height.saturating_sub(content_height) / 2),
            inner.width,
            content_height,
        );
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "○  当前没有进行中的任务",
                    Style::default()
                        .fg(self.theme.text_secondary)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "新的目标、执行任务和委派会按层级出现在这里。",
                    Style::default().fg(self.theme.text_muted),
                )),
                Line::from(Span::styled(
                    "继续在下方输入，或按 Esc 返回对话。",
                    Style::default().fg(self.theme.text_muted),
                )),
            ])
            .alignment(Alignment::Center),
            content,
        );
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
                    "MIND · Context 认知结构正在加载",
                    self.theme.text_muted,
                )],
            );
            return;
        };

        let inner = inset_rect(area, control_plane_horizontal_margin(area.width), 1);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(8)])
            .split(inner);
        let metrics = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
            ])
            .split(rows[0]);
        self.render_metric_card(
            frame,
            metrics[0],
            "FRAMES",
            view.state.frames.len().to_string(),
            "认知单元".to_string(),
            self.theme.focus,
        );
        self.render_metric_card(
            frame,
            metrics[1],
            "RELATIONS",
            view.state.relations.len().to_string(),
            "语义连接".to_string(),
            self.theme.tool,
        );
        self.render_metric_card(
            frame,
            metrics[2],
            "OBSERVATIONS",
            view.observations.len().to_string(),
            "可追溯证据".to_string(),
            self.theme.text_secondary,
        );
        self.render_metric_card(
            frame,
            metrics[3],
            "SESSIONS",
            view.session_working_set.full_session_ids.len().to_string(),
            format!(
                "+{} metadata",
                view.session_working_set.metadata_only_session_ids.len()
            ),
            self.theme.user,
        );

        if view.state.frames.is_empty() {
            self.render_mind_empty_state(frame, rows[1], view.state.version);
            return;
        }

        let body = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(68), Constraint::Percentage(32)])
            .split(rows[1]);
        let frame_lines = view
            .state
            .frames
            .iter()
            .flat_map(|context_frame| {
                let protection = if view.state.protected.contains(&context_frame.id) {
                    " · protected"
                } else {
                    ""
                };
                let mut lines = vec![Line::from(vec![
                    Span::styled("◇  ", Style::default().fg(self.theme.focus)),
                    Span::styled(
                        context_frame.id.clone(),
                        Style::default()
                            .fg(self.theme.text_primary)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!(
                            "  r{} · v{}{protection}",
                            context_frame.revision, context_frame.updated_version
                        ),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ])];
                for body_line in truncate(&context_frame.body, 280).lines() {
                    lines.push(Line::from(Span::styled(
                        format!("   {body_line}"),
                        Style::default().fg(self.theme.text_primary),
                    )));
                }
                lines.push(Line::from(Span::styled(
                    format!("   {} source(s)", context_frame.sources.len()),
                    Style::default().fg(self.theme.text_muted),
                )));
                lines.push(Line::from(""));
                lines
            })
            .collect();
        self.render_section_panel(
            frame,
            body[0],
            "COGNITIVE FRAMES",
            view.state.frames.len(),
            frame_lines,
            self.theme.focus,
        );

        let mut mind_state = vec![
            Line::from(vec![
                Span::styled("PRESSURE  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    view.pressure.level.to_uppercase(),
                    Style::default()
                        .fg(pressure_color(&view.pressure.level, &self.theme))
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::from(Span::styled(
                pressure_bar(view.pressure.estimated_tokens, view.pressure.hard_limit, 22),
                Style::default().fg(pressure_color(&view.pressure.level, &self.theme)),
            )),
            Line::from(Span::styled(
                format!(
                    "{} / {} · {}",
                    compact_count(view.pressure.estimated_tokens),
                    compact_count(view.pressure.hard_limit),
                    view.pressure.token_accuracy
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
            Line::from(vec![
                Span::styled("RESIDENCY  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    format!(
                        "{} full · {} metadata",
                        view.session_working_set.full_session_ids.len(),
                        view.session_working_set.metadata_only_session_ids.len()
                    ),
                    Style::default().fg(self.theme.text_primary),
                ),
            ]),
            Line::from(Span::styled(
                format!(
                    "window {} · max {} sessions",
                    format_duration(view.session_working_set.active_window_secs),
                    view.session_working_set.max_sessions
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
            Line::from(Span::styled(
                format!(
                    "LIFECYCLE  {} protected · {} retired",
                    view.state.protected.len(),
                    view.state.retired.len()
                ),
                Style::default().fg(self.theme.text_secondary),
            )),
            Line::from(Span::styled(
                format!("           {} checkpoints", view.state.checkpoints.len()),
                Style::default().fg(self.theme.text_muted),
            )),
        ];
        if !view.state.relations.is_empty() {
            mind_state.push(Line::from(""));
            mind_state.push(section_title(
                "RELATIONS",
                view.state.relations.len(),
                self.theme.tool,
                self.theme.text_muted,
            ));
        }
        for relation in view.state.relations.iter().take(6) {
            mind_state.push(Line::from(Span::styled(
                format!(
                    "{} —{}→ {}",
                    relation.subject, relation.relation, relation.object
                ),
                Style::default().fg(self.theme.text_secondary),
            )));
        }
        self.render_section_panel(
            frame,
            body[1],
            "MIND STATE",
            format!("r{}", view.state.version),
            mind_state,
            self.theme.text_secondary,
        );
    }

    fn render_mind_empty_state(&self, frame: &mut Frame<'_>, area: Rect, version: u64) {
        let block = Block::default()
            .title(Line::from(vec![
                Span::styled(
                    " COGNITIVE FRAMES ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("0  ·  r{version} "),
                    Style::default().fg(self.theme.text_muted),
                ),
            ]))
            .borders(Borders::TOP)
            .border_style(Style::default().fg(self.theme.border_subtle));
        let inner = block.inner(area);
        frame.render_widget(block, area);

        let content_height = 2_u16.min(inner.height);
        let content = Rect::new(
            inner.x,
            inner
                .y
                .saturating_add(inner.height.saturating_sub(content_height) / 2),
            inner.width,
            content_height,
        );
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(
                    "○  当前 Mind 还没有形成认知 Frame",
                    Style::default()
                        .fg(self.theme.text_secondary)
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(Span::styled(
                    "Agent 会在需要保留目标、约束或经验时自主创建。",
                    Style::default().fg(self.theme.text_muted),
                )),
            ])
            .alignment(Alignment::Center),
            content,
        );
    }

    fn transcript_lines(&self, width: u16) -> Vec<Line<'static>> {
        let mut lines = vec![Line::from("")];
        let wordmark: Option<&[&str]> = if width >= 66 {
            Some(&MORPHZ_WORDMARK)
        } else if width >= 52 {
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
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  ◆  ", Style::default().fg(self.theme.brand)),
                Span::styled(
                    "Morphz",
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  ·  ", Style::default().fg(self.theme.tool)),
                Span::styled(MORPHZ_TAGLINE, Style::default().fg(self.theme.text_muted)),
            ]));
        } else {
            lines.push(Line::from(vec![
                Span::styled("  ◆  ", Style::default().fg(self.theme.brand)),
                Span::styled(
                    "Morphz",
                    Style::default()
                        .fg(self.theme.brand)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            if width >= 44 {
                lines.push(Line::from(Span::styled(
                    format!("     {MORPHZ_TAGLINE}"),
                    Style::default().fg(self.theme.text_muted),
                )));
            }
        }
        lines.extend([
            Line::from(""),
            Line::from(vec![
                Span::styled(
                    "     Directory  ",
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    self.working_directory.clone(),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "     Session    ",
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    self.session_title
                        .as_deref()
                        .filter(|title| !title.trim().is_empty())
                        .map(|title| {
                            format!("{} · {}", truncate(title, 36), short_id(&self.session_id))
                        })
                        .unwrap_or_else(|| short_id(&self.session_id)),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(vec![
                Span::styled(
                    "     Model      ",
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    self.model.clone(),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(""),
        ]);
        for entry in &self.entries {
            if entry.kind == EntryKind::Tool {
                lines.extend(self.tool_activity_lines(&entry.body, entry.detail.as_deref()));
                continue;
            }
            if entry.kind == EntryKind::Reasoning {
                lines.extend(self.reasoning_summary_lines(&entry.body, width, None));
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
                let marker = if index == 0 {
                    marker.to_string()
                } else {
                    " ".repeat(UnicodeWidthStr::width(marker))
                };
                lines.push(Line::from(vec![
                    Span::styled(
                        marker,
                        Style::default()
                            .fg(marker_color)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        body_line.to_string(),
                        Style::default().fg(body_color).add_modifier(modifier),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        }
        for attempt in self
            .live_attempts
            .values()
            .filter(|attempt| attempt.is_conversation())
        {
            let activity = ["◐", "◓", "◑", "◒"][self.spinner % 4];
            if attempt.reasoning_summary.trim().is_empty()
                && attempt.text.trim().is_empty()
                && attempt.tools.is_empty()
            {
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{activity} "),
                        Style::default().fg(self.theme.brand),
                    ),
                    Span::styled(
                        "Thinking…",
                        Style::default()
                            .fg(self.theme.text_muted)
                            .add_modifier(Modifier::ITALIC),
                    ),
                ]));
                lines.push(Line::from(""));
            }
            if !attempt.reasoning_summary.trim().is_empty() && !attempt.reasoning_summary_persisted
            {
                lines.extend(self.reasoning_summary_lines(
                    &attempt.reasoning_summary,
                    width,
                    Some(activity),
                ));
            }
            if !attempt.text.trim().is_empty() {
                lines.extend(self.assistant_message_lines(&attempt.text, width));
                lines.push(Line::from(""));
            }
            for tool in attempt.tools.values() {
                let activity = summarize_tool_call(&tool.name, &tool.arguments, None);
                let mut body = format!("Using {}", activity.title);
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

    fn reasoning_summary_lines(
        &self,
        summary: &str,
        width: u16,
        live_marker: Option<&str>,
    ) -> Vec<Line<'static>> {
        let summary = truncate(summary, 4_000);
        let wrapped = wrap_display_lines(&summary, width.saturating_sub(2).max(1) as usize);
        let visible_count = if self.show_reasoning_details {
            wrapped.len()
        } else {
            wrapped.len().min(REASONING_PREVIEW_LINES)
        };
        let hidden_count = wrapped.len().saturating_sub(visible_count);
        let marker = live_marker.unwrap_or("•");
        let marker_color = if live_marker.is_some() {
            self.theme.brand
        } else {
            self.theme.text_muted
        };
        let mut lines = wrapped
            .into_iter()
            .take(visible_count)
            .enumerate()
            .map(|(index, line)| {
                Line::from(vec![
                    Span::styled(
                        if index == 0 {
                            format!("{marker} ")
                        } else {
                            "  ".to_string()
                        },
                        Style::default().fg(marker_color),
                    ),
                    Span::styled(
                        line,
                        Style::default()
                            .fg(self.theme.text_muted)
                            .add_modifier(Modifier::ITALIC),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        if hidden_count > 0 {
            lines.push(Line::from(vec![
                Span::raw("  "),
                Span::styled(
                    format!("… ({hidden_count} more lines · Ctrl+R to expand)"),
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
            let completed = cleaned.starts_with("Used ") || trimmed.starts_with('✓');
            let failed = cleaned.starts_with("Failed ") || trimmed.starts_with('!');
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
                    .filter(|(verb, _)| matches!(*verb, "Using" | "Used" | "Failed"))
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
        let horizontal_margin = (area.width / 24).clamp(2, 8);
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
                Span::styled("输入消息…", Style::default().fg(self.theme.text_muted)),
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
        let horizontal_margin = (area.width / 24).clamp(2, 8);
        let box_area = inset_rect(area, horizontal_margin, 0);
        let composer_block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(self.theme.border_strong))
            .padding(ratatui::widgets::Padding::horizontal(1));
        let inner = composer_block.inner(box_area);
        frame.render_widget(composer_block, box_area);
        frame.render_widget(Paragraph::new(content), inner);
        if show_cursor
            && self.pending_approval.is_none()
            && !self.show_help
            && !self.show_objectives
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
        let marker = "●";
        let marker_color = if self.busy {
            self.theme.warning
        } else {
            self.theme.success
        };
        let horizontal_margin = (area.width / 24).clamp(2, 8);
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
                        "取消当前会话任务？",
                        Style::default()
                            .fg(self.theme.warning)
                            .add_modifier(Modifier::BOLD),
                    ),
                ])),
                columns[0],
            );
            frame.render_widget(
                Paragraph::new("再按 Esc 确认  ·  其他按键继续")
                    .style(Style::default().fg(self.theme.warning))
                    .alignment(Alignment::Right),
                columns[1],
            );
            return;
        }
        let mut left = Vec::new();
        if !self.conversation_activity_is_visible() {
            left.extend([
                Span::styled(format!("{marker} "), Style::default().fg(marker_color)),
                Span::styled(
                    self.status.clone(),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled("  ·  ", Style::default().fg(self.theme.border_subtle)),
            ]);
        }
        left.push(Span::styled(
            self.model.clone(),
            Style::default().fg(self.theme.text_muted),
        ));
        if area.width >= 100 {
            left.push(Span::styled(
                format!("  ·  {}", self.working_directory),
                Style::default().fg(self.theme.text_muted),
            ));
        }
        frame.render_widget(Paragraph::new(Line::from(left)), columns[0]);
        let hints = if area.width < 112 {
            "? shortcuts"
        } else if self.active_view == UiView::Tasks {
            if self.show_task_diagnostics {
                "Tab summary  ·  Esc conversation  ·  ? shortcuts"
            } else {
                "Tab diagnostics  ·  Esc conversation  ·  ? shortcuts"
            }
        } else if self.active_view == UiView::Conversation {
            "Ctrl+P shell  ·  Ctrl+T/K views  ·  ? help"
        } else {
            "Esc conversation  ·  ? shortcuts"
        };
        frame.render_widget(
            Paragraph::new(hints)
                .style(Style::default().fg(self.theme.text_muted))
                .alignment(Alignment::Right),
            columns[1],
        );
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let help = Paragraph::new(vec![
            Line::from("Keyboard"),
            Line::from("  Enter                 Send"),
            Line::from("  Shift+Enter           Insert newline (enhanced terminals)"),
            Line::from("  Ctrl+J                Insert newline (portable fallback)"),
            Line::from("  Ctrl+T                Toggle Tasks view"),
            Line::from("  Ctrl+W                Compatibility alias for Tasks view"),
            Line::from("  Ctrl+K                Toggle Mind / Frame view"),
            Line::from("  Ctrl+P                Toggle embedded shell"),
            Line::from("  Tab                   Toggle Tasks summary/diagnostics"),
            Line::from("  Esc                   Return to Conversation view"),
            Line::from("  Esc Esc               Confirm, then cancel active task"),
            Line::from("  Ctrl+O                Expand/collapse Objectives"),
            Line::from("  Alt+T                 Cycle color theme"),
            Line::from("  Ctrl+R                Expand/collapse reasoning summaries"),
            Line::from("  Ctrl+C                Cancel active evaluation; quit when idle"),
            Line::from("  Ctrl+D                Exit Morphz"),
            Line::from("  Mouse wheel/PageUp    Scroll transcript"),
            Line::from("  Ctrl+Home/Ctrl+End    Jump to transcript start/end"),
            Line::from("  ?                     Toggle shortcuts (when input is empty)"),
            Line::from(""),
            Line::from("Commands"),
            Line::from("  /ctx   /objectives   /jobs   /tools   /theme   /cancel   /clear   /quit"),
            Line::from(""),
            Line::from("Press Esc or ? to close."),
        ])
        .block(
            Block::default()
                .title(" Keyboard shortcuts ")
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
                "Objectives",
                Style::default()
                    .fg(self.theme.brand)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {} non-terminal", self.objectives.len()),
                Style::default().fg(self.theme.text_muted),
            ),
        ])];
        lines.push(Line::from(""));
        if self.objectives.is_empty() {
            lines.push(Line::from(Span::styled(
                "当前 Context 没有进行中、暂停或阻塞的 Objective。",
                Style::default().fg(self.theme.text_muted),
            )));
        } else {
            for objective in ordered_objectives(&self.objectives, &self.session_id) {
                let status = objective.status.as_str();
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{} ", objective_status_marker(objective.status)),
                        Style::default()
                            .fg(objective_status_color(objective.status, &self.theme))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        status.to_uppercase(),
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
                            Span::styled("   原因  ", Style::default().fg(self.theme.text_muted)),
                            Span::styled(reason_line, Style::default().fg(self.theme.text_primary)),
                        ]));
                    }
                }
                let mut facts = vec![format!("rev {}", objective.revision)];
                if objective.coordinator_session_id == self.session_id {
                    facts.push("current session".to_string());
                } else {
                    facts.push(format!(
                        "session {}",
                        short_id(&objective.coordinator_session_id)
                    ));
                }
                if let Some(wait) = objective.wait_condition.as_ref() {
                    facts.push(format!("waiting: {}", format_objective_wait(wait)));
                } else if objective.active_evaluation_id.is_some() {
                    facts.push("evaluation running".to_string());
                }
                if let Some(budget) = objective.token_budget {
                    facts.push(format!("{} / {} tok", objective.tokens_used, budget));
                } else if objective.tokens_used > 0 {
                    facts.push(format!("{} tok", objective.tokens_used));
                }
                if objective.time_used_seconds > 0 {
                    facts.push(format_duration(objective.time_used_seconds));
                }
                lines.push(Line::from(Span::styled(
                    format!("   {}", facts.join("  ·  ")),
                    Style::default().fg(self.theme.text_muted),
                )));
                if let Some(parent) = objective.parent_objective_id.as_deref() {
                    lines.push(Line::from(Span::styled(
                        format!("   child of {}", short_id(parent)),
                        Style::default().fg(self.theme.text_muted),
                    )));
                }
                lines.push(Line::from(""));
            }
        }
        lines.push(Line::from(Span::styled(
            "Ctrl+O / Esc 收起  ·  PageUp / PageDown 滚动",
            Style::default().fg(self.theme.text_muted),
        )));
        let panel = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((self.objective_scroll, 0))
            .block(
                Block::default()
                    .title(" Context Objectives ")
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.focus))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().fg(self.theme.text_primary));
        frame.render_widget(panel, area);
    }

    fn render_approval(&self, frame: &mut Frame<'_>, area: Rect) {
        let Some(approval) = &self.pending_approval else {
            return;
        };
        frame.render_widget(Clear, area);
        let body = format!("{}\n\n[y] Allow once    [n] Deny", approval.text);
        let dialog = Paragraph::new(body)
            .wrap(Wrap { trim: false })
            .block(
                Block::default()
                    .title(" Permission approval ")
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(self.theme.warning))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().fg(self.theme.text_primary));
        frame.render_widget(dialog, area);
    }
}

enum UiAction {
    None,
    Submit(String),
    Quit,
    Cancel,
    Approve(bool),
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
        execute!(
            stdout,
            EnterAlternateScreen,
            EnableMouseCapture,
            EnableBracketedPaste
        )?;
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
            DisableMouseCapture,
            LeaveAlternateScreen
        );
        let _ = self.terminal.show_cursor();
    }
}

/// Runs the full-screen terminal frontend. Streamed assistant text is transient until the
/// Runtime commits the corresponding `chat/reply` terminal fact.
pub async fn run(
    runtime: MorphzRuntime,
    session: SessionHandle,
    initial_prompt: Option<String>,
) -> Result<(), TuiError> {
    let mut state = UiState::new(&runtime, &session);
    if let Ok(Some(record)) = session.record().await {
        state.context_id = record.context_id;
        state.session_title = Some(record.title);
    }
    if let Ok(history) = session.events(None).await {
        for event in &history {
            state.ingest_history(event);
        }
    }
    if let Ok(view) = session.inspect_context_view().await {
        state.update_context(&view);
    }
    if let Ok(delegations) = runtime.list_delegations().await {
        state.delegations = delegations;
    }

    let mut runtime_events = runtime.subscribe("*", 2_048);
    if let Some(prompt) = initial_prompt.filter(|value| !value.trim().is_empty()) {
        submit_prompt(&session, &mut state, prompt).await;
    }

    let mut terminal = TerminalSession::enter()?;
    if let Some(appearance) = terminal.detected_appearance {
        state.set_appearance(appearance);
    }
    let mut input_events = EventStream::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(80));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
            if shell_visible {
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
                        if is_shell_toggle_key(key) {
                            if shell_visible {
                                shell_visible = false;
                            } else {
                                let needs_shell = embedded_shell
                                    .as_mut()
                                    .is_none_or(shell::EmbeddedShell::is_finished);
                                if needs_shell {
                                    match shell::EmbeddedShell::spawn(&shell_cwd) {
                                        Ok(shell) => embedded_shell = Some(shell),
                                        Err(error) => {
                                            state.push(EntryKind::Error, format!("无法打开嵌入式 Shell：{error}"));
                                            embedded_shell = None;
                                        }
                                    }
                                }
                                shell_visible = embedded_shell.is_some();
                            }
                            continue;
                        }
                        if shell_visible {
                            if let Some(shell) = embedded_shell.as_mut() {
                                shell.send_key(key);
                            }
                            continue;
                        }
                        match key_action(&mut state, key) {
                            UiAction::None => {}
                            UiAction::Quit => break,
                            UiAction::Cancel => {
                                if session.cancel() {
                                    state.push(EntryKind::System, "已请求取消当前 Session 求值。后台物理任务仍由各自生命周期管理。");
                                    state.status = "cancelling".to_string();
                                } else {
                                    state.status = "nothing to cancel".to_string();
                                }
                            }
                            UiAction::Approve(allow) => {
                                if let Some(approval) = state.pending_approval.take() {
                                    let decision = if allow {
                                        ApprovalDecision::AllowOnce {
                                            rationale: "用户在 Morphz TUI 中批准".to_string(),
                                            risk_tags: vec!["human-approved".to_string()],
                                        }
                                    } else {
                                        ApprovalDecision::Deny {
                                            rationale: "用户在 Morphz TUI 中拒绝".to_string(),
                                            risk_tags: vec!["human-denied".to_string()],
                                        }
                                    };
                                    match runtime.decide_approval(&approval.id, decision).await {
                                        Ok(()) => state.push(EntryKind::System, if allow { "权限请求已批准一次。" } else { "权限请求已拒绝。" }),
                                        Err(error) => state.push(EntryKind::Error, error),
                                    }
                                }
                            }
                            UiAction::Submit(text) => {
                                if handle_command(&runtime, &session, &mut state, &text).await? {
                                    continue;
                                }
                                submit_prompt(&session, &mut state, text).await;
                            }
                        }
                    }
                    Event::Paste(text) if shell_visible => {
                        if let Some(shell) = embedded_shell.as_mut() {
                            shell.send_paste(&text);
                        }
                    }
                    Event::Paste(text) => state.composer.insert_str(&text),
                    Event::Mouse(mouse) if shell_visible => {
                        if let Some(shell) = embedded_shell.as_mut() {
                            shell.handle_mouse(mouse.kind);
                        }
                    }
                    Event::Mouse(mouse) => handle_mouse_scroll(&mut state, mouse.kind),
                    _ => {}
                }
            }
            event = runtime_events.recv() => {
                let Some(event) = event else {
                    state.push(EntryKind::Error, "Runtime 事件通道已关闭。");
                    state.busy = false;
                    continue;
                };
                let refresh = matches!(
                    event.topic.as_str(),
                    "chat/user_message"
                        | "chat/reply"
                        | "chat/no_reply"
                        | "chat/outbound_message"
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
            _ = tick.tick() => {
                state.spinner = state.spinner.wrapping_add(1);
            }
        }
    }
    Ok(())
}

async fn submit_prompt(session: &SessionHandle, state: &mut UiState, prompt: String) {
    state.begin_request(&prompt);
    let message_id = format!(
        "tui_{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    if let Err(error) = session.send(prompt, "User", Some(message_id)).await {
        state.push(EntryKind::Error, format!("发送消息失败：{error}"));
        state.busy = false;
        state.status = "send failed".to_string();
    }
}

async fn handle_command(
    runtime: &MorphzRuntime,
    session: &SessionHandle,
    state: &mut UiState,
    input: &str,
) -> Result<bool, TuiError> {
    let command = input.trim();
    if command == "/theme" {
        let theme_kind = state.cycle_theme();
        state.push(
            EntryKind::System,
            format!(
                "已切换到 {} 主题；本次 TUI 会话立即生效。",
                theme_kind.as_str()
            ),
        );
        return Ok(true);
    }
    if let Some(value) = command.strip_prefix("/theme ") {
        match TuiTheme::parse(value) {
            Some(theme_kind) => {
                state.set_theme(theme_kind);
                state.push(
                    EntryKind::System,
                    format!(
                        "已切换到 {} 主题；本次 TUI 会话立即生效。",
                        theme_kind.as_str()
                    ),
                );
            }
            None => state.push(
                EntryKind::Error,
                format!(
                    "未知主题 '{}'；可用 system、mono、iris、cyan、coral、no-color。",
                    value.trim()
                ),
            ),
        }
        return Ok(true);
    }
    match command {
        "/help" => {
            state.show_help = true;
            Ok(true)
        }
        "/clear" => {
            state.entries.clear();
            state.live_attempts.clear();
            Ok(true)
        }
        "/cancel" => {
            if session.cancel() {
                state.push(EntryKind::System, "已请求取消当前 Session 求值。");
            } else {
                state.push(EntryKind::System, "当前没有可取消的 Session 求值。");
            }
            Ok(true)
        }
        "/ctx" => {
            match session.inspect_context_view().await {
                Ok(view) => {
                    state.update_context(&view);
                    state.push(EntryKind::System, view.sexpr);
                }
                Err(error) => state.push(EntryKind::Error, format!("读取 Context 失败：{error}")),
            }
            Ok(true)
        }
        "/objective" | "/objectives" => {
            state.show_objectives = !state.show_objectives;
            state.objective_scroll = 0;
            Ok(true)
        }
        "/tools" => {
            state.show_tool_details = !state.show_tool_details;
            state.push(
                EntryKind::System,
                if state.show_tool_details {
                    "已展开工具调用的原始参数与结果。"
                } else {
                    "已收起工具调用的原始参数与结果。"
                },
            );
            Ok(true)
        }
        "/jobs" => {
            match runtime.list_delegations().await {
                Ok(jobs) if jobs.is_empty() => {
                    state.push(EntryKind::System, "当前没有 Sub Agent 任务。")
                }
                Ok(jobs) => {
                    let body = jobs
                        .into_iter()
                        .map(|job| {
                            format!(
                                "{}  [{}]  {}",
                                job.id,
                                job.status.as_str(),
                                truncate(&job.task.replace('\n', " "), 120)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    state.push(EntryKind::System, body);
                }
                Err(error) => state.push(EntryKind::Error, format!("读取任务失败：{error}")),
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn key_action(state: &mut UiState, key: KeyEvent) -> UiAction {
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('d') {
        return UiAction::Quit;
    }
    if state.pending_approval.is_some() {
        return match key.code {
            KeyCode::Char('y') | KeyCode::Char('Y') => UiAction::Approve(true),
            KeyCode::Char('n') | KeyCode::Char('N') => UiAction::Approve(false),
            _ => UiAction::None,
        };
    }
    if state.show_help {
        if is_theme_cycle_key(key) {
            state.cycle_theme();
        } else if key.code == KeyCode::Esc || is_shortcuts_key(key) {
            state.show_help = false;
        }
        return UiAction::None;
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
    if !state.busy || (state.cancel_confirmation_armed && key.code != KeyCode::Esc) {
        state.cancel_confirmation_armed = false;
    }
    if state.busy && state.active_view == UiView::Conversation && key.code == KeyCode::Esc {
        if state.cancel_confirmation_armed {
            state.cancel_confirmation_armed = false;
            return UiAction::Cancel;
        }
        state.cancel_confirmation_armed = true;
        return UiAction::None;
    }
    if is_theme_cycle_key(key) {
        state.cycle_theme();
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('r') | KeyCode::Char('R'))
    {
        state.show_reasoning_details = !state.show_reasoning_details;
        state.follow_tail = true;
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return if state.busy {
            UiAction::Cancel
        } else {
            UiAction::Quit
        };
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(
            key.code,
            KeyCode::Char('t') | KeyCode::Char('T') | KeyCode::Char('w') | KeyCode::Char('W')
        )
    {
        let next = if state.active_view == UiView::Tasks {
            UiView::Conversation
        } else {
            UiView::Tasks
        };
        state.set_active_view(next);
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && matches!(key.code, KeyCode::Char('k') | KeyCode::Char('K'))
    {
        let next = if state.active_view == UiView::Mind {
            UiView::Conversation
        } else {
            UiView::Mind
        };
        state.set_active_view(next);
        return UiAction::None;
    }
    if key.code == KeyCode::Tab && state.active_view == UiView::Tasks {
        state.show_task_diagnostics = !state.show_task_diagnostics;
        state.view_scroll = 0;
        return UiAction::None;
    }
    if key.code == KeyCode::Esc && state.active_view != UiView::Conversation {
        state.set_active_view(UiView::Conversation);
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('o') {
        state.show_objectives = true;
        state.objective_scroll = 0;
        return UiAction::None;
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
    match key.code {
        KeyCode::Char('?') if is_shortcuts_key(key) && state.composer.text().is_empty() => {
            state.show_help = true
        }
        KeyCode::Esc => state.composer.clear(),
        KeyCode::Enter
            if key.modifiers.contains(KeyModifiers::SHIFT)
                || key.modifiers.contains(KeyModifiers::ALT) =>
        {
            state.composer.insert('\n')
        }
        KeyCode::Enter => {
            let text = state.composer.take_trimmed();
            if text == "/quit" || text == "/exit" {
                return UiAction::Quit;
            }
            if !text.is_empty() {
                return UiAction::Submit(text);
            }
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

fn handle_mouse_scroll(state: &mut UiState, kind: MouseEventKind) {
    if state.pending_approval.is_some() || state.show_help {
        return;
    }
    let scrolling_up = match kind {
        MouseEventKind::ScrollUp => true,
        MouseEventKind::ScrollDown => false,
        _ => return,
    };
    if state.show_objectives {
        if scrolling_up {
            state.objective_scroll = state.objective_scroll.saturating_sub(MOUSE_SCROLL_LINES);
        } else {
            state.objective_scroll = state.objective_scroll.saturating_add(MOUSE_SCROLL_LINES);
        }
    } else if state.active_view == UiView::Conversation {
        if scrolling_up {
            state.scroll_transcript_up(MOUSE_SCROLL_LINES);
        } else {
            state.scroll_transcript_down(MOUSE_SCROLL_LINES);
        }
    } else if scrolling_up {
        state.view_scroll = state.view_scroll.saturating_sub(MOUSE_SCROLL_LINES);
    } else {
        state.view_scroll = state.view_scroll.saturating_add(MOUSE_SCROLL_LINES);
    }
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

fn is_shell_toggle_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL)
        && !key.modifiers.contains(KeyModifiers::ALT)
        && matches!(key.code, KeyCode::Char('p') | KeyCode::Char('P'))
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

fn push_more_hint(lines: &mut Vec<Line<'static>>, total: usize, shown: usize, color: Color) {
    if total > shown {
        lines.push(Line::from(Span::styled(
            format!("     … 另有 {} 项，按 Tab 查看详情", total - shown),
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
        "queued" | "waiting_tool" | "waiting_external" | "starting" | "kill_requested" => {
            theme.warning
        }
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

fn pressure_bar(used: usize, limit: usize, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let ratio = if limit == 0 {
        0.0
    } else {
        (used as f64 / limit as f64).clamp(0.0, 1.0)
    };
    let filled = (ratio * width as f64).round() as usize;
    format!("{}{}", "━".repeat(filled), "─".repeat(width - filled))
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

fn control_plane_horizontal_margin(width: u16) -> u16 {
    if width >= 100 {
        4
    } else {
        2
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

fn format_objective_wait(wait: &ObjectiveWaitCondition) -> String {
    match wait {
        ObjectiveWaitCondition::ToolTask { task_id } => {
            format!("tool task {}", short_id(task_id))
        }
        ObjectiveWaitCondition::Delegation { delegation_id } => {
            format!("delegation {}", short_id(delegation_id))
        }
        ObjectiveWaitCondition::Timer { deadline } => {
            format!("timer {}", deadline.format("%m-%d %H:%M UTC"))
        }
        ObjectiveWaitCondition::Permission { request_id } => {
            format!("permission {}", short_id(request_id))
        }
        ObjectiveWaitCondition::UserInput { session_id } => {
            format!("user input {}", short_id(session_id))
        }
        ObjectiveWaitCondition::ExternalEvent {
            topic,
            correlation_id,
        } => format!("event {topic} / {}", short_id(correlation_id)),
        ObjectiveWaitCondition::ResourceAvailable { resource } => {
            format!("resource {resource}")
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

fn format_tool_activity(payload: &serde_json::Map<String, Value>) -> Option<ToolActivity> {
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
        let summary = summarize_tool_call(name, arguments, Some(id));
        let mut lines = vec![format!("Using {}", summary.title)];
        if !summary.target.is_empty() {
            lines.push(format!("   {}", summary.target));
        }
        if !summary.meta.is_empty() {
            lines.push(format!("   {}", summary.meta.join("  ·  ")));
        }
        compact.push(lines.join("\n"));
        let route = format_causal_route(payload);
        detail.push(format!(
            "{} · {}{}\n{}",
            name,
            short_call_id(id),
            route,
            pretty_json(arguments)
        ));
    }
    if deduplicated > 0 {
        compact.push(format!(
            "↷ Skipped {deduplicated} duplicate context update(s)"
        ));
    }
    if rejected > 0 {
        compact.push(format!("! Rejected {rejected} unavailable tool call(s)"));
    }
    if compact.is_empty() {
        return None;
    }
    Some(ToolActivity {
        compact: compact.join("\n\n"),
        detail: detail.join("\n\n"),
    })
}

fn format_tool_result(payload: &serde_json::Map<String, Value>) -> Option<ToolActivity> {
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
            facts.push(execution.to_string());
        }
        if let Some(exit_code) = value.get("exit_code").and_then(Value::as_i64) {
            facts.push(format!("exit {exit_code}"));
        }
        if let Some(task_status) = value.get("task_status").and_then(Value::as_str) {
            facts.push(task_status.to_string());
        }
        if let Some(output_empty) = value.get("output_empty").and_then(Value::as_bool) {
            if output_empty {
                facts.push("no output".to_string());
            }
        }
    }
    if facts.is_empty() {
        facts.push(status.to_string());
    }
    let title = tool_title(name);
    let compact = if failed {
        format!("Failed {title}  ·  {}", facts.join("  ·  "))
    } else {
        format!("Used {title}  ·  {}", facts.join("  ·  "))
    };
    let call_id = payload
        .get("tool_call_id")
        .and_then(Value::as_str)
        .map(short_call_id)
        .unwrap_or_else(|| "no call id".to_string());
    let detail = format!(
        "{} · {} · {}{}\n{}",
        name,
        call_id,
        status,
        format_causal_route(payload),
        truncate(text, 2_000)
    );
    Some(ToolActivity { compact, detail })
}

fn format_causal_route(payload: &serde_json::Map<String, Value>) -> String {
    let mut fields = Vec::new();
    for (label, key) in [
        ("execution", "activation_id"),
        ("root", "root_turn_id"),
        ("trigger", "trigger_event_id"),
        ("cause", "caused_by"),
    ] {
        if let Some(value) = payload.get(key).and_then(Value::as_str) {
            fields.push(format!("{label} {}", short_id(value)));
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

fn summarize_tool_call(name: &str, arguments: &str, _call_id: Option<&str>) -> ToolSummary {
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
                format!("{query}  in  {path}")
            }
        }
        "list_files" => string("path"),
        "recall" => string("query"),
        "delegate" => string("task"),
        "check_task_after" | "wait_task" | "task_status" | "kill_task" => string("task_id"),
        "context_tx" => "Mind / Frame transaction".to_string(),
        "send_message" => format!("{} · {}", string("session_id"), string("content")),
        "no_reply" => "No message to active Session".to_string(),
        _ => first_scalar(&value),
    };
    target = truncate(&target.replace('\n', " "), 180);
    let mut meta = Vec::new();
    if name == "exec" {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            meta.push(format!("cwd {cwd}"));
        }
        if value
            .pointer("/requested_permissions/network")
            .and_then(Value::as_bool)
            == Some(true)
        {
            meta.push("network".to_string());
        }
        if value.get("sandbox_permissions").and_then(Value::as_str) == Some("require_escalated") {
            meta.push("approval required".to_string());
        }
        if let Some(wait_ms) = value.get("wait_ms").and_then(Value::as_u64) {
            meta.push(format!("wait {}s", wait_ms as f64 / 1_000.0));
        }
    }
    ToolSummary {
        title: tool_title(name).to_string(),
        target,
        meta,
    }
}

fn tool_title(name: &str) -> &'static str {
    match name {
        "read" => "Read file",
        "write" => "Write file",
        "edit" => "Edit file",
        "exec" => "Run command",
        "search" => "Search workspace",
        "list_files" => "Browse files",
        "recall" => "Recall evidence",
        "context_tx" => "Update context",
        "delegate" => "Delegate work",
        "list_tasks" => "List background tasks",
        "check_task_after" | "wait_task" => "Schedule task checkpoint",
        "task_status" => "Inspect background task",
        "kill_task" => "Stop background task",
        "send_message" => "Send Session message",
        "no_reply" => "Finish without message",
        _ => "Use tool",
    }
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
    use ratatui::backend::TestBackend;

    fn test_state(composer: Composer) -> UiState {
        UiState {
            agent_id: "agent-default".to_string(),
            context_id: "context-default".to_string(),
            session_id: "s".to_string(),
            session_title: Some("main".to_string()),
            model: "m".to_string(),
            working_directory: "~/Codes/Morphz".to_string(),
            entries: Vec::new(),
            composer,
            live_attempts: BTreeMap::new(),
            status: "ready".to_string(),
            context_status: "normal".to_string(),
            objectives: Vec::new(),
            context_view: None,
            delegations: Vec::new(),
            active_view: UiView::Conversation,
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
            objective_scroll: 0,
            cancel_confirmation_armed: false,
            appearance: TerminalAppearance::Dark,
            theme_kind: TuiTheme::Mono,
            theme: Theme::for_appearance(TuiTheme::Mono, TerminalAppearance::Dark),
        }
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
            ("attempt-b", "work-b", "objective", "beta draft"),
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
        assert!(first_frame.contains("◐ "));
        assert!(first_frame.contains("Thinking…"));
        state.spinner = 1;
        let next_frame = transcript_text(&state);
        assert!(next_frame.contains("◓ "));
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
        assert!(matches!(key_action(&mut state, ctrl_r), UiAction::None));
        assert!(state.show_reasoning_details);
        let expanded = transcript_text(&state);
        assert!(expanded.contains("third line"));
        assert!(expanded.contains("fourth line"));
        assert!(!expanded.contains("more lines · Ctrl+R to expand"));

        assert!(matches!(key_action(&mut state, ctrl_r), UiAction::None));
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
    fn footer_does_not_repeat_activity_already_visible_in_the_conversation() {
        let mut state = test_state(Composer::new());
        state.on_runtime_event(stream_runtime_event(
            "attempt-chat",
            "work-chat",
            "dialogue_turn",
            ModelStreamEvent::Started,
        ));

        assert!(transcript_text(&state).contains("Thinking…"));
        let conversation_footer = footer_text(&state);
        assert!(!conversation_footer.contains("thinking"));
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
            stated_objective: "Win TankWar and keep improving strategy".to_string(),
            revision: 3,
            status: ObjectiveStatus::Active,
            status_reason: Some("等待后台比赛结束后继续分析".to_string()),
            wait_condition: Some(ObjectiveWaitCondition::ToolTask {
                task_id: "task-123".to_string(),
            }),
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
    fn wide_header_uses_subtle_separators_between_identity_groups() {
        let state = test_state(Composer::new());
        let mut terminal = Terminal::new(TestBackend::new(160, 4)).unwrap();
        terminal
            .draw(|frame| state.render_header(frame, frame.area()))
            .unwrap();

        let separators = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .filter(|cell| cell.symbol() == "│")
            .collect::<Vec<_>>();
        assert_eq!(separators.len(), 6);
        assert!(separators
            .iter()
            .all(|cell| cell.fg == state.theme.border_subtle));
    }

    #[test]
    fn enter_submits_and_shift_enter_inserts_newline() {
        let mut composer = Composer::new();
        composer.insert_str("hello");
        let mut state = test_state(composer);
        assert!(matches!(
            key_action(&mut state, KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
            UiAction::Submit(value) if value == "hello"
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
            UiAction::None
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

        let mut legacy = test_state(Composer::new());
        key_action(
            &mut legacy,
            KeyEvent::new(KeyCode::F(1), KeyModifiers::NONE),
        );
        assert!(!legacy.show_help);
    }

    #[test]
    fn welcome_wordmark_is_branded_and_responsive() {
        let mut state = test_state(Composer::new());
        state.set_theme(TuiTheme::Iris);
        let styled = state.transcript_lines(120);
        let wordmark_colors = styled[1..=MORPHZ_WORDMARK.len()]
            .iter()
            .map(|line| line.spans[0].style.fg.expect("wordmark line has color"))
            .collect::<Vec<_>>();
        assert_eq!(wordmark_colors.first(), Some(&state.theme.wordmark_start));
        assert_eq!(wordmark_colors.last(), Some(&state.theme.wordmark_end));
        assert_ne!(wordmark_colors[1], wordmark_colors[4]);
        let leading_spaces = styled[1..=MORPHZ_WORDMARK.len()]
            .iter()
            .map(|line| {
                line.spans[0]
                    .content
                    .chars()
                    .take_while(|character| *character == ' ')
                    .count()
            })
            .collect::<Vec<_>>();
        assert_eq!(leading_spaces, vec![4, 4, 3, 3, 2, 2]);
        assert!(styled[1..=MORPHZ_WORDMARK.len()]
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
        assert!(wide.contains(MORPHZ_TAGLINE));
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
        assert!(narrow.contains(MORPHZ_TAGLINE));
        assert!(!narrow.contains(r"|  \/  | ___"));
        assert!(!narrow.contains("███╗   ███╗"));

        let tiny = state
            .transcript_lines(32)
            .into_iter()
            .flat_map(|line| line.spans.into_iter().map(|span| span.content.into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(tiny.contains("Morphz"));
        assert!(!tiny.contains(MORPHZ_TAGLINE));

        assert_eq!(
            interpolate_color(Color::Reset, Color::Rgb(1, 2, 3), 3, 5),
            Color::Reset
        );
    }

    #[test]
    fn ctrl_d_quits_from_normal_busy_and_modal_states() {
        let ctrl_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);

        let mut normal = test_state(Composer::new());
        assert!(matches!(key_action(&mut normal, ctrl_d), UiAction::Quit));

        let mut busy = test_state(Composer::new());
        busy.busy = true;
        assert!(matches!(key_action(&mut busy, ctrl_d), UiAction::Quit));

        let mut modal = test_state(Composer::new());
        modal.show_help = true;
        assert!(matches!(key_action(&mut modal, ctrl_d), UiAction::Quit));
    }

    #[test]
    fn escape_requires_a_visible_second_confirmation_before_cancelling() {
        let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        let mut composer = Composer::new();
        composer.insert_str("draft");
        let mut state = test_state(composer);
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
        assert!(matches!(key_action(&mut state, escape), UiAction::Cancel));
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
    fn ctrl_t_toggles_tasks_view_and_ctrl_w_remains_an_alias() {
        let mut state = test_state(Composer::new());
        assert!(!state.show_tool_details);
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
            ),
            UiAction::None
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
        assert_eq!(state.active_view, UiView::Tasks);
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
            UiAction::None
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
        let activity = format_tool_activity(payload.as_object().unwrap()).unwrap();
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
        let activity = format_tool_result(payload.as_object().unwrap()).unwrap();
        assert!(activity.compact.contains("Used Run command"));
        assert!(activity.compact.contains("sandboxed"));
        assert!(activity.compact.contains("exit 0"));
        assert!(activity.compact.contains("no output"));
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
        assert!(screen.contains(MORPHZ_TAGLINE));
        assert!(screen.contains("Directory"));
        assert!(screen.contains("Session"));
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
        assert_eq!(UnicodeWidthStr::width(USER_MESSAGE_PREFIX), 3);
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
        assert_eq!(user_line.spans[0].content, USER_MESSAGE_PREFIX);
        assert_eq!(user_line.spans[0].style.fg, Some(state.theme.brand));
        assert_eq!(user_line.spans[1].style.fg, Some(state.theme.brand));
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
        assert!(!terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .any(|cell| cell.symbol() == "✨"));

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
        assert!(screen.contains("? shortcuts"));
        assert!(!screen.contains("F1 shortcuts"));
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
    fn alt_t_cycles_the_four_dashboard_palettes_without_a_modal() {
        let mut state = test_state(Composer::new());
        let alt_t = KeyEvent::new(KeyCode::Char('t'), KeyModifiers::ALT);
        for expected in [
            TuiTheme::Cyan,
            TuiTheme::Iris,
            TuiTheme::Coral,
            TuiTheme::Mono,
            TuiTheme::Cyan,
        ] {
            assert!(matches!(key_action(&mut state, alt_t), UiAction::None));
            assert_eq!(state.theme_kind, expected);
            assert_eq!(
                state.theme,
                Theme::for_appearance(expected, TerminalAppearance::Dark)
            );
        }

        let before = state.theme_kind;
        let ctrl_p = KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL);
        assert!(is_shell_toggle_key(ctrl_p));
        assert!(matches!(key_action(&mut state, ctrl_p), UiAction::None));
        assert_eq!(state.theme_kind, before, "Ctrl+P is reserved for the shell");
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
            UiAction::None
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
        assert!(task_screen.contains("TASKS"));
        assert!(task_screen.contains("OBJECTIVES"));
        assert!(task_screen.contains("EXECUTION"));
        assert!(task_screen.contains("DELEGATIONS"));
        assert!(task_screen.contains("Win TankWar and keep improving strategy"));
        assert!(!task_screen.contains("WORK"));
        assert!(terminal.backend().cursor_visible());

        key_action(&mut state, KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert!(state.show_task_diagnostics);
        terminal.draw(|frame| state.render(frame)).unwrap();
        let diagnostic_task_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(diagnostic_task_screen.contains("TASKS"));
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
        assert!(mind_screen.contains("MIND"));

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
    fn tasks_view_uses_a_structured_empty_state_without_legacy_work_language() {
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
        assert!(screen.contains("OBJECTIVES"));
        assert!(screen.contains("IN FLIGHT"));
        assert!(screen.contains("DELEGATIONS"));
        assert!(!screen.contains("WORK"));
        let margin = control_plane_horizontal_margin(buffer.area.width);
        assert_eq!(
            buffer.cell((margin, 5)).map(|cell| cell.symbol()),
            Some("T")
        );
        assert_eq!(
            buffer.cell((margin, 8)).map(|cell| cell.symbol()),
            Some("│")
        );
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.tool));
        assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));
    }

    #[test]
    fn empty_mind_uses_one_centered_cognitive_frame_surface() {
        let state = test_state(Composer::new());
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
        assert!(screen.contains("COGNITIVE FRAMES"));
        assert!(screen.contains("r7"));
        assert!(!screen.contains("CONTEXT INSPECTOR"));
        assert!(!screen.contains("SELF-MAINTAINED"));
        assert!(buffer
            .content()
            .iter()
            .any(|cell| cell.fg == state.theme.focus));
        assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));
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
    fn transcript_mouse_scroll_and_jump_keys_reach_history_and_wordmark() {
        let mut state = test_state(Composer::new());
        for index in 0..30 {
            state.push(EntryKind::Assistant, format!("historical message {index}"));
        }
        let mut terminal = Terminal::new(TestBackend::new(80, 14)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        assert!(state.max_scroll > 3);
        assert_eq!(state.scroll, state.max_scroll);
        assert!(state.follow_tail);

        handle_mouse_scroll(&mut state, MouseEventKind::ScrollUp);
        let review_position = state.scroll;
        assert_eq!(review_position, state.max_scroll - MOUSE_SCROLL_LINES);
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
        assert!(screen.contains("Context Objectives"));
        assert!(screen.contains("ACTIVE"));
        assert!(compact_screen.contains("原因"));
        assert!(compact_screen.contains("等待后台比赛结束后继续分析"));
        assert!(screen.contains("waiting: tool task task-123"));
        assert!(screen.contains("32000 / 256000 tok"));
        assert!(!terminal.backend().cursor_visible());
    }
}
