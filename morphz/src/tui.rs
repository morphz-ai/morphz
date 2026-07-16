//! Full-screen terminal frontend for Morphz.
//!
//! The TUI consumes the same Runtime event stream as the classic CLI. Model
//! deltas are deliberately transient presentation state; only durable Runtime
//! facts such as user messages, tool receipts and terminal responses enter the transcript.

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
    DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, PopKeyboardEnhancementFlags,
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
use unicode_width::UnicodeWidthChar;

type TuiError = Box<dyn std::error::Error + Send + Sync>;

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
    focus: Color,
    user: Color,
    tool: Color,
    success: Color,
    warning: Color,
    error: Color,
}

impl Theme {
    fn from_kind(kind: TuiTheme) -> Self {
        let base = Self {
            // Named ANSI colors are resolved by the user's terminal theme.
            // Morphz deliberately never paints a background.
            border_subtle: Color::DarkGray,
            border_strong: Color::Gray,
            text_primary: Color::Reset,
            text_secondary: Color::Reset,
            text_muted: Color::DarkGray,
            brand: Color::Reset,
            focus: Color::Reset,
            user: Color::Reset,
            tool: Color::Cyan,
            success: Color::Green,
            warning: Color::Yellow,
            error: Color::Red,
        };
        match kind {
            // "system" intentionally resolves to the conservative terminal-
            // native mono palette. It remains stable across light/dark themes.
            TuiTheme::System | TuiTheme::Mono => base,
            TuiTheme::Iris => Self {
                brand: Color::LightMagenta,
                focus: Color::Magenta,
                user: Color::LightMagenta,
                ..base
            },
            TuiTheme::Cyan => Self {
                brand: Color::LightCyan,
                focus: Color::Cyan,
                user: Color::LightCyan,
                ..base
            },
            TuiTheme::Coral => Self {
                brand: Color::LightRed,
                focus: Color::Red,
                user: Color::LightRed,
                ..base
            },
            TuiTheme::NoColor => Self {
                border_subtle: Color::Reset,
                border_strong: Color::Reset,
                text_muted: Color::Reset,
                tool: Color::Reset,
                success: Color::Reset,
                warning: Color::Reset,
                error: Color::Reset,
                ..base
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    User,
    Assistant,
    Progress,
    Tool,
    System,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiView {
    Conversation,
    Work,
    Mind,
}

#[derive(Debug, Clone)]
struct TranscriptEntry {
    kind: EntryKind,
    body: String,
    detail: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct LiveToolCall {
    name: String,
    arguments: String,
    completed: bool,
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
    entries: Vec<TranscriptEntry>,
    composer: Composer,
    live_text: String,
    live_tools: BTreeMap<usize, LiveToolCall>,
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
    spinner: usize,
    pending_approval: Option<PendingApproval>,
    show_help: bool,
    show_tool_details: bool,
    show_objectives: bool,
    objective_scroll: u16,
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
        Self {
            agent_id: runtime.identity().agent_id.clone(),
            context_id: runtime.identity().context_id.clone(),
            session_id: session.id().to_string(),
            session_title: None,
            model: runtime.config().llm.model.clone(),
            entries: Vec::new(),
            composer: Composer::new(),
            live_text: String::new(),
            live_tools: BTreeMap::new(),
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
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_objectives: false,
            objective_scroll: 0,
            theme_kind,
            theme: Theme::from_kind(theme_kind),
        }
    }

    fn set_theme(&mut self, theme_kind: TuiTheme) {
        self.theme_kind = theme_kind;
        self.theme = Theme::from_kind(theme_kind);
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
        });
        if self.entries.len() > 500 {
            self.entries.drain(..100);
        }
        self.follow_tail = true;
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
        });
        if self.entries.len() > 500 {
            self.entries.drain(..100);
        }
        self.follow_tail = true;
    }

    fn begin_request(&mut self, prompt: &str) {
        self.push(EntryKind::User, prompt.to_string());
        self.busy = true;
        self.status = "queued".to_string();
        self.live_text.clear();
        self.live_tools.clear();
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
            view.active_work_items.len(),
            active_objectives
        );
        self.context_view = Some(view.clone());
    }

    fn finish_live_progress(&mut self) {
        if !self.live_text.trim().is_empty() {
            let text = std::mem::take(&mut self.live_text);
            self.push(EntryKind::Progress, text);
        }
        self.live_tools.clear();
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
            "chat/reply" | "chat/outbound_message" => self.push(EntryKind::Assistant, text),
            "chat/progress" => self.push(EntryKind::Progress, text),
            "runtime/tool_calls_selected" => {
                if let Some(activity) = format_tool_activity(&event.payload) {
                    self.push_tool(activity.compact, activity.detail);
                }
            }
            "chat/tool_output" => {
                if let Some(activity) = format_tool_result(&event.payload) {
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
                if let Some(value) = event.payload.get("stream") {
                    if let Ok(stream_event) =
                        serde_json::from_value::<ModelStreamEvent>(value.clone())
                    {
                        self.on_model_stream(stream_event);
                    }
                }
            }
            "runtime/tool_calls_selected" => {
                self.finish_live_progress();
                if let Some(activity) = format_tool_activity(&event.payload) {
                    self.push_tool(activity.compact, activity.detail);
                }
                self.status = "running tools".to_string();
            }
            "chat/tool_output" => {
                if let Some(activity) = format_tool_result(&event.payload) {
                    self.push_tool(activity.compact, activity.detail);
                }
                self.status = "processing results".to_string();
            }
            "chat/progress" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.push(EntryKind::Progress, text);
            }
            "chat/reply" => {
                let text = event
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.live_text.clear();
                self.live_tools.clear();
                self.push(EntryKind::Assistant, text);
                self.busy = false;
                self.status = "ready".to_string();
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
                self.live_text.clear();
                self.live_tools.clear();
                let background = event
                    .payload
                    .get("active_background_tasks")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if background > 0 {
                    self.busy = false;
                    self.status = format!("ready · {background} background task(s)");
                } else {
                    self.busy = false;
                    self.status = "ready · no reply".to_string();
                }
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

    fn on_model_stream(&mut self, event: ModelStreamEvent) {
        match event {
            ModelStreamEvent::Started => {
                self.busy = true;
                self.live_text.clear();
                self.live_tools.clear();
                self.status = "thinking".to_string();
            }
            ModelStreamEvent::TextDelta { text } => self.live_text.push_str(&text),
            ModelStreamEvent::ToolCallStarted { index, name, .. } => {
                self.live_tools.entry(index).or_default().name = name.clone();
                self.status = if name == "no_reply" {
                    "finishing silently".to_string()
                } else {
                    format!("preparing {name}")
                };
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta } => {
                let tool = self.live_tools.entry(index).or_default();
                tool.arguments.push_str(&delta);
            }
            ModelStreamEvent::ToolCallCompleted { index } => {
                if let Some(tool) = self.live_tools.get_mut(&index) {
                    tool.completed = true;
                }
            }
            ModelStreamEvent::Usage { .. } => {}
            ModelStreamEvent::Completed => {
                self.status = "processing response".to_string();
            }
            ModelStreamEvent::Failed { message } => {
                self.push(EntryKind::Error, message);
                self.status = "model error".to_string();
            }
        }
        self.follow_tail = true;
    }

    fn render(&mut self, frame: &mut Frame<'_>) {
        let size = frame.area();
        frame.render_widget(Block::default(), size);
        let input_lines = self.composer.text().split('\n').count().clamp(1, 5) as u16;
        let compact = size.width < 88 || size.height < 18;
        let header_height = if compact { 3 } else { 4 };
        let status_height = if compact { 1 } else { 3 };
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(header_height),
                Constraint::Length(status_height),
                Constraint::Min(4),
                Constraint::Length(input_lines + 3),
                Constraint::Length(1),
            ])
            .split(size);

        self.render_header(frame, chunks[0]);
        if self.active_view == UiView::Conversation {
            self.render_work_status(frame, chunks[1]);
            self.render_transcript(frame, chunks[2]);
        } else {
            self.render_chat_status(frame, chunks[1]);
            match self.active_view {
                UiView::Work => self.render_work_view(frame, chunks[2]),
                UiView::Mind => self.render_mind_view(frame, chunks[2]),
                UiView::Conversation => unreachable!(),
            }
        }
        self.render_composer(frame, chunks[3]);
        self.render_footer(frame, chunks[4]);
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

    fn primary_objective(&self) -> Option<&ObjectiveRecord> {
        self.objectives
            .iter()
            .find(|objective| {
                objective.coordinator_session_id == self.session_id
                    || objective.delivery_session_id == self.session_id
            })
            .or_else(|| {
                self.objectives
                    .iter()
                    .find(|objective| objective.status == ObjectiveStatus::Active)
            })
            .or_else(|| self.objectives.first())
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
        let inner = inset_rect(area, if area.width >= 100 { 4 } else { 2 }, 0);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(20),
                Constraint::Percentage(27),
                Constraint::Percentage(27),
                Constraint::Percentage(26),
            ])
            .split(inner);
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
        frame.render_widget(Paragraph::new(context), columns[1]);

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
        frame.render_widget(Paragraph::new(session), columns[2]);

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
            columns[3],
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

    fn runtime_work_counts(&self) -> (usize, usize, usize, usize) {
        let evaluations = self
            .context_view
            .as_ref()
            .map(|view| view.active_work_items.len())
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
        (evaluations, objectives, background, delegations)
    }

    fn render_work_status(&self, frame: &mut Frame<'_>, area: Rect) {
        let (evaluations, objectives, background, delegations) = self.runtime_work_counts();
        let total = evaluations + objectives + background + delegations;
        let marker = if total == 0 { "○" } else { "◒" };
        let marker_color = if total == 0 {
            self.theme.text_muted
        } else {
            self.theme.success
        };
        let current = self
            .primary_objective()
            .map(|objective| {
                format!(
                    "Objective · {}",
                    truncate(&objective.stated_objective.replace('\n', " "), 60)
                )
            })
            .or_else(|| {
                self.live_tools
                    .values()
                    .next()
                    .map(|tool| tool_title(&tool.name).to_string())
            })
            .unwrap_or_else(|| {
                if self.busy {
                    self.status.clone()
                } else {
                    "idle".to_string()
                }
            });
        if area.height < 3 {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(
                        " WORK  ",
                        Style::default()
                            .fg(self.theme.warning)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(format!("{marker} "), Style::default().fg(marker_color)),
                    Span::styled(current, Style::default().fg(self.theme.text_secondary)),
                    Span::styled("  ·  Ctrl+W", Style::default().fg(self.theme.text_muted)),
                ])),
                area,
            );
            return;
        }
        let strip = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(Style::default().fg(self.theme.border_subtle));
        let inner = inset_rect(strip.inner(area), if area.width >= 100 { 4 } else { 2 }, 0);
        frame.render_widget(strip, area);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(55),
                Constraint::Percentage(32),
                Constraint::Percentage(13),
            ])
            .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    "WORK  ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("{marker} "), Style::default().fg(marker_color)),
                Span::styled(current, Style::default().fg(self.theme.text_primary)),
            ])),
            columns[0],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!("{evaluations}"),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(" eval  ·  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    format!("{objectives}"),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(" goals  ·  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    format!("{} tasks", background + delegations),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]))
            .alignment(Alignment::Right),
            columns[1],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("工作台 ", Style::default().fg(self.theme.focus)),
                Span::styled("Ctrl W", Style::default().fg(self.theme.text_secondary)),
            ]))
            .alignment(Alignment::Right),
            columns[2],
        );
    }

    fn render_chat_status(&self, frame: &mut Frame<'_>, area: Rect) {
        if area.height < 3 {
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    Span::styled(
                        " CHAT  ",
                        Style::default()
                            .fg(self.theme.user)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("session/{}", short_id(&self.session_id)),
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
        let inner = inset_rect(strip.inner(area), if area.width >= 100 { 4 } else { 2 }, 0);
        frame.render_widget(strip, area);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    "CHAT  ",
                    Style::default()
                        .fg(self.theme.user)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("session/{}", short_id(&self.session_id)),
                    Style::default().fg(self.theme.text_secondary),
                ),
                Span::styled(
                    "  ·  对话输入仍然可用",
                    Style::default().fg(self.theme.text_muted),
                ),
            ])),
            inner,
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("返回对话 ", Style::default().fg(self.theme.user)),
                Span::styled("Esc", Style::default().fg(self.theme.text_secondary)),
            ]))
            .alignment(Alignment::Right),
            inner,
        );
    }

    fn work_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(vec![
                Span::styled(
                    "RUNTIME WORK",
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

        let work_items = self
            .context_view
            .as_ref()
            .map(|view| view.active_work_items.as_slice())
            .unwrap_or_default();
        lines.push(section_title(
            "EVALUATIONS",
            work_items.len(),
            self.theme.text_secondary,
            self.theme.text_muted,
        ));
        for item in work_items {
            lines.push(Line::from(vec![
                Span::styled("  ◇ ", Style::default().fg(self.theme.tool)),
                Span::styled(
                    item.status.as_str().to_uppercase(),
                    Style::default()
                        .fg(work_status_color(item.status.as_str(), &self.theme))
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
        if work_items.is_empty() {
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
                        .fg(work_status_color(
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
                        .fg(work_status_color(job.status.as_str(), &self.theme))
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
                    "SELF-MAINTAINED MIND",
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
                "Mind 尚未形成 Frame",
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
                "RETIRED {}  ·  PROTECTED {}  ·  CHECKPOINTS {}  ·  Ctrl+M / Esc 返回对话",
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
        count: usize,
        lines: Vec<Line<'static>>,
        accent: Color,
    ) {
        let title = Line::from(vec![
            Span::styled(
                format!(" {title} "),
                Style::default().fg(accent).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{count} "),
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

    fn evaluation_panel_lines(&self) -> Vec<Line<'static>> {
        let Some(view) = self.context_view.as_ref() else {
            return vec![empty_state_line("Context 正在加载", self.theme.text_muted)];
        };
        if view.active_work_items.is_empty() {
            return vec![empty_state_line(
                "没有活跃的模型求值",
                self.theme.text_muted,
            )];
        }
        view.active_work_items
            .iter()
            .flat_map(|item| {
                vec![
                    Line::from(vec![
                        Span::styled("◒ ", Style::default().fg(self.theme.tool)),
                        Span::styled(
                            item.status.as_str().to_uppercase(),
                            Style::default()
                                .fg(work_status_color(item.status.as_str(), &self.theme))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!("  {}", short_id(&item.id)),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]),
                    Line::from(Span::styled(
                        format!(
                            "  session/{} · {}",
                            short_id(&item.session_id),
                            item.trigger_kind
                        ),
                        Style::default().fg(self.theme.text_muted),
                    )),
                ]
            })
            .collect()
    }

    fn objective_panel_lines(&self) -> Vec<Line<'static>> {
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
                let mut lines = vec![
                    Line::from(vec![
                        Span::styled(
                            format!("{} ", objective_status_marker(objective.status)),
                            Style::default()
                                .fg(objective_status_color(objective.status, &self.theme)),
                        ),
                        Span::styled(
                            objective.status.as_str().to_uppercase(),
                            Style::default()
                                .fg(objective_status_color(objective.status, &self.theme))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!("  {} · r{}", short_id(&objective.id), objective.revision),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]),
                    Line::from(Span::styled(
                        format!(
                            "  {}",
                            truncate(&objective.stated_objective.replace('\n', " "), 120)
                        ),
                        Style::default().fg(self.theme.text_primary),
                    )),
                ];
                if let Some(wait) = objective.wait_condition.as_ref() {
                    lines.push(Line::from(Span::styled(
                        format!("  waiting · {}", format_objective_wait(wait)),
                        Style::default().fg(self.theme.warning),
                    )));
                }
                lines
            })
            .collect()
    }

    fn background_panel_lines(&self) -> Vec<Line<'static>> {
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
                vec![
                    Line::from(vec![
                        Span::styled("◒ ", Style::default().fg(self.theme.warning)),
                        Span::styled(
                            background_status_str(status).to_uppercase(),
                            Style::default()
                                .fg(work_status_color(
                                    background_status_str(status),
                                    &self.theme,
                                ))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!(
                                "  {} · {}s",
                                short_id(&id),
                                (Utc::now() - started_at).num_seconds().max(0)
                            ),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]),
                    Line::from(Span::styled(
                        format!("  {}", truncate(&command.replace('\n', " "), 120)),
                        Style::default().fg(self.theme.text_primary),
                    )),
                    Line::from(Span::styled(
                        format!("  session/{}", short_id(&session_id)),
                        Style::default().fg(self.theme.text_muted),
                    )),
                ]
            })
            .collect()
    }

    fn delegation_panel_lines(&self) -> Vec<Line<'static>> {
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
                vec![
                    Line::from(vec![
                        Span::styled("◇ ", Style::default().fg(self.theme.tool)),
                        Span::styled(
                            job.status.as_str().to_uppercase(),
                            Style::default()
                                .fg(work_status_color(job.status.as_str(), &self.theme))
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!("  {}", short_id(&job.id)),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ]),
                    Line::from(Span::styled(
                        format!("  {}", truncate(&job.task.replace('\n', " "), 120)),
                        Style::default().fg(self.theme.text_primary),
                    )),
                    Line::from(Span::styled(
                        format!("  child/{}", short_id(&job.child_session_id)),
                        Style::default().fg(self.theme.text_muted),
                    )),
                ]
            })
            .collect()
    }

    fn render_work_view(&mut self, frame: &mut Frame<'_>, area: Rect) {
        if area.width < 94 || area.height < 16 {
            let lines = self.work_lines();
            self.render_view_lines(frame, area, lines);
            return;
        }

        let inner = inset_rect(area, (area.width / 18).clamp(3, 10), 0);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Length(3),
                Constraint::Min(8),
            ])
            .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    "RUNTIME WORK  ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "可验证的执行事实 · 自由 Frame 不会被猜测成任务",
                    Style::default().fg(self.theme.text_muted),
                ),
            ])),
            rows[0],
        );
        let metrics = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
            ])
            .split(rows[1]);
        let (evaluations, objectives, background, delegations) = self.runtime_work_counts();
        self.render_metric_card(
            frame,
            metrics[0],
            "EVALUATIONS",
            evaluations.to_string(),
            "模型求值中".to_string(),
            self.theme.tool,
        );
        self.render_metric_card(
            frame,
            metrics[1],
            "OBJECTIVES",
            objectives.to_string(),
            "非终态目标".to_string(),
            self.theme.warning,
        );
        self.render_metric_card(
            frame,
            metrics[2],
            "BACKGROUND",
            background.to_string(),
            "物理任务".to_string(),
            self.theme.success,
        );
        self.render_metric_card(
            frame,
            metrics[3],
            "DELEGATIONS",
            delegations.to_string(),
            "Sub Agent".to_string(),
            self.theme.focus,
        );

        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[2]);
        let left = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(columns[0]);
        let right = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(columns[1]);
        self.render_section_panel(
            frame,
            left[0],
            "EVALUATIONS",
            evaluations,
            self.evaluation_panel_lines(),
            self.theme.tool,
        );
        self.render_section_panel(
            frame,
            left[1],
            "OBJECTIVES",
            objectives,
            self.objective_panel_lines(),
            self.theme.warning,
        );
        self.render_section_panel(
            frame,
            right[0],
            "BACKGROUND TASKS",
            background,
            self.background_panel_lines(),
            self.theme.success,
        );
        self.render_section_panel(
            frame,
            right[1],
            "DELEGATIONS",
            delegations,
            self.delegation_panel_lines(),
            self.theme.focus,
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

        let inner = inset_rect(area, (area.width / 18).clamp(3, 10), 0);
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(2),
                Constraint::Length(3),
                Constraint::Min(8),
            ])
            .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    "SELF-MAINTAINED MIND  ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!(
                        "context/{} · revision {}",
                        short_id(&view.context_id),
                        view.state.version
                    ),
                    Style::default().fg(self.theme.text_muted),
                ),
            ])),
            rows[0],
        );
        let metrics = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
                Constraint::Percentage(25),
            ])
            .split(rows[1]);
        self.render_metric_card(
            frame,
            metrics[0],
            "ACTIVE FRAMES",
            view.state.frames.len().to_string(),
            "当前求值可用".to_string(),
            self.theme.focus,
        );
        self.render_metric_card(
            frame,
            metrics[1],
            "RETIRED",
            view.state.retired.len().to_string(),
            "可按需 recall".to_string(),
            self.theme.text_secondary,
        );
        self.render_metric_card(
            frame,
            metrics[2],
            "PRESSURE",
            view.pressure.level.to_uppercase(),
            format!(
                "{} / {}",
                compact_count(view.pressure.estimated_tokens),
                compact_count(view.pressure.hard_limit)
            ),
            pressure_color(&view.pressure.level, &self.theme),
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

        let body = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(rows[2]);
        let frame_lines = if view.state.frames.is_empty() {
            vec![empty_state_line(
                "Mind 尚未形成 Frame",
                self.theme.text_muted,
            )]
        } else {
            view.state
                .frames
                .iter()
                .flat_map(|context_frame| {
                    let protection = if view.state.protected.contains(&context_frame.id) {
                        " · protected"
                    } else {
                        ""
                    };
                    let mut lines = vec![Line::from(vec![
                        Span::styled("◇ ", Style::default().fg(self.theme.focus)),
                        Span::styled(
                            context_frame.id.clone(),
                            Style::default()
                                .fg(self.theme.text_secondary)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            format!(
                                "  r{} · updated v{}{protection}",
                                context_frame.revision, context_frame.updated_version
                            ),
                            Style::default().fg(self.theme.text_muted),
                        ),
                    ])];
                    for body_line in truncate(&context_frame.body, 280).lines() {
                        lines.push(Line::from(Span::styled(
                            format!("  {body_line}"),
                            Style::default().fg(self.theme.text_primary),
                        )));
                    }
                    lines.push(Line::from(Span::styled(
                        format!("  {} source(s)", context_frame.sources.len()),
                        Style::default().fg(self.theme.text_muted),
                    )));
                    lines.push(Line::from(""));
                    lines
                })
                .collect()
        };
        self.render_section_panel(
            frame,
            body[0],
            "FRAME LIBRARY",
            view.state.frames.len(),
            frame_lines,
            self.theme.focus,
        );

        let mut inspector = vec![
            Line::from(vec![
                Span::styled("ENCODING  ", Style::default().fg(self.theme.text_muted)),
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
                Span::styled(
                    "CURRENT SESSION  ",
                    Style::default().fg(self.theme.text_muted),
                ),
                Span::styled(
                    short_id(&view.active_session_id),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ]),
            Line::from(Span::styled(
                format!(
                    "{} full · {} metadata · max {}",
                    view.session_working_set.full_session_ids.len(),
                    view.session_working_set.metadata_only_session_ids.len(),
                    view.session_working_set.max_sessions
                ),
                Style::default().fg(self.theme.text_muted),
            )),
            Line::from(""),
            Line::from(Span::styled(
                format!(
                    "PROTECTED {} · CHECKPOINTS {}",
                    view.state.protected.len(),
                    view.state.checkpoints.len()
                ),
                Style::default().fg(self.theme.text_secondary),
            )),
            Line::from(""),
            Line::from(Span::styled(
                format!("RELATIONS {}", view.state.relations.len()),
                Style::default().fg(self.theme.text_muted),
            )),
        ];
        for relation in view.state.relations.iter().take(8) {
            inspector.push(Line::from(Span::styled(
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
            "CONTEXT INSPECTOR",
            view.state.relations.len(),
            inspector,
            self.theme.text_secondary,
        );
    }

    fn transcript_lines(&self) -> Vec<Line<'static>> {
        const ROLE_WIDTH: usize = 14;
        let mut lines = Vec::new();
        for entry in &self.entries {
            if entry.kind == EntryKind::Tool {
                for (index, body_line) in entry.body.lines().enumerate() {
                    lines.push(Line::from(vec![
                        Span::styled("  │  ", Style::default().fg(self.theme.focus)),
                        Span::styled(
                            body_line.to_string(),
                            Style::default().fg(if index == 0 {
                                self.theme.tool
                            } else {
                                self.theme.text_muted
                            }),
                        ),
                    ]));
                }
                if self.show_tool_details {
                    if let Some(detail) = entry.detail.as_deref() {
                        for detail_line in truncate(detail, 1_600).lines() {
                            lines.push(Line::from(vec![
                                Span::styled("  │  ", Style::default().fg(self.theme.focus)),
                                Span::styled(
                                    detail_line.to_string(),
                                    Style::default().fg(self.theme.text_muted),
                                ),
                            ]));
                        }
                    }
                }
                lines.push(Line::from(""));
                continue;
            }
            let (label, color) = entry_style(entry.kind, &self.theme);
            for (index, body_line) in entry.body.lines().enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(
                        if index == 0 {
                            format!("{label:<ROLE_WIDTH$}")
                        } else {
                            " ".repeat(ROLE_WIDTH)
                        },
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        body_line.to_string(),
                        Style::default().fg(self.theme.text_primary),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        }
        if !self.live_text.trim().is_empty() {
            for (index, body_line) in self.live_text.lines().enumerate() {
                lines.push(Line::from(vec![
                    Span::styled(
                        if index == 0 {
                            format!("{:<ROLE_WIDTH$}", "Morphz")
                        } else {
                            " ".repeat(ROLE_WIDTH)
                        },
                        Style::default()
                            .fg(self.theme.brand)
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        body_line.to_string(),
                        Style::default().fg(self.theme.text_primary),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        }
        for tool in self.live_tools.values() {
            let activity = summarize_tool_call(&tool.name, &tool.arguments, None);
            let marker = if tool.completed { "✓" } else { "◇" };
            lines.push(Line::from(vec![
                Span::styled("  │  ", Style::default().fg(self.theme.focus)),
                Span::styled(
                    format!("{marker} {}", activity.title),
                    Style::default()
                        .fg(if tool.completed {
                            self.theme.success
                        } else {
                            self.theme.tool
                        })
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            if !activity.target.is_empty() {
                lines.push(Line::from(vec![
                    Span::styled("  │  ", Style::default().fg(self.theme.focus)),
                    Span::styled(activity.target, Style::default().fg(self.theme.text_muted)),
                ]));
            }
            if self.show_tool_details && !tool.arguments.is_empty() {
                lines.push(Line::from(vec![
                    Span::styled("  │  ", Style::default().fg(self.theme.focus)),
                    Span::styled(
                        truncate(&pretty_json(&tool.arguments), 800),
                        Style::default().fg(self.theme.text_muted),
                    ),
                ]));
            }
            lines.push(Line::from(""));
        }
        lines
    }

    fn render_transcript(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let lines = self.transcript_lines();
        let horizontal_margin = (area.width / 14).clamp(3, 14);
        let inner = inset_rect(area, horizontal_margin, 0);
        let heading_height = if inner.height >= 6 { 2 } else { 1 };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(heading_height), Constraint::Min(1)])
            .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("SESSION  ·  ", Style::default().fg(self.theme.text_muted)),
                Span::styled(
                    short_id(&self.session_id),
                    Style::default().fg(self.theme.text_secondary),
                ),
            ])),
            rows[0],
        );
        frame.render_widget(
            Paragraph::new("对话与执行互不阻塞")
                .style(Style::default().fg(self.theme.success))
                .alignment(Alignment::Right),
            rows[0],
        );
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        // Use Ratatui's own word-wrapping implementation. Dividing the display
        // width by the viewport width undercounts lines whenever wrapping leaves
        // unused cells at a word boundary (especially in mixed CJK/Markdown
        // text), which can leave the newest transcript entry behind the composer.
        let visual_lines = paragraph.line_count(rows[1].width);
        let viewport = rows[1].height as usize;
        let max_scroll = visual_lines.saturating_sub(viewport).min(u16::MAX as usize) as u16;
        if self.follow_tail {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }
        let paragraph = paragraph.scroll((self.scroll, 0));
        frame.render_widget(paragraph, rows[1]);
    }

    fn render_composer(&self, frame: &mut Frame<'_>, area: Rect) {
        let text = self.composer.text();
        let content = if text.is_empty() {
            vec![Line::from(vec![
                Span::styled(
                    "› ",
                    Style::default()
                        .fg(self.theme.focus)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "输入消息，Enter 发送…",
                    Style::default().fg(self.theme.text_muted),
                ),
            ])]
        } else {
            text.split('\n')
                .enumerate()
                .map(|(index, line)| {
                    Line::from(vec![
                        Span::styled(
                            if index == 0 { "› " } else { "  " },
                            Style::default()
                                .fg(self.theme.focus)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(
                            line.to_string(),
                            Style::default().fg(self.theme.text_primary),
                        ),
                    ])
                })
                .collect::<Vec<_>>()
        };
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(1), Constraint::Min(3)])
            .split(area);
        let horizontal_margin = (area.width / 14).clamp(3, 14);
        let status_area = inset_rect(rows[0], horizontal_margin, 0);
        let status = if self.busy {
            "Agent 正在工作，仍可追加消息"
        } else {
            "ready"
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    if self.busy { "●  " } else { "○  " },
                    Style::default().fg(if self.busy {
                        self.theme.success
                    } else {
                        self.theme.text_muted
                    }),
                ),
                Span::styled(status, Style::default().fg(self.theme.text_muted)),
            ])),
            status_area,
        );
        frame.render_widget(
            Paragraph::new(format!("当前 Session · {}", short_id(&self.session_id)))
                .style(Style::default().fg(self.theme.text_muted))
                .alignment(Alignment::Right),
            status_area,
        );
        let separator = Block::default()
            .borders(Borders::TOP | Borders::BOTTOM)
            .border_style(Style::default().fg(self.theme.border_subtle));
        let inner = inset_rect(separator.inner(rows[1]), horizontal_margin, 0);
        frame.render_widget(separator, rows[1]);
        frame.render_widget(Paragraph::new(content), inner);
        if self.pending_approval.is_none() && !self.show_help && !self.show_objectives {
            let (row, column) = self.composer.row_col();
            let x = inner
                .x
                .saturating_add(2)
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
        let tool_hint = if self.show_tool_details {
            " · Ctrl+T details on"
        } else {
            ""
        };
        let objective_hint = if self.objectives.is_empty() {
            ""
        } else {
            " · Ctrl+O goals"
        };
        let left = format!(
            " Enter 发送  ·  Ctrl+J 换行  ·  Ctrl+W 工作  ·  Ctrl+M 认知{objective_hint}{tool_hint}  ·  Ctrl+D 退出  ·  F1 帮助"
        );
        let style = Style::default().fg(self.theme.text_muted);
        frame.render_widget(
            Paragraph::new(left)
                .style(style)
                .block(
                    Block::default().padding(ratatui::widgets::Padding::horizontal(
                        (area.width / 14).clamp(3, 14),
                    )),
                ),
            area,
        );
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let help = Paragraph::new(vec![
            Line::from("Keyboard"),
            Line::from("  Enter                 Send"),
            Line::from("  Shift+Enter           Insert newline (enhanced terminals)"),
            Line::from("  Ctrl+J                Insert newline (portable fallback)"),
            Line::from("  Ctrl+W                Toggle Runtime Work view"),
            Line::from("  Ctrl+M                Toggle Mind / Frame view"),
            Line::from("  Esc                   Return to Conversation view"),
            Line::from("  Ctrl+O                Expand/collapse Objectives"),
            Line::from("  Ctrl+T                Toggle raw tool details"),
            Line::from("  Ctrl+C                Cancel active evaluation; quit when idle"),
            Line::from("  Ctrl+D                Exit Morphz"),
            Line::from("  PageUp/PageDown       Scroll transcript"),
            Line::from(""),
            Line::from("Commands"),
            Line::from("  /ctx   /objectives   /jobs   /theme   /cancel   /clear   /quit"),
            Line::from(""),
            Line::from("Press Esc or F1 to close."),
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
}

impl TerminalSession {
    fn enter() -> Result<Self, TuiError> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        let keyboard_enhancement_enabled = supports_keyboard_enhancement().unwrap_or(false);
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
    session: SessionHandle,
    initial_prompt: Option<String>,
) -> Result<(), TuiError> {
    let mut state = UiState::new(&runtime, &session);
    if let Ok(Some(record)) = session.record().await {
        state.context_id = record.context_id;
        state.session_title = Some(record.title);
    }
    if let Ok(history) = session.events(None).await {
        let start = history.len().saturating_sub(80);
        for event in &history[start..] {
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
    let mut input_events = EventStream::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(80));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        terminal.terminal.draw(|frame| state.render(frame))?;
        tokio::select! {
            maybe_event = input_events.next() => {
                let Some(event) = maybe_event else { break; };
                match event? {
                    Event::Key(key) if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
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
                                    match runtime.decide_approval(&approval.id, decision) {
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
                    Event::Paste(text) => state.composer.insert_str(&text),
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
                        | "runtime/model_attempt_started"
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
        state.push(
            EntryKind::System,
            format!(
                "当前主题：{}。可用：system、mono、iris、cyan、coral、no-color。",
                state.theme_kind.as_str()
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
            state.live_text.clear();
            state.live_tools.clear();
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
        if matches!(key.code, KeyCode::Esc | KeyCode::F(1)) {
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
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        return if state.busy {
            UiAction::Cancel
        } else {
            UiAction::Quit
        };
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('w') {
        let next = if state.active_view == UiView::Work {
            UiView::Conversation
        } else {
            UiView::Work
        };
        state.set_active_view(next);
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('m') {
        let next = if state.active_view == UiView::Mind {
            UiView::Conversation
        } else {
            UiView::Mind
        };
        state.set_active_view(next);
        return UiAction::None;
    }
    if key.code == KeyCode::Esc && state.active_view != UiView::Conversation {
        state.set_active_view(UiView::Conversation);
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('t') {
        state.show_tool_details = !state.show_tool_details;
        return UiAction::None;
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('o') {
        state.show_objectives = true;
        state.objective_scroll = 0;
        return UiAction::None;
    }
    match key.code {
        KeyCode::F(1) => state.show_help = true,
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
            state.follow_tail = false;
            state.scroll = state.scroll.saturating_sub(8);
        }
        KeyCode::PageDown => state.scroll = state.scroll.saturating_add(8),
        _ => {}
    }
    UiAction::None
}

fn entry_style(kind: EntryKind, theme: &Theme) -> (&'static str, Color) {
    match kind {
        EntryKind::User => ("You", theme.user),
        EntryKind::Assistant => ("Morphz", theme.brand),
        EntryKind::Progress => ("Morphz · working", theme.brand),
        EntryKind::Tool => ("Tool", theme.tool),
        EntryKind::System => ("System", theme.text_muted),
        EntryKind::Error => ("Error", theme.error),
    }
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

fn empty_state_line(message: impl Into<String>, color: Color) -> Line<'static> {
    Line::from(Span::styled(
        format!("  — {}", message.into()),
        Style::default().fg(color),
    ))
}

fn work_status_color(status: &str, theme: &Theme) -> Color {
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
        let mut lines = vec![format!("◇ {}", summary.title)];
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
    let marker = if failed { "!" } else { "✓" };
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
    let compact = format!("{marker} {title}\n   {}", facts.join("  ·  "));
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
        ("work", "work_item_id"),
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
        "wait_task" | "task_status" | "kill_task" => string("task_id"),
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
        "wait_task" => "Schedule task wakeup",
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
            entries: Vec::new(),
            composer,
            live_text: String::new(),
            live_tools: BTreeMap::new(),
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
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_objectives: false,
            objective_scroll: 0,
            theme_kind: TuiTheme::Mono,
            theme: Theme::from_kind(TuiTheme::Mono),
        }
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
    fn ctrl_t_toggles_tool_details() {
        let mut state = test_state(Composer::new());
        assert!(!state.show_tool_details);
        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL)
            ),
            UiAction::None
        ));
        assert!(state.show_tool_details);
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
        assert!(activity.compact.contains("✓ Run command"));
        assert!(activity.compact.contains("sandboxed"));
        assert!(activity.compact.contains("exit 0"));
        assert!(activity.compact.contains("no output"));
    }

    #[test]
    fn tui_renders_compact_tools_and_visible_input_cursor() {
        let mut state = test_state(Composer::new());
        state.objectives.push(test_objective());
        state.push_tool(
            "◇ Run command\n   cargo test\n   network  ·  approval required",
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
        assert!(screen.contains("SESSION"));
        assert!(screen.contains("WORK"));
        assert!(screen.contains("Run command"));
        assert!(screen.contains("cargo test"));
        assert!(screen.contains("Objective"));
        assert!(screen.contains("Win TankWar and keep improving strategy"));
        assert!(!screen.contains("requested_permissions"));
        assert!(terminal.backend().cursor_visible());
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
        state.push_tool("◇ Run command\n   cargo test --workspace", "");
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
        let mono = Theme::from_kind(TuiTheme::Mono);
        let iris = Theme::from_kind(TuiTheme::Iris);
        let cyan = Theme::from_kind(TuiTheme::Cyan);
        let coral = Theme::from_kind(TuiTheme::Coral);
        let no_color = Theme::from_kind(TuiTheme::NoColor);

        assert_eq!(mono.brand, Color::Reset);
        assert_eq!(iris.brand, Color::LightMagenta);
        assert_eq!(cyan.brand, Color::LightCyan);
        assert_eq!(coral.brand, Color::LightRed);
        assert_eq!(no_color.brand, Color::Reset);
        assert_eq!(no_color.success, Color::Reset);
    }

    #[test]
    fn ctrl_w_and_ctrl_m_switch_full_views_while_escape_returns_to_chat() {
        let mut state = test_state(Composer::new());
        assert_eq!(state.active_view, UiView::Conversation);

        assert!(matches!(
            key_action(
                &mut state,
                KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL)
            ),
            UiAction::None
        ));
        assert_eq!(state.active_view, UiView::Work);
        let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
        terminal.draw(|frame| state.render(frame)).unwrap();
        let work_screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(work_screen.contains("RUNTIME WORK"));
        assert!(work_screen.contains("EVALUATIONS"));
        assert!(work_screen.contains("OBJECTIVES"));
        assert!(work_screen.contains("BACKGROUND TASKS"));
        assert!(work_screen.contains("DELEGATIONS"));
        assert!(work_screen.contains("CHAT"));
        assert!(terminal.backend().cursor_visible());

        key_action(
            &mut state,
            KeyEvent::new(KeyCode::Char('m'), KeyModifiers::CONTROL),
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

        key_action(&mut state, KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert_eq!(state.active_view, UiView::Conversation);
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
