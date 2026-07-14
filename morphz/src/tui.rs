//! Full-screen terminal frontend for Morphz.
//!
//! The TUI consumes the same Runtime event stream as the classic CLI. Model
//! deltas are deliberately transient presentation state; only durable Runtime
//! facts such as user messages, tool receipts and `reply` enter the transcript.

use crate::approval::ApprovalDecision;
use crate::event::Event as RuntimeEvent;
use crate::llm::ModelStreamEvent;
use crate::memory::{ObjectiveRecord, ObjectiveStatus, ObjectiveWaitCondition};
use crate::orchestrator::context::ContextView;
use crate::runtime::{MorphzRuntime, SessionHandle};
use chrono::Utc;
use crossterm::cursor::Show;
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event,
    EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, KeyboardEnhancementFlags,
    MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
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

const BG: Color = Color::Rgb(13, 17, 23);
const SURFACE: Color = Color::Rgb(22, 27, 34);
const SURFACE_RAISED: Color = Color::Rgb(28, 33, 42);
const BORDER: Color = Color::Rgb(48, 54, 61);
const TEXT: Color = Color::Rgb(230, 237, 243);
const MUTED: Color = Color::Rgb(139, 148, 158);
const ACCENT: Color = Color::Rgb(121, 160, 247);
const USER: Color = Color::Rgb(187, 154, 247);
const TOOL: Color = Color::Rgb(86, 211, 214);
const SUCCESS: Color = Color::Rgb(63, 185, 80);
const WARNING: Color = Color::Rgb(210, 153, 34);
const ERROR: Color = Color::Rgb(248, 81, 73);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    User,
    Assistant,
    Progress,
    Tool,
    System,
    Error,
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
    session_id: String,
    model: String,
    entries: Vec<TranscriptEntry>,
    composer: Composer,
    live_text: String,
    live_tools: BTreeMap<usize, LiveToolCall>,
    reply_draft: String,
    status: String,
    context_status: String,
    objectives: Vec<ObjectiveRecord>,
    busy: bool,
    follow_tail: bool,
    scroll: u16,
    spinner: usize,
    pending_approval: Option<PendingApproval>,
    show_help: bool,
    show_tool_details: bool,
    show_objectives: bool,
    objective_scroll: u16,
}

impl UiState {
    fn new(runtime: &MorphzRuntime, session: &SessionHandle) -> Self {
        Self {
            session_id: session.id().to_string(),
            model: runtime.config().llm.model.clone(),
            entries: Vec::new(),
            composer: Composer::new(),
            live_text: String::new(),
            live_tools: BTreeMap::new(),
            reply_draft: String::new(),
            status: "ready".to_string(),
            context_status: "Context loading".to_string(),
            objectives: Vec::new(),
            busy: false,
            follow_tail: true,
            scroll: 0,
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_objectives: false,
            objective_scroll: 0,
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
        self.reply_draft.clear();
    }

    fn update_context(&mut self, view: &ContextView) {
        self.objectives = view.objectives.clone();
        let active_objectives = view
            .objectives
            .iter()
            .filter(|objective| objective.status == ObjectiveStatus::Active)
            .count();
        self.context_status = format!(
            "{} · {}/{} tok · {} frame · {} objective",
            view.pressure.level,
            view.pressure.estimated_tokens,
            view.pressure.hard_limit,
            view.pressure.active_frames,
            active_objectives
        );
    }

    fn finish_live_progress(&mut self) {
        if !self.live_text.trim().is_empty() {
            let text = std::mem::take(&mut self.live_text);
            self.push(EntryKind::Progress, text);
        }
        self.live_tools.clear();
        self.reply_draft.clear();
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
            "chat/reply" => self.push(EntryKind::Assistant, text),
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
                self.reply_draft.clear();
                self.push(EntryKind::Assistant, text);
                self.busy = false;
                self.status = "ready".to_string();
            }
            "chat/reply_suppressed" => {
                self.live_text.clear();
                self.live_tools.clear();
                self.reply_draft.clear();
                let background = event
                    .payload
                    .get("active_background_tasks")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if background > 0 {
                    self.busy = true;
                    self.status = format!("waiting · {background} background task(s)");
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
                self.reply_draft.clear();
                self.status = "thinking".to_string();
            }
            ModelStreamEvent::TextDelta { text } => self.live_text.push_str(&text),
            ModelStreamEvent::ToolCallStarted { index, name, .. } => {
                self.live_tools.entry(index).or_default().name = name.clone();
                self.status = if name == "reply" {
                    "composing reply".to_string()
                } else {
                    format!("preparing {name}")
                };
            }
            ModelStreamEvent::ToolArgumentsDelta { index, delta } => {
                let tool = self.live_tools.entry(index).or_default();
                tool.arguments.push_str(&delta);
                if tool.name == "reply" {
                    self.reply_draft = extract_partial_json_string(&tool.arguments, "content");
                }
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
        frame.render_widget(Block::default().style(Style::default().bg(BG)), size);
        let input_lines = self.composer.text().split('\n').count().clamp(1, 5) as u16;
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Length(1),
                Constraint::Min(5),
                Constraint::Length(input_lines + 2),
                Constraint::Length(1),
            ])
            .split(size);

        self.render_header(frame, chunks[0]);
        self.render_objective_summary(frame, chunks[1]);
        self.render_transcript(frame, chunks[2]);
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

    fn render_objective_summary(&self, frame: &mut Frame<'_>, area: Rect) {
        let line = if let Some(objective) = self.primary_objective() {
            let extra = self.objectives.len().saturating_sub(1);
            let suffix = if extra == 0 {
                "Ctrl+O 展开".to_string()
            } else {
                format!("+{extra}  ·  Ctrl+O 展开")
            };
            Line::from(vec![
                Span::styled(
                    format!(" {} ", objective_status_marker(objective.status)),
                    Style::default().fg(objective_status_color(objective.status)),
                ),
                Span::styled("OBJECTIVE  ", Style::default().fg(MUTED)),
                Span::styled(
                    objective.status.as_str().to_uppercase(),
                    Style::default()
                        .fg(objective_status_color(objective.status))
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled("  ·  ", Style::default().fg(BORDER)),
                Span::styled(
                    truncate(&objective.stated_objective.replace('\n', " "), 110),
                    Style::default().fg(TEXT),
                ),
                Span::styled(format!("  ·  {suffix} "), Style::default().fg(MUTED)),
            ])
        } else {
            Line::from(vec![
                Span::styled(" ○ ", Style::default().fg(MUTED)),
                Span::styled("OBJECTIVE  none", Style::default().fg(MUTED)),
                Span::styled("  ·  Ctrl+O 查看 ", Style::default().fg(BORDER)),
            ])
        };
        frame.render_widget(Paragraph::new(line).style(Style::default().bg(BG)), area);
    }

    fn render_header(&self, frame: &mut Frame<'_>, area: Rect) {
        let spinner = ["◐", "◓", "◑", "◒"][self.spinner % 4];
        let activity = if self.busy { spinner } else { "●" };
        let activity_color = if self.busy { WARNING } else { SUCCESS };
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(BORDER))
            .style(Style::default().bg(SURFACE));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
            .split(inner);
        let left = Line::from(vec![
            Span::styled(
                " ◆ MORPHZ",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::raw("   "),
            Span::styled(activity, Style::default().fg(activity_color)),
            Span::styled(format!("  {}", self.status), Style::default().fg(TEXT)),
        ]);
        frame.render_widget(Paragraph::new(left), chunks[0]);
        let right = Line::from(vec![
            Span::styled(short_id(&self.session_id), Style::default().fg(MUTED)),
            Span::styled("  ·  ", Style::default().fg(BORDER)),
            Span::styled(&self.model, Style::default().fg(MUTED)),
            Span::raw(" "),
        ]);
        frame.render_widget(Paragraph::new(right).alignment(Alignment::Right), chunks[1]);
    }

    fn transcript_lines(&self) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        for entry in &self.entries {
            if entry.kind == EntryKind::Tool {
                append_tool_lines(
                    &mut lines,
                    &entry.body,
                    entry.detail.as_deref(),
                    self.show_tool_details,
                );
                lines.push(Line::from(""));
                continue;
            }
            let (label, color) = entry_style(entry.kind);
            lines.push(Line::from(Span::styled(
                label,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            )));
            for line in entry.body.lines() {
                lines.push(Line::from(Span::styled(
                    format!("   {line}"),
                    Style::default().fg(TEXT),
                )));
            }
            lines.push(Line::from(""));
        }
        if !self.live_text.trim().is_empty() {
            lines.push(Line::from(Span::styled(
                "◆ MORPHZ · LIVE",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            )));
            for line in self.live_text.lines() {
                lines.push(Line::from(format!("  {line}")));
            }
            lines.push(Line::from(""));
        }
        for tool in self.live_tools.values().filter(|tool| tool.name != "reply") {
            let activity = summarize_tool_call(&tool.name, &tool.arguments, None);
            let marker = if tool.completed { "✓" } else { "◇" };
            lines.push(Line::from(Span::styled(
                format!("{marker} {}", activity.title),
                Style::default()
                    .fg(if tool.completed { SUCCESS } else { TOOL })
                    .add_modifier(Modifier::BOLD),
            )));
            if !activity.target.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!("   {}", activity.target),
                    Style::default().fg(TEXT),
                )));
            }
            if self.show_tool_details && !tool.arguments.is_empty() {
                lines.push(Line::from(Span::styled(
                    format!("   {}", truncate(&pretty_json(&tool.arguments), 800)),
                    Style::default().fg(MUTED),
                )));
            }
            lines.push(Line::from(""));
        }
        if !self.reply_draft.is_empty() {
            lines.push(Line::from(Span::styled(
                "MORPHZ · DRAFT",
                Style::default().fg(SUCCESS).add_modifier(Modifier::BOLD),
            )));
            for line in self.reply_draft.lines() {
                lines.push(Line::from(format!("  {line}")));
            }
        }
        lines
    }

    fn render_transcript(&mut self, frame: &mut Frame<'_>, area: Rect) {
        let lines = self.transcript_lines();
        let block = Block::default()
            .style(Style::default().bg(BG))
            .padding(ratatui::widgets::Padding::horizontal(2));
        let inner = block.inner(area);
        let paragraph = Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false });
        // Use Ratatui's own word-wrapping implementation. Dividing the display
        // width by the viewport width undercounts lines whenever wrapping leaves
        // unused cells at a word boundary (especially in mixed CJK/Markdown
        // text), which can leave the newest transcript entry behind the composer.
        let visual_lines = paragraph.line_count(inner.width);
        let viewport = inner.height as usize;
        let max_scroll = visual_lines.saturating_sub(viewport).min(u16::MAX as usize) as u16;
        if self.follow_tail {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
        }
        let paragraph = paragraph.scroll((self.scroll, 0));
        frame.render_widget(paragraph, area);
    }

    fn render_composer(&self, frame: &mut Frame<'_>, area: Rect) {
        let title = if self.busy {
            " INPUT · Agent 正在工作，仍可追加消息 "
        } else {
            " INPUT "
        };
        let text = self.composer.text();
        let content = if text.is_empty() {
            vec![Line::from(vec![
                Span::styled(
                    "› ",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled("输入消息，Enter 发送…", Style::default().fg(MUTED)),
            ])]
        } else {
            text.split('\n')
                .enumerate()
                .map(|(index, line)| {
                    Line::from(vec![
                        Span::styled(
                            if index == 0 { "› " } else { "  " },
                            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                        ),
                        Span::styled(line.to_string(), Style::default().fg(TEXT)),
                    ])
                })
                .collect::<Vec<_>>()
        };
        let input = Paragraph::new(content)
            .style(Style::default().bg(SURFACE_RAISED))
            .block(
                Block::default()
                    .title(Span::styled(title, Style::default().fg(ACCENT)))
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(ACCENT))
                    .padding(ratatui::widgets::Padding::horizontal(1)),
            );
        frame.render_widget(input, area);
        if self.pending_approval.is_none() && !self.show_help && !self.show_objectives {
            let (row, column) = self.composer.row_col();
            let x = area
                .x
                .saturating_add(4)
                .saturating_add(column as u16)
                .min(area.right().saturating_sub(2));
            let y = area
                .y
                .saturating_add(1)
                .saturating_add(row as u16)
                .min(area.bottom().saturating_sub(2));
            frame.set_cursor_position((x, y));
        }
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let detail = if self.show_tool_details {
            "details on"
        } else {
            "details off"
        };
        let left = format!(
            " Enter 发送  ·  Shift+Enter / Ctrl+J 换行  ·  Ctrl+O 目标  ·  Ctrl+T 工具详情 {detail}  ·  F1 帮助 "
        );
        let right = format!("{} ", self.context_status);
        let width = area.width as usize;
        let padding = width.saturating_sub(left.chars().count() + right.chars().count());
        let line = Line::from(vec![
            Span::styled(left, Style::default().fg(MUTED)),
            Span::raw(" ".repeat(padding)),
            Span::styled(right, Style::default().fg(MUTED)),
        ]);
        frame.render_widget(Paragraph::new(line).style(Style::default().bg(BG)), area);
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let help = Paragraph::new(vec![
            Line::from("Keyboard"),
            Line::from("  Enter                 Send"),
            Line::from("  Shift+Enter           Insert newline (enhanced terminals)"),
            Line::from("  Ctrl+J                Insert newline (portable fallback)"),
            Line::from("  Ctrl+O                Expand/collapse Objectives"),
            Line::from("  Ctrl+T                Toggle raw tool details"),
            Line::from("  Ctrl+C                Cancel active evaluation; quit when idle"),
            Line::from("  PageUp/PageDown       Scroll transcript"),
            Line::from(""),
            Line::from("Commands"),
            Line::from("  /ctx   /objectives   /jobs   /cancel   /clear   /quit"),
            Line::from(""),
            Line::from("Press Esc or F1 to close."),
        ])
        .block(
            Block::default()
                .title(" Morphz help ")
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(ACCENT))
                .padding(ratatui::widgets::Padding::uniform(1)),
        )
        .style(Style::default().bg(SURFACE_RAISED).fg(TEXT));
        frame.render_widget(help, area);
    }

    fn render_objectives(&self, frame: &mut Frame<'_>, area: Rect) {
        frame.render_widget(Clear, area);
        let mut lines = vec![Line::from(vec![
            Span::styled(
                "OBJECTIVES",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("  {} non-terminal", self.objectives.len()),
                Style::default().fg(MUTED),
            ),
        ])];
        lines.push(Line::from(""));
        if self.objectives.is_empty() {
            lines.push(Line::from(Span::styled(
                "当前 Context 没有进行中、暂停或阻塞的 Objective。",
                Style::default().fg(MUTED),
            )));
        } else {
            for objective in ordered_objectives(&self.objectives, &self.session_id) {
                let status = objective.status.as_str();
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{} ", objective_status_marker(objective.status)),
                        Style::default()
                            .fg(objective_status_color(objective.status))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        status.to_uppercase(),
                        Style::default()
                            .fg(objective_status_color(objective.status))
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {}", short_id(&objective.id)),
                        Style::default().fg(MUTED),
                    ),
                ]));
                for statement_line in objective.stated_objective.lines() {
                    lines.push(Line::from(Span::styled(
                        format!("   {statement_line}"),
                        Style::default().fg(TEXT),
                    )));
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
                    Style::default().fg(MUTED),
                )));
                if let Some(parent) = objective.parent_objective_id.as_deref() {
                    lines.push(Line::from(Span::styled(
                        format!("   child of {}", short_id(parent)),
                        Style::default().fg(MUTED),
                    )));
                }
                lines.push(Line::from(""));
            }
        }
        lines.push(Line::from(Span::styled(
            "Ctrl+O / Esc 收起  ·  PageUp / PageDown 滚动",
            Style::default().fg(MUTED),
        )));
        let panel = Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((self.objective_scroll, 0))
            .block(
                Block::default()
                    .title(" Context Objectives ")
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::default().fg(ACCENT))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().bg(SURFACE_RAISED).fg(TEXT));
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
                    .border_style(Style::default().fg(WARNING))
                    .padding(ratatui::widgets::Padding::uniform(1)),
            )
            .style(Style::default().bg(SURFACE_RAISED).fg(TEXT));
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
        execute!(
            stdout,
            EnterAlternateScreen,
            EnableBracketedPaste,
            EnableMouseCapture
        )?;
        if keyboard_enhancement_enabled {
            execute!(
                stdout,
                PushKeyboardEnhancementFlags(
                    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | KeyboardEnhancementFlags::REPORT_EVENT_TYPES
                )
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

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        if self.keyboard_enhancement_enabled {
            let _ = execute!(self.terminal.backend_mut(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(
            self.terminal.backend_mut(),
            Show,
            DisableMouseCapture,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = self.terminal.show_cursor();
    }
}

/// Runs the fullscreen frontend. `reply` remains the only final delivery fact;
/// streamed text/tool arguments are rendered as an in-memory draft.
pub async fn run(
    runtime: MorphzRuntime,
    session: SessionHandle,
    initial_prompt: Option<String>,
) -> Result<(), TuiError> {
    let mut state = UiState::new(&runtime, &session);
    if let Ok(history) = session.events(None).await {
        let start = history.len().saturating_sub(80);
        for event in &history[start..] {
            state.ingest_history(event);
        }
    }
    if let Ok(view) = session.inspect_context_view().await {
        state.update_context(&view);
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
                    Event::Mouse(mouse) => match mouse.kind {
                        MouseEventKind::ScrollUp => {
                            if state.show_objectives {
                                state.objective_scroll = state.objective_scroll.saturating_sub(4);
                            } else {
                                state.follow_tail = false;
                                state.scroll = state.scroll.saturating_sub(4);
                            }
                        }
                        MouseEventKind::ScrollDown => {
                            if state.show_objectives {
                                state.objective_scroll = state.objective_scroll.saturating_add(4);
                            } else {
                                state.scroll = state.scroll.saturating_add(4);
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            event = runtime_events.recv() => {
                let Some(event) = event else {
                    state.push(EntryKind::Error, "Runtime 事件通道已关闭。");
                    state.busy = false;
                    continue;
                };
                let refresh = matches!(event.topic.as_str(), "chat/reply" | "chat/reply_suppressed" | "context/transaction")
                    || event.topic.starts_with("objective/");
                state.on_runtime_event(event);
                if refresh {
                    if let Ok(view) = session.inspect_context_view().await {
                        state.update_context(&view);
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
    match input.trim() {
        "/help" => {
            state.show_help = true;
            Ok(true)
        }
        "/clear" => {
            state.entries.clear();
            state.live_text.clear();
            state.live_tools.clear();
            state.reply_draft.clear();
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
        KeyCode::PageUp => {
            state.follow_tail = false;
            state.scroll = state.scroll.saturating_sub(8);
        }
        KeyCode::PageDown => state.scroll = state.scroll.saturating_add(8),
        _ => {}
    }
    UiAction::None
}

fn entry_style(kind: EntryKind) -> (&'static str, Color) {
    match kind {
        EntryKind::User => ("YOU", USER),
        EntryKind::Assistant => ("MORPHZ", SUCCESS),
        EntryKind::Progress => ("AGENT · PROGRESS", ACCENT),
        EntryKind::Tool => ("TOOL", WARNING),
        EntryKind::System => ("SYSTEM", MUTED),
        EntryKind::Error => ("ERROR", ERROR),
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

fn objective_status_color(status: ObjectiveStatus) -> Color {
    match status {
        ObjectiveStatus::Active => SUCCESS,
        ObjectiveStatus::Paused => WARNING,
        ObjectiveStatus::Blocked => WARNING,
        ObjectiveStatus::Completed => SUCCESS,
        ObjectiveStatus::Cancelled => MUTED,
        ObjectiveStatus::Failed => ERROR,
    }
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
        if name == "reply" {
            continue;
        }
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
        detail.push(format!(
            "{} · {}\n{}",
            name,
            short_call_id(id),
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
        "{} · {} · {}\n{}",
        name,
        call_id,
        status,
        truncate(text, 2_000)
    );
    Some(ToolActivity { compact, detail })
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
        "reply" => string("content"),
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
        "reply" => "Prepare reply",
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

fn append_tool_lines(
    lines: &mut Vec<Line<'static>>,
    compact: &str,
    detail: Option<&str>,
    expanded: bool,
) {
    for line in compact.lines() {
        let trimmed = line.trim_start();
        let color = if trimmed.starts_with('✓') {
            SUCCESS
        } else if trimmed.starts_with('!') {
            ERROR
        } else if trimmed.starts_with('◇') {
            TOOL
        } else {
            TEXT
        };
        let style = if matches!(trimmed.chars().next(), Some('✓' | '!' | '◇')) {
            Style::default().fg(color).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(color)
        };
        lines.push(Line::from(Span::styled(format!("  {line}"), style)));
    }
    if expanded {
        if let Some(detail) = detail.filter(|detail| !detail.trim().is_empty()) {
            lines.push(Line::from(Span::styled(
                "    ─ details",
                Style::default().fg(BORDER),
            )));
            for line in detail.lines() {
                lines.push(Line::from(Span::styled(
                    format!("    {line}"),
                    Style::default().fg(MUTED),
                )));
            }
        }
    }
}

fn pretty_json(value: &str) -> String {
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| value.to_string())
}

fn extract_partial_json_string(arguments: &str, key: &str) -> String {
    let marker = format!("\"{key}\"");
    let Some(key_start) = arguments.find(&marker) else {
        return String::new();
    };
    let tail = &arguments[key_start + marker.len()..];
    let Some(colon) = tail.find(':') else {
        return String::new();
    };
    let tail = tail[colon + 1..].trim_start();
    let Some(mut chars) = tail.strip_prefix('"').map(str::chars) else {
        return String::new();
    };
    let mut output = String::new();
    while let Some(character) = chars.next() {
        match character {
            '"' => break,
            '\\' => match chars.next() {
                Some('n') => output.push('\n'),
                Some('r') => output.push('\r'),
                Some('t') => output.push('\t'),
                Some('"') => output.push('"'),
                Some('\\') => output.push('\\'),
                Some('/') => output.push('/'),
                Some('b') => output.push('\u{0008}'),
                Some('f') => output.push('\u{000c}'),
                Some('u') => {
                    let digits = chars.by_ref().take(4).collect::<String>();
                    if digits.len() == 4 {
                        if let Ok(code) = u32::from_str_radix(&digits, 16) {
                            if let Some(value) = char::from_u32(code) {
                                output.push(value);
                            }
                        }
                    }
                }
                Some(other) => output.push(other),
                None => break,
            },
            other => output.push(other),
        }
    }
    output
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
            session_id: "s".to_string(),
            model: "m".to_string(),
            entries: Vec::new(),
            composer,
            live_text: String::new(),
            live_tools: BTreeMap::new(),
            reply_draft: String::new(),
            status: "ready".to_string(),
            context_status: "normal".to_string(),
            objectives: Vec::new(),
            busy: false,
            follow_tail: true,
            scroll: 0,
            spinner: 0,
            pending_approval: None,
            show_help: false,
            show_tool_details: false,
            show_objectives: false,
            objective_scroll: 0,
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
    fn partial_reply_content_is_visible_before_json_closes() {
        let arguments = r#"{"disposition":"deliver","content":"hello\n世界"#;
        assert_eq!(
            extract_partial_json_string(arguments, "content"),
            "hello\n世界"
        );
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
        assert!(screen.contains("MORPHZ"));
        assert!(screen.contains("Run command"));
        assert!(screen.contains("cargo test"));
        assert!(screen.contains("OBJECTIVE"));
        assert!(screen.contains("Win TankWar and keep improving strategy"));
        assert!(!screen.contains("requested_permissions"));
        assert!(terminal.backend().cursor_visible());
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
        assert!(screen.contains("Context Objectives"));
        assert!(screen.contains("ACTIVE"));
        assert!(screen.contains("waiting: tool task task-123"));
        assert!(screen.contains("32000 / 256000 tok"));
        assert!(!terminal.backend().cursor_visible());
    }
}
