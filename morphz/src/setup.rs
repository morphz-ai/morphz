use crate::config::{
    morphz_home_dir, save_managed_provider_account_at, save_managed_provider_catalog, AppConfig,
    AuthAccountConfig, CredentialConfig, CredentialSource, ModelProtocol, ModelRouteAffinity,
    ModelRouteCandidateConfig, ModelRouteConfig, ModelRouteSelection, ProviderConfig,
    ProviderInstanceConfig, TuiTheme,
};
use crate::i18n::Locale;
use crate::provider::{
    builtin_provider_catalog, probe_protocol_client, store_keychain_credential, ProtocolClient,
};
use crate::tui::{
    detect_terminal_appearance, query_terminal_appearance, Theme, USER_MESSAGE_PREFIX,
};
use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEventKind,
    KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use futures_util::StreamExt;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::error::Error;
use std::io::{self, Stdout};
use std::path::{Path, PathBuf};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};
use zeroize::Zeroizing;

type SetupError = Box<dyn Error + Send + Sync>;

#[derive(Debug)]
struct SetupCancelled(&'static str);
impl std::fmt::Display for SetupCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl Error for SetupCancelled {}

#[derive(Debug, Clone)]
struct ProviderPreset {
    id: &'static str,
    adapter: &'static str,
    protocol: ModelProtocol,
    base_url: String,
    env_name: &'static str,
    oauth_adapter: Option<&'static str>,
}

fn presets() -> Vec<ProviderPreset> {
    let catalog = builtin_provider_catalog();
    vec![
        ProviderPreset {
            id: "openai",
            adapter: "protocol-compatible",
            protocol: ModelProtocol::OpenaiResponses,
            base_url: catalog["openai"].base_url.clone(),
            env_name: "OPENAI_API_KEY",
            oauth_adapter: None,
        },
        ProviderPreset {
            id: "codex-subscription",
            adapter: "openai-codex",
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://chatgpt.com/backend-api/codex".to_string(),
            env_name: "",
            oauth_adapter: Some("codex-oauth"),
        },
        ProviderPreset {
            id: "anthropic",
            adapter: "protocol-compatible",
            protocol: ModelProtocol::AnthropicMessages,
            base_url: catalog["anthropic"].base_url.clone(),
            env_name: "ANTHROPIC_API_KEY",
            oauth_adapter: None,
        },
        ProviderPreset {
            id: "gemini",
            adapter: "protocol-compatible",
            protocol: ModelProtocol::GeminiContent,
            base_url: catalog["gemini"].base_url.clone(),
            env_name: "GEMINI_API_KEY",
            oauth_adapter: None,
        },
        ProviderPreset {
            id: "kimi-code",
            adapter: "kimi-code",
            protocol: ModelProtocol::OpenaiChat,
            base_url: "https://api.kimi.com/coding/v1".to_string(),
            env_name: "",
            oauth_adapter: Some("kimi-oauth"),
        },
    ]
}

#[derive(Debug, Clone)]
pub struct SetupResult {
    pub provider: String,
    pub protocol: ModelProtocol,
    pub model: String,
    pub config_path: PathBuf,
    pub connection_verified: bool,
    /// OAuth account that must be logged in before the first model request.
    /// Setup persists the graph first so login can use the same Runtime
    /// control path as CLI, HTTP and Dashboard instead of owning a second
    /// token lifecycle implementation.
    pub oauth_account: Option<String>,
}

#[derive(Debug, Clone)]
struct Choice {
    title: String,
    detail: String,
}

impl Choice {
    fn new(title: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            detail: detail.into(),
        }
    }
}

struct SetupTerminal {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    events: EventStream,
    step: usize,
    total_steps: usize,
    locale: Locale,
    theme: Theme,
    saved: bool,
}

fn is_cancel(key: crossterm::event::KeyEvent) -> bool {
    key.code == KeyCode::Esc
        || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
}

fn restore_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        Show,
        DisableBracketedPaste,
        LeaveAlternateScreen
    );
}

impl SetupTerminal {
    fn enter(locale: Locale, theme: TuiTheme) -> Result<Self, SetupError> {
        use std::io::IsTerminal;
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            return Err(locale.text(
                "Setup --tui requires an interactive terminal. Use morphz setup --no-open for browser setup.",
                "终端向导需要交互式终端。可用 morphz setup --no-open 打开浏览器配置入口。",
            ).into());
        }
        enable_raw_mode()?;
        let appearance = query_terminal_appearance().unwrap_or_else(detect_terminal_appearance);
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableBracketedPaste, Hide) {
            restore_terminal();
            return Err(error.into());
        }
        let terminal = match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => terminal,
            Err(error) => {
                restore_terminal();
                return Err(error.into());
            }
        };
        let theme = if std::env::var_os("NO_COLOR").is_some() {
            TuiTheme::NoColor
        } else {
            theme
        };
        Ok(Self {
            terminal,
            events: EventStream::new(),
            step: 1,
            total_steps: 5,
            locale,
            theme: Theme::for_appearance(theme, appearance),
            saved: false,
        })
    }

    fn page<'a>(&self, title: &'a str, subtitle: &'a str, footer: &'a str) -> SetupPage<'a> {
        SetupPage {
            step: self.step,
            total_steps: self.total_steps,
            title,
            subtitle,
            body: Vec::new(),
            footer,
            border_color: self.theme.brand,
            input: None,
            choices: None,
            scroll: 0,
            locale: self.locale,
            theme: self.theme,
        }
    }

    fn draw(&mut self, page: SetupPage<'_>) -> Result<(), SetupError> {
        self.terminal.draw(|frame| render_setup_page(frame, page))?;
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Event, SetupError> {
        self.events
            .next()
            .await
            .ok_or_else(|| {
                self.locale
                    .text(
                        "The setup terminal event stream was closed",
                        "初始化终端事件流已关闭",
                    )
                    .to_string()
            })?
            .map_err(Into::into)
    }

    fn cancelled(&self) -> SetupError {
        Box::new(SetupCancelled(
            self.locale.text("Setup cancelled", "设置已取消"),
        ))
    }

    async fn choose(
        &mut self,
        title: &str,
        subtitle: &str,
        choices: &[Choice],
        initial: usize,
    ) -> Result<usize, SetupError> {
        if choices.is_empty() {
            return Err(self
                .locale
                .text("No choices are available", "当前没有可选项")
                .into());
        }
        let mut state = ChoiceSelection::new(initial, choices.len());
        loop {
            let indices = state.matches(choices);
            state.selected = state.selected.min(indices.len().saturating_sub(1));
            let footer = self.locale.text(
                "↑↓ Select · Enter Confirm · / Search · Esc Cancel",
                "↑↓ 选择 · 回车确认 · / 搜索 · Esc 取消",
            );
            let mut page = self.page(title, subtitle, footer);
            page.choices = Some(SetupChoices {
                choices,
                indices: &indices,
                selected: state.selected,
                query: &state.query,
                searching: state.searching,
            });
            self.draw(page)?;
            match self.next_event().await? {
                Event::Paste(value) => {
                    state.searching = true;
                    state
                        .query
                        .extend(value.chars().filter(|c| !c.is_control()));
                    state.selected = 0;
                }
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if key.code == KeyCode::Esc && state.searching {
                        state.query.clear();
                        state.searching = false;
                        state.selected = 0;
                    } else if is_cancel(key) {
                        return Err(self.cancelled());
                    } else if key.code == KeyCode::Enter {
                        if let Some(index) = indices.get(state.selected) {
                            return Ok(*index);
                        }
                    } else {
                        state.key(key, indices.len());
                    }
                }
                _ => {}
            }
        }
    }

    async fn input(
        &mut self,
        title: &str,
        subtitle: &str,
        default: Option<&str>,
        kind: InputKind,
    ) -> Result<String, SetupError> {
        let mut buffer = InputBuffer::default();
        let mut error = None;
        loop {
            let secret = kind == InputKind::Secret;
            let entered = !buffer.value.is_empty();
            let display = if secret && entered {
                "•".repeat(buffer.value.chars().count())
            } else if entered {
                buffer.value.to_string()
            } else {
                default
                    .map(str::to_string)
                    .unwrap_or_else(|| self.locale.text("Type a value…", "输入内容…").to_string())
            };
            let helper = error.clone().unwrap_or_else(|| {
                if secret {
                    self.locale
                        .text(
                            "Hidden input · never shown in the summary",
                            "密钥已隐藏，不会出现在确认摘要中",
                        )
                        .to_string()
                } else if default.is_some() && !entered {
                    self.locale
                        .text(
                            "Enter accepts this default; typing replaces it",
                            "直接回车使用默认值；输入新内容可替换",
                        )
                        .to_string()
                } else {
                    self.locale
                        .text(
                            "←→ Move · Home/End · Ctrl+U Clear",
                            "←→ 移动 · Home/End 首尾 · Ctrl+U 清空",
                        )
                        .to_string()
                }
            });
            let mut page = self.page(
                title,
                subtitle,
                self.locale
                    .text("Enter Confirm · Esc Cancel", "回车确认 · Esc 取消"),
            );
            if error.is_some() {
                page.border_color = self.theme.error;
            }
            page.input = Some(SetupInput {
                label: if secret {
                    self.locale.text("API KEY", "密钥")
                } else {
                    self.locale.text("VALUE", "输入")
                },
                display,
                entered,
                cursor_width: if secret {
                    buffer.value[..buffer.cursor].chars().count()
                } else {
                    UnicodeWidthStr::width(&buffer.value[..buffer.cursor])
                },
                helper,
            });
            self.draw(page)?;
            match self.next_event().await? {
                Event::Paste(text) => {
                    buffer.insert(&text);
                    error = None;
                }
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if is_cancel(key) {
                        return Err(self.cancelled());
                    }
                    if key.code == KeyCode::Enter {
                        let result = if buffer.value.trim().is_empty() {
                            default.unwrap_or_default()
                        } else {
                            buffer.value.trim()
                        };
                        match validate_input(kind, result, self.locale) {
                            Ok(()) => return Ok(result.to_string()),
                            Err(message) => error = Some(message.to_string()),
                        }
                    } else {
                        buffer.key(key);
                        error = None;
                    }
                }
                _ => {}
            }
        }
    }

    // The event loop stays alive while the network future is pending. Cancelling
    // drops that future, not the process or any already-persisted configuration.
    async fn wait_for<T>(
        &mut self,
        title: &str,
        subtitle: &str,
        message: &str,
        future: impl std::future::Future<Output = Result<T, SetupError>>,
        timeout: std::time::Duration,
    ) -> Result<Result<T, SetupError>, SetupError> {
        tokio::pin!(future);
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(180));
        let mut pulse = 0;
        loop {
            let mut page = self.page(
                title,
                subtitle,
                self.locale.text("Esc / Ctrl+C Cancel", "Esc / Ctrl+C 取消"),
            );
            let frames = ["·", "∙", "•", "●", "•", "∙"];
            page.body = vec![
                Line::from(""),
                Line::from(Span::styled(
                    format!("  {}  {message}", frames[pulse % frames.len()]),
                    Style::default().fg(self.theme.brand),
                )),
            ];
            self.draw(page)?;
            tokio::select! {
                result = &mut future => return Ok(result),
                _ = &mut deadline => return Ok(Err(self.locale.text(
                    "Connection check timed out; check the service address and network.",
                    "连接检查超时，请检查服务地址和网络。",
                ).into())),
                event = self.next_event() => {
                    if let Event::Key(key) = event? {
                        if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) && is_cancel(key) {
                            return Err(self.cancelled());
                        }
                    }
                }
                _ = tick.tick() => { pulse += 1; }
            }
        }
    }

    fn status(&mut self, title: &str, subtitle: &str, message: &str) -> Result<(), SetupError> {
        let mut page = self.page(
            title,
            subtitle,
            self.locale
                .text("Working, please wait…", "正在处理，请稍候…"),
        );
        page.body = vec![Line::from(message.to_string())];
        self.draw(page)
    }

    async fn acknowledge(
        &mut self,
        title: &str,
        subtitle: &str,
        message: &str,
        color: Color,
    ) -> Result<(), SetupError> {
        let mut scroll: u16 = 0;
        loop {
            let footer = if self.saved {
                self.locale.text(
                    "↑↓ Scroll · Enter / Esc Finish",
                    "↑↓ 滚动 · 回车 / Esc 完成",
                )
            } else {
                self.locale.text(
                    "↑↓ Scroll · Enter Continue · Esc Cancel",
                    "↑↓ 滚动 · 回车继续 · Esc 取消",
                )
            };
            let mut page = self.page(title, subtitle, footer);
            page.body = message
                .lines()
                .map(|line| Line::from(line.to_string()))
                .collect();
            page.border_color = color;
            page.scroll = scroll;
            self.draw(page)?;
            if let Event::Key(key) = self.next_event().await? {
                if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                    continue;
                }
                if is_cancel(key) {
                    return Err(self.cancelled());
                }
                match key.code {
                    KeyCode::Enter => return Ok(()),
                    KeyCode::Up => scroll = scroll.saturating_sub(1),
                    KeyCode::Down => scroll = scroll.saturating_add(1),
                    KeyCode::PageUp => scroll = scroll.saturating_sub(5),
                    KeyCode::PageDown => scroll = scroll.saturating_add(5),
                    KeyCode::Home => scroll = 0,
                    _ => {}
                }
            }
        }
    }
}

impl Drop for SetupTerminal {
    fn drop(&mut self) {
        restore_terminal();
    }
}

struct ChoiceSelection {
    selected: usize,
    query: String,
    searching: bool,
}

impl ChoiceSelection {
    fn new(initial: usize, count: usize) -> Self {
        Self {
            selected: initial.min(count.saturating_sub(1)),
            query: String::new(),
            searching: false,
        }
    }

    fn matches(&self, choices: &[Choice]) -> Vec<usize> {
        let query = self.query.to_lowercase();
        choices
            .iter()
            .enumerate()
            .filter_map(|(index, choice)| {
                (choice.title.to_lowercase().contains(&query)
                    || choice.detail.to_lowercase().contains(&query))
                .then_some(index)
            })
            .collect()
    }

    fn key(&mut self, key: crossterm::event::KeyEvent, count: usize) {
        let last = count.saturating_sub(1);
        match key.code {
            KeyCode::Up => self.selected = self.selected.checked_sub(1).unwrap_or(last),
            KeyCode::Down => {
                self.selected = if self.selected >= last {
                    0
                } else {
                    self.selected + 1
                }
            }
            KeyCode::Home => self.selected = 0,
            KeyCode::End => self.selected = last,
            KeyCode::PageUp => self.selected = self.selected.saturating_sub(5),
            KeyCode::PageDown => self.selected = (self.selected + 5).min(last),
            KeyCode::Char('/') if !self.searching => self.searching = true,
            KeyCode::Backspace if self.searching => {
                self.query.pop();
                self.selected = 0;
            }
            KeyCode::Char(c)
                if self.searching
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.query.push(c);
                self.selected = 0;
            }
            KeyCode::Char('k') => self.selected = self.selected.checked_sub(1).unwrap_or(last),
            KeyCode::Char('j') => {
                self.selected = if self.selected >= last {
                    0
                } else {
                    self.selected + 1
                }
            }
            _ => {}
        }
    }
}

#[derive(Default)]
struct InputBuffer {
    value: Zeroizing<String>,
    cursor: usize,
}

impl InputBuffer {
    fn insert(&mut self, text: &str) {
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        self.value.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }

    fn previous(&self) -> usize {
        self.value[..self.cursor]
            .char_indices()
            .next_back()
            .map(|(index, _)| index)
            .unwrap_or(0)
    }

    fn next(&self) -> usize {
        self.cursor
            + self.value[self.cursor..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(0)
    }

    fn key(&mut self, key: crossterm::event::KeyEvent) {
        match key.code {
            KeyCode::Left => self.cursor = self.previous(),
            KeyCode::Right => self.cursor = self.next(),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.value.len(),
            KeyCode::Backspace => {
                let previous = self.previous();
                self.value.replace_range(previous..self.cursor, "");
                self.cursor = previous;
            }
            KeyCode::Delete => {
                let next = self.next();
                self.value.replace_range(self.cursor..next, "");
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.value.clear();
                self.cursor = 0;
            }
            KeyCode::Char(c)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                self.insert(&c.to_string())
            }
            _ => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum InputKind {
    Text,
    Secret,
    ProviderId,
    Url,
    EnvName,
}

fn validate_input(kind: InputKind, value: &str, locale: Locale) -> Result<(), &'static str> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(locale.text(
            "Enter a non-empty value without control characters.",
            "请输入非空内容，且不含控制字符。",
        ));
    }
    match kind {
        InputKind::ProviderId
            if value.len() > 200
                || !value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) =>
        {
            Err(locale.text(
                "Use letters, digits, hyphens or underscores (up to 200 bytes).",
                "请使用字母、数字、短横线或下划线（最多 200 字节）。",
            ))
        }
        InputKind::Url => {
            let valid = reqwest::Url::parse(value).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
            });
            if valid {
                Ok(())
            } else {
                Err(locale.text(
                    "Use an http(s) root URL without credentials, query or fragment.",
                    "请输入 http(s) 根地址，不要包含凭证、查询参数或片段。",
                ))
            }
        }
        InputKind::EnvName
            if validate_env_name(value).is_err()
                || matches!(
                    value,
                    "HOME" | "PATH" | "USERPROFILE" | "CODEX_HOME" | "MORPHZ_HOME"
                ) =>
        {
            Err(locale.text(
                "Use a valid environment variable name, for example MY_API_KEY.",
                "请输入合法的环境变量名，例如 MY_API_KEY。",
            ))
        }
        _ => Ok(()),
    }
}

struct SetupPage<'a> {
    step: usize,
    total_steps: usize,
    title: &'a str,
    subtitle: &'a str,
    body: Vec<Line<'static>>,
    footer: &'a str,
    border_color: Color,
    input: Option<SetupInput>,
    choices: Option<SetupChoices<'a>>,
    scroll: u16,
    locale: Locale,
    theme: Theme,
}

struct SetupChoices<'a> {
    choices: &'a [Choice],
    indices: &'a [usize],
    selected: usize,
    query: &'a str,
    searching: bool,
}

struct SetupInput {
    label: &'static str,
    display: String,
    entered: bool,
    cursor_width: usize,
    helper: String,
}

fn render_setup_page(frame: &mut Frame<'_>, page: SetupPage<'_>) {
    let theme = page.theme;
    if frame.area().width < 40 || frame.area().height < 16 {
        frame.render_widget(
            Paragraph::new(page.locale.text(
                "Morphz setup\nEnlarge terminal to 40×16.\nEsc / Ctrl+C cancels.",
                "Morphz 设置\n请将终端放大至 40×16。\nEsc / Ctrl+C 取消。",
            ))
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(theme.brand)),
            frame.area(),
        );
        return;
    }
    let area = centered_setup_rect(frame.area());
    frame.render_widget(Clear, area);
    let chunks = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(2),
        Constraint::Min(8),
        Constraint::Length(2),
    ])
    .split(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                USER_MESSAGE_PREFIX,
                Style::default()
                    .fg(theme.brand)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(" Morphz", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(
                page.locale.text("  /  SETUP", "  /  设置向导"),
                Style::default().fg(theme.text_muted),
            ),
        ])),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new(setup_progress(
            page.step,
            page.total_steps,
            page.locale,
            theme,
        )),
        chunks[1],
    );

    let compact = area.height < 26;
    let card = Block::default()
        .title(format!(" {} ", page.title))
        .title_style(
            Style::default()
                .fg(page.border_color)
                .add_modifier(Modifier::BOLD),
        )
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(theme.border_subtle))
        .padding(Padding::new(1, 1, u16::from(!compact), 0));
    let inner = card.inner(chunks[2]);
    frame.render_widget(card, chunks[2]);
    let subtitle = Paragraph::new(page.subtitle)
        .style(Style::default().fg(theme.text_muted))
        .wrap(Wrap { trim: true });
    let subtitle_height = (subtitle.line_count(inner.width) as u16)
        .min(inner.height.saturating_sub(4))
        .min(4);
    let content =
        Layout::vertical([Constraint::Length(subtitle_height), Constraint::Min(0)]).split(inner);
    frame.render_widget(subtitle, content[0]);
    if let Some(input) = page.input {
        render_setup_input(frame, content[1], input, page.border_color, theme);
    } else if let Some(choices) = page.choices {
        render_choices(frame, content[1], choices, page.locale, theme);
    } else {
        let paragraph = Paragraph::new(page.body).wrap(Wrap { trim: false });
        let max_scroll = paragraph
            .line_count(content[1].width)
            .saturating_sub(usize::from(content[1].height));
        frame.render_widget(
            paragraph.scroll((page.scroll.min(max_scroll.min(u16::MAX as usize) as u16), 0)),
            content[1],
        );
    }
    frame.render_widget(
        Paragraph::new(page.footer)
            .wrap(Wrap { trim: true })
            .alignment(Alignment::Center)
            .style(Style::default().fg(theme.text_muted)),
        chunks[3],
    );
}

fn render_choices(
    frame: &mut Frame<'_>,
    area: Rect,
    options: SetupChoices<'_>,
    locale: Locale,
    theme: Theme,
) {
    use ratatui::widgets::{List, ListItem, ListState};
    let rows = Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).split(area);
    let count = options.indices.len();
    let label = if options.searching {
        format!(
            "{} {}  ({count}/{})",
            locale.text("Search:", "搜索："),
            options.query,
            options.choices.len()
        )
    } else {
        format!(
            "{} / {}",
            if count == 0 { 0 } else { options.selected + 1 },
            count
        )
    };
    frame.render_widget(
        Paragraph::new(label).style(Style::default().fg(theme.text_muted)),
        rows[0],
    );
    if count == 0 {
        frame.render_widget(
            Paragraph::new(locale.text(
                "No matches · Esc clears the search",
                "没有匹配项 · Esc 清除搜索",
            ))
            .style(Style::default().fg(theme.text_muted)),
            rows[1],
        );
        return;
    }
    let width = usize::from(rows[1].width.saturating_sub(3));
    let items = options.indices.iter().map(|index| {
        let choice = &options.choices[*index];
        ListItem::new(vec![
            Line::from(clip_label(&choice.title, width)),
            Line::from(Span::styled(
                clip_label(&choice.detail, width),
                Style::default().fg(theme.text_muted),
            )),
        ])
    });
    let list = List::new(items).highlight_symbol("❯ ").highlight_style(
        Style::default()
            .fg(theme.brand)
            .add_modifier(Modifier::BOLD),
    );
    let capacity = usize::from(rows[1].height / 2).max(1);
    let offset = options.selected.saturating_sub(capacity - 1);
    let mut state = ListState::default()
        .with_offset(offset)
        .with_selected(Some(options.selected));
    frame.render_stateful_widget(list, rows[1], &mut state);
}

fn clip_label(value: &str, width: usize) -> String {
    if UnicodeWidthStr::width(value) <= width {
        return value.to_string();
    }
    if width == 0 {
        return String::new();
    }
    format!("{}…", truncate_to_width(value, width - 1))
}

fn setup_progress(step: usize, total_steps: usize, locale: Locale, theme: Theme) -> Line<'static> {
    let step = step.min(total_steps);
    let mut spans = vec![Span::styled(
        format!("{} {step}/{total_steps}  ", locale.text("STEP", "步骤")),
        Style::default().fg(theme.text_muted),
    )];
    for index in 1..=total_steps {
        spans.push(Span::styled(
            if index <= step { "● " } else { "○ " },
            Style::default().fg(if index <= step {
                theme.brand
            } else {
                theme.text_muted
            }),
        ));
    }
    Line::from(spans)
}

fn render_setup_input(
    frame: &mut Frame<'_>,
    area: Rect,
    input: SetupInput,
    color: Color,
    theme: Theme,
) {
    let rows = Layout::vertical([Constraint::Length(3), Constraint::Min(0)]).split(area);
    let input_block = Block::default()
        .title(format!(" {} ", input.label))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(color))
        .padding(Padding::horizontal(1));
    let inner = input_block.inner(rows[0]);
    frame.render_widget(input_block, rows[0]);
    let prefix = "❯ ";
    let available = usize::from(inner.width.saturating_sub(2));
    let (visible, cursor) =
        visible_input_tail(&input.display, input.cursor_width, available, input.entered);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(prefix, Style::default().fg(color)),
            Span::styled(
                visible,
                Style::default().fg(if input.entered {
                    Color::Reset
                } else {
                    theme.text_muted
                }),
            ),
        ])),
        inner,
    );
    frame.render_widget(
        Paragraph::new(input.helper)
            .wrap(Wrap { trim: false })
            .style(Style::default().fg(theme.text_muted)),
        rows[1],
    );
    if inner.width > 2 && inner.height > 0 {
        frame.set_cursor_position((inner.x + 2 + cursor as u16, inner.y));
    }
}

fn visible_input_tail(
    display: &str,
    cursor_width: usize,
    available: usize,
    entered: bool,
) -> (String, usize) {
    let cursor_width = cursor_width.min(UnicodeWidthStr::width(display));
    if available == 0 {
        return (String::new(), 0);
    }
    if !entered {
        return (truncate_to_width(display, available), 0);
    }
    // Reserve a cell for the caret. Clip both ends when editing a long value,
    // using terminal cell widths rather than bytes (Chinese input is safe).
    let width = available - 1;
    let mut offset = 0;
    let mut skipped = 0;
    if cursor_width > width {
        for (index, character) in display.char_indices() {
            if cursor_width.saturating_sub(skipped) <= width.saturating_sub(1) {
                break;
            }
            skipped += character.width().unwrap_or(0);
            offset = index + character.len_utf8();
        }
    }
    let prefix = if offset > 0 && width > 0 { "…" } else { "" };
    let prefix_width = UnicodeWidthStr::width(prefix);
    let visible = format!(
        "{prefix}{}",
        truncate_to_width(&display[offset..], width.saturating_sub(prefix_width))
    );
    (
        visible,
        (cursor_width.saturating_sub(skipped) + prefix_width).min(width),
    )
}

fn truncate_to_width(value: &str, available: usize) -> String {
    let mut width = 0;
    value
        .chars()
        .take_while(|character| {
            let character_width = character.width().unwrap_or(0);
            if width + character_width > available {
                false
            } else {
                width += character_width;
                true
            }
        })
        .collect()
}

fn centered_setup_rect(area: Rect) -> Rect {
    let width = area.width.saturating_sub(2).min(88);
    let height = area.height.saturating_sub(2).min(32);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

pub async fn run_interactive_setup() -> Result<SetupResult, SetupError> {
    run_interactive_setup_for(Locale::detect()).await
}

pub async fn run_interactive_setup_for(locale: Locale) -> Result<SetupResult, SetupError> {
    run_interactive_setup_with_theme(locale, TuiTheme::default()).await
}

pub async fn run_interactive_setup_with_theme(
    locale: Locale,
    theme: TuiTheme,
) -> Result<SetupResult, SetupError> {
    let mut ui = SetupTerminal::enter(locale, theme)?;
    let locale = ui.locale;
    let catalog = presets();
    let provider_choice = ui
        .choose(
            locale.text("Choose a provider", "选择模型服务商"),
            locale.text(
                "Choose a service; custom services can select a compatible protocol.",
                "选择模型服务商；自定义服务可单独选择兼容协议。",
            ),
            &[
                Choice::new(
                    "OpenAI",
                    locale.text("Official Responses API", "官方响应接口"),
                ),
                Choice::new(
                    locale.text("Codex subscription", "Codex 订阅"),
                    locale.text(
                        "OAuth login with an OpenAI subscription; compatibility adapter",
                        "使用 OpenAI 订阅进行 OAuth 登录；兼容性适配器",
                    ),
                ),
                Choice::new(
                    "Anthropic",
                    locale.text("Official Messages API", "官方消息接口"),
                ),
                Choice::new(
                    "Google Gemini",
                    locale.text("Official generateContent API", "官方内容生成接口"),
                ),
                Choice::new(
                    locale.text("Kimi Code subscription", "Kimi Code 订阅"),
                    locale.text(
                        "Kimi device authorization and the official coding endpoint",
                        "Kimi 设备授权与官方 Coding 接口",
                    ),
                ),
                Choice::new(
                    locale.text("Custom provider", "自定义服务商"),
                    locale.text(
                        "Local proxy, private deployment, or standards-compatible service",
                        "适用于本地代理、私有部署或兼容标准协议的服务",
                    ),
                ),
            ],
            0,
        )
        .await?;

    ui.step = 2;
    let (provider_id, provider_adapter, protocol, base_url, default_env, oauth_adapter) =
        if let Some(preset) = catalog.get(provider_choice) {
            (
                preset.id.to_string(),
                preset.adapter.to_string(),
                preset.protocol,
                preset.base_url.clone(),
                preset.env_name.to_string(),
                preset.oauth_adapter.map(str::to_string),
            )
        } else {
            let provider_id = ui
                .input(
                    locale.text("Provider ID", "服务商标识"),
                    locale.text(
                        "A stable configuration name, for example local-proxy.",
                        "配置中使用的稳定名称，例如 local-proxy。",
                    ),
                    Some("custom"),
                    InputKind::ProviderId,
                )
                .await?;
            let protocol_choice = ui
                .choose(
                    locale.text("Choose a protocol", "选择通信协议"),
                    locale.text(
                        "The protocol defines request and streaming response encoding; it is never inferred from a model name.",
                        "通信协议决定请求和流式响应的编码方式，不会根据模型名称猜测。",
                    ),
                    &[
                        Choice::new("OpenAI Responses", "/responses"),
                        Choice::new("OpenAI Chat Completions", "/chat/completions"),
                        Choice::new("Anthropic Messages", "/messages"),
                        Choice::new("Gemini generateContent", "models/*:generateContent"),
                    ],
                    1,
                )
                .await?;
            let protocol = [
                ModelProtocol::OpenaiResponses,
                ModelProtocol::OpenaiChat,
                ModelProtocol::AnthropicMessages,
                ModelProtocol::GeminiContent,
            ][protocol_choice];
            let base_url = ui
                .input(
                    locale.text("Provider URL", "服务商地址"),
                    locale.text(
                        "Enter the protocol root URL; Morphz appends the endpoint required by the selected protocol.",
                        "填写通信协议的根地址，Morphz 会根据所选协议补充具体接口路径。",
                    ),
                    None,
                    InputKind::Url,
                )
                .await?;
            (
                provider_id,
                "protocol-compatible".to_string(),
                protocol,
                base_url,
                "MORPHZ_PROVIDER_API_KEY".to_string(),
                None,
            )
        };

    let base_url = if oauth_adapter.is_none() && catalog.get(provider_choice).is_some() {
        ui.input(
            locale.text("Provider URL", "模型服务地址"),
            locale.text(
                "Confirm the service root URL, or enter your compatible gateway address.",
                "确认服务根地址，也可以填写兼容网关地址。",
            ),
            Some(&base_url),
            InputKind::Url,
        )
        .await?
    } else {
        base_url
    };
    ui.total_steps = if oauth_adapter.is_some() { 3 } else { 5 };
    ui.step = if oauth_adapter.is_some() { 2 } else { 3 };
    let credential_id = provider_id.clone();
    let (mut credential, pending_key, oauth_secret_backend) = if oauth_adapter.is_some() {
        (
            None,
            None,
            configure_oauth_secret_backend(&mut ui, &provider_id).await?,
        )
    } else {
        let (credential, secret) = configure_credential(&mut ui, &default_env).await?;
        (Some(credential), secret, None)
    };

    let (model, route_id, connection_verified, verification_message) = if oauth_adapter.is_some() {
        ui.step = 3;
        let account_id = format!("{provider_id}-default");
        let verification_message = if locale.is_chinese() {
            format!(
                "登录配置已保存，尚未登录或启用模型。接下来将启动账号登录。授权成功后，请在控制台的“模型服务”页面加载模型目录并选择启用项。\n\n以后如需重新登录，可运行：\n\n  morphz provider account login {account_id}"
            )
        } else {
            format!(
                "Login configuration is saved; login and model selection are not yet complete. Account login starts next. After authorization, open Model Services in Dashboard to load the catalog and enable models.\n\nTo sign in again later, run:\n\n  morphz provider account login {account_id}"
            )
        };
        (String::new(), String::new(), false, verification_message)
    } else {
        let provider = ProviderConfig {
            protocol,
            base_url: base_url.clone(),
            credential: credential.as_ref().map(|_| credential_id.clone()),
            ..ProviderConfig::default()
        };
        let probe_config = AppConfig::default();
        let probe_key = pending_key.as_ref().map(|key| key.to_string()).or_else(|| {
            credential
                .as_ref()
                .filter(|c| c.source == CredentialSource::Env)
                .and_then(|c| c.name.as_deref())
                .and_then(|name| std::env::var(name).ok())
        });
        let catalog_client = ProtocolClient::new(
            &provider,
            String::new(),
            probe_key.clone(),
            &probe_config.llm,
        )?;
        ui.step = 4;
        let catalog_result = ui
            .wait_for(
                locale.text("Discovering models", "发现模型"),
                &format!("{} · {}", provider_id, protocol.as_str()),
                locale.text("Reading the model catalog", "正在读取模型目录"),
                catalog_client.list_models(),
                std::time::Duration::from_secs(45),
            )
            .await?;
        let (models, catalog_error) = match catalog_result {
            Ok(models) => (models, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        if let Some(error) = catalog_error {
            ui.acknowledge(
                locale.text("Model catalog unavailable", "模型目录不可用"),
                locale.text(
                    "You can still enter a model ID manually.",
                    "仍然可以手工填写模型标识。",
                ),
                &if locale.is_chinese() {
                    format!("读取模型目录失败：\n\n{error}\n\n请确认凭证、通信协议和服务地址。")
                } else {
                    format!("Could not read the model catalog:\n\n{error}\n\nCheck the credential, protocol, and base URL.")
                },
                ui.theme.warning,
            )
            .await?;
        }
        let model = select_model(&mut ui, &models).await?;
        let probe_client =
            ProtocolClient::new(&provider, model.clone(), probe_key, &probe_config.llm)?;

        ui.step = 5;
        let test_choice = ui
            .choose(
                locale.text("Connection check", "连接检查"),
                locale.text(
                    "A check sends two small model requests and may consume quota.",
                    "检查会发起两次小型模型请求，可能消耗额度。",
                ),
                &[
                    Choice::new(
                        locale.text("Verify now", "立即验证"),
                        locale.text(
                            "Check streamed text and tool calls",
                            "检查流式文本和工具调用",
                        ),
                    ),
                    Choice::new(
                        locale.text("Skip verification", "跳过验证"),
                        locale.text(
                            "Save an explicitly unverified configuration",
                            "保存配置，但不标记为已验证",
                        ),
                    ),
                ],
                0,
            )
            .await?;
        let verification = if test_choice == 0 {
            ui.wait_for(
                locale.text("Verifying capabilities", "验证能力"),
                &format!("{} · {}", provider_id, model),
                locale.text(
                    "Checking streamed text and tool calls",
                    "正在检查流式文本与工具调用",
                ),
                probe_protocol_client(
                    &provider_id,
                    &provider,
                    &probe_client,
                    models.clone(),
                    None,
                    Some(models.contains(&model)),
                ),
                std::time::Duration::from_secs(90),
            )
            .await?
        } else {
            Err(locale
                .text("Connection verification was skipped.", "已跳过连接验证。")
                .into())
        };
        let (verified, message) = match verification {
            Err(_) if test_choice != 0 => (
                false,
                locale
                    .text(
                        "Verification skipped. This configuration has not been tested.",
                        "已跳过验证，此配置尚未经过连接测试。",
                    )
                    .to_string(),
            ),
            Ok(probe) if probe.completion_stream_verified && probe.tool_call_verified => (
                true,
                locale
                    .text(
                        "Provider connected. Streamed text and tool-call handshakes both passed.",
                        "模型服务商连接成功，流式文本与工具调用握手均已通过。",
                    )
                    .to_string(),
            ),
            Ok(probe) => (
                false,
                if locale.is_chinese() {
                    format!(
                        "模型服务商可以访问，但能力握手不完整。\n\n流式文本={}\n工具调用={}\n\n如果选择保存，可使用 `morphz provider test {provider_id}` 复查。",
                        probe.completion_stream_verified, probe.tool_call_verified
                    )
                } else {
                    format!(
                        "The provider is reachable, but capability verification is incomplete.\n\nstream={}\ntool_call={}\n\nIf you save this configuration, run `morphz provider test {provider_id}` to retry.",
                        probe.completion_stream_verified, probe.tool_call_verified
                    )
                },
            ),
            Err(error) => (
                false,
                if locale.is_chinese() {
                    format!("能力握手失败：\n\n{error}\n\n如果选择保存，可使用 `morphz provider test {provider_id}` 复查。")
                } else {
                    format!("Capability verification failed:\n\n{error}\n\nIf you save this configuration, run `morphz provider test {provider_id}` to retry.")
                },
            ),
        };
        (model.clone(), model, verified, message)
    };
    let account_id = if oauth_adapter.is_some() {
        format!("{provider_id}-default")
    } else if credential
        .as_ref()
        .is_some_and(|credential| credential.source == CredentialSource::None)
    {
        format!("{provider_id}-anonymous")
    } else {
        format!("{provider_id}-default")
    };
    let account = AuthAccountConfig {
        auth_adapter: oauth_adapter.clone().unwrap_or_else(|| {
            if credential
                .as_ref()
                .is_some_and(|credential| credential.source == CredentialSource::None)
            {
                "none".to_string()
            } else {
                "credential".to_string()
            }
        }),
        credential_ref: if oauth_adapter.is_some() {
            format!(
                "MORPHZ_OAUTH_{}",
                account_id
                    .chars()
                    .map(|character| if character.is_ascii_alphanumeric() {
                        character.to_ascii_uppercase()
                    } else {
                        '_'
                    })
                    .collect::<String>()
            )
        } else {
            credential
                .as_ref()
                .filter(|credential| credential.source != CredentialSource::None)
                .map(|_| credential_id.clone())
                .unwrap_or_default()
        },
        secret_backend: oauth_secret_backend,
        provider: Some(provider_id.clone()),
        label: Some(locale.text("Default account", "默认账号").to_string()),
        ..AuthAccountConfig::default()
    };
    let instance = ProviderInstanceConfig {
        adapter: provider_adapter,
        protocol,
        base_url,
        accounts: vec![account_id.clone()],
        ..ProviderInstanceConfig::default()
    };
    let destination = crate::config::managed_model_config_path()?;
    let summary = if locale.is_chinese() {
        format!(
            "服务商：{provider_id}\n地址：{}\n协议：{}\n模型：{}\n配置文件：{}\n\n{}",
            instance.base_url,
            protocol.as_str(),
            if model.is_empty() {
                "登录后选择"
            } else {
                &model
            },
            destination.display(),
            if destination.exists() {
                "将更新同名服务、账号和模型配置；其他配置保留。"
            } else {
                "将新建用户级配置。"
            }
        )
    } else {
        format!(
            "Provider: {provider_id}\nURL: {}\nProtocol: {}\nModel: {}\nConfiguration: {}\n\n{}",
            instance.base_url,
            protocol.as_str(),
            if model.is_empty() {
                "Select after login"
            } else {
                &model
            },
            destination.display(),
            if destination.exists() {
                "Updates matching service, account and model entries; other entries are preserved."
            } else {
                "Creates user-level configuration."
            }
        )
    };
    ui.acknowledge(
        locale.text("Review configuration", "检查配置"),
        locale.text(
            "Nothing is written until you confirm.",
            "确认前不会写入配置或凭证。",
        ),
        &summary,
        ui.theme.brand,
    )
    .await?;
    let decision = ui
        .choose(
            locale.text("Save configuration?", "保存配置？"),
            if oauth_adapter.is_some() {
                locale.text(
                    "Saves login configuration only; authorization starts next.",
                    "这里只保存登录配置；下一步才开始授权。",
                )
            } else if connection_verified {
                locale.text(
                    "Verified. This model becomes the default.",
                    "验证已通过，该模型将设为默认模型。",
                )
            } else {
                locale.text(
                    "Not verified. Save only if you intend to use this configuration.",
                    "尚未验证成功，确认要使用此配置后再保存。",
                )
            },
            &[
                Choice::new(
                    locale.text("Save and continue", "保存并继续"),
                    locale.text("Write the configuration shown above", "写入上面展示的配置"),
                ),
                Choice::new(
                    locale.text("Cancel without saving configuration", "取消，不保存配置"),
                    locale.text("Existing configuration remains unchanged", "保留现有配置"),
                ),
            ],
            usize::from(oauth_adapter.is_none() && !connection_verified),
        )
        .await?;
    if decision != 0 {
        return Err(ui.cancelled());
    }
    if let (Some(credential), Some(secret)) = (credential.as_mut(), pending_key.as_ref()) {
        persist_credential(&mut ui, &provider_id, &default_env, credential, secret).await?;
    }
    let config_path = if oauth_adapter.is_some() {
        let path = crate::config::managed_model_config_path()?;
        save_managed_provider_account_at(&path, &provider_id, &instance, &account_id, &account)?;
        path
    } else {
        let route = ModelRouteConfig {
            display_alias: None,
            aliases: Vec::new(),
            candidates: vec![ModelRouteCandidateConfig {
                provider: provider_id.clone(),
                model: model.clone(),
                priority: 0,
                account: None,
                capabilities: Vec::new(),
            }],
            affinity: ModelRouteAffinity::Context,
            selection: ModelRouteSelection::AvailableLeastRecentlyUsed,
            fallback: false,
        };
        save_managed_provider_catalog(
            &provider_id,
            &instance,
            &account_id,
            &account,
            credential
                .as_ref()
                .filter(|credential| credential.source != CredentialSource::None)
                .map(|credential| (credential_id.as_str(), credential)),
            &route_id,
            &route,
        )?
    };
    ui.saved = true;
    let finished = ui
        .acknowledge(
            if connection_verified {
                locale.text("Setup complete", "设置完成")
            } else {
                locale.text("Configuration saved", "配置已保存")
            },
            &if route_id.is_empty() {
                format!("{} · {}", provider_id, protocol.as_str())
            } else {
                format!("{} · {} · {}", provider_id, protocol.as_str(), route_id)
            },
            &format!(
                "{verification_message}\n\n{}：{}",
                locale.text("Configuration", "配置文件"),
                config_path.display()
            ),
            if connection_verified {
                ui.theme.success
            } else {
                ui.theme.warning
            },
        )
        .await;
    if let Err(error) = finished {
        // Saved configuration is already committed. Closing the receipt is
        // not cancellation, and must not suppress the OAuth handoff.
        if error.downcast_ref::<SetupCancelled>().is_none() {
            return Err(error);
        }
    }
    Ok(SetupResult {
        provider: provider_id,
        protocol,
        model: route_id,
        config_path,
        connection_verified,
        oauth_account: oauth_adapter.map(|_| account_id),
    })
}

async fn configure_oauth_secret_backend(
    ui: &mut SetupTerminal,
    provider_id: &str,
) -> Result<Option<String>, SetupError> {
    let locale = ui.locale;
    let choice = ui
        .choose(
            locale.text("Store OAuth tokens", "保存 OAuth 令牌"),
            locale.text(
                "OAuth access and refresh tokens never enter configuration, prompts, persisted Events, or logs.",
                "OAuth 访问令牌和刷新令牌不会进入配置、提示词、持久化事件或日志。",
            ),
            &[
                Choice::new(
                    locale.text("System credential store", "系统凭证库"),
                    locale.text(
                        "Recommended for an interactive desktop login; uses Keychain, Credential Manager, or Secret Service",
                        "推荐用于交互式桌面登录；使用钥匙串、凭据管理器或 Secret Service",
                    ),
                ),
                Choice::new(
                    locale.text("Morphz secrets file", "Morphz 密钥文件"),
                    locale.text(
                        "Headless-friendly user file with mode 0600; selected explicitly and never used as an implicit fallback",
                        "适合无界面服务的 0600 用户级文件；必须显式选择，绝不会隐式降级",
                    ),
                ),
            ],
            0,
        )
        .await?;
    if choice == 0 {
        Ok(None)
    } else {
        ui.acknowledge(
            locale.text("Headless token storage selected", "已选择无界面令牌存储"),
            provider_id,
            locale.text(
                "Token values will be stored in Morphz's user-level secrets file, while configuration contains only a secret alias.",
                "令牌原文将保存到 Morphz 用户级密钥文件，配置中只保存密钥别名。",
            ),
            ui.theme.warning,
        )
        .await?;
        Ok(Some("morphz_env_file".to_string()))
    }
}

async fn configure_credential(
    ui: &mut SetupTerminal,
    default_env: &str,
) -> Result<(CredentialConfig, Option<Zeroizing<String>>), SetupError> {
    let locale = ui.locale;
    loop {
        let mode = ui
            .choose(
                locale.text("Configure credentials", "配置凭证"),
                locale.text(
                    "Credentials stay in memory until you confirm saving.",
                    "确认保存前，凭证只保留在内存中。",
                ),
                &[
                    Choice::new(
                        locale.text("System credential store", "系统凭证库"),
                        locale.text(
                            "OS-protected; may ask you to unlock or authorize",
                            "由操作系统保护，可能需要解锁或授权",
                        ),
                    ),
                    Choice::new(
                        locale.text("Morphz secrets file", "Morphz 密钥文件"),
                        locale.text(
                            "User-level plaintext; private permissions on Unix",
                            "用户级明文文件；Unix 下使用私有权限",
                        ),
                    ),
                    Choice::new(
                        locale.text("Existing environment variable", "已有环境变量"),
                        locale.text(
                            "Reference a variable without saving its value",
                            "只引用变量，不保存密钥原文",
                        ),
                    ),
                    Choice::new(
                        locale.text("No authentication", "无需认证"),
                        locale.text(
                            "For a service that explicitly requires no credential",
                            "适用于明确不要求凭证的服务",
                        ),
                    ),
                ],
                0,
            )
            .await?;
        if mode == 3 {
            return Ok((
                CredentialConfig {
                    source: CredentialSource::None,
                    ..CredentialConfig::default()
                },
                None,
            ));
        }
        let env_name = if mode == 0 {
            None
        } else {
            Some(ui.input(locale.text("Environment variable", "环境变量"),
                locale.text("Choose a separate variable for each account to avoid overwriting another key.", "不同账号建议使用不同变量名，避免覆盖其他密钥。"),
                Some(default_env), InputKind::EnvName).await?)
        };
        if mode == 2 {
            let name = env_name.unwrap();
            if !std::env::var(&name).is_ok_and(|value| !value.trim().is_empty()) {
                ui.acknowledge(
                    locale.text("Variable not available", "环境变量不可用"),
                    locale.text(
                        "Choose another variable or a credential store.",
                        "请选择其他变量，或改用凭证存储。",
                    ),
                    &format!(
                        "{}: {name}",
                        locale.text("Missing or empty", "变量不存在或为空")
                    ),
                    ui.theme.error,
                )
                .await?;
                continue;
            }
            return Ok((
                CredentialConfig {
                    source: CredentialSource::Env,
                    name: Some(name),
                    ..CredentialConfig::default()
                },
                None,
            ));
        }
        let secret = Zeroizing::new(
            ui.input(
                locale.text("Enter API key", "输入接口密钥"),
                locale.text(
                    "Hidden input. Nothing is saved until the final confirmation.",
                    "输入已隐藏；最后确认之前不会保存。",
                ),
                None,
                InputKind::Secret,
            )
            .await?,
        );
        return Ok((
            CredentialConfig {
                source: if mode == 0 {
                    CredentialSource::Keychain
                } else {
                    CredentialSource::Env
                },
                name: env_name,
                service: if mode == 0 {
                    Some("morphz.provider".to_string())
                } else {
                    None
                },
                command: Vec::new(),
            },
            Some(secret),
        ));
    }
}

async fn persist_credential(
    ui: &mut SetupTerminal,
    provider_id: &str,
    default_env: &str,
    credential: &mut CredentialConfig,
    secret: &Zeroizing<String>,
) -> Result<(), SetupError> {
    let locale = ui.locale;
    if credential.source == CredentialSource::Keychain {
        loop {
            ui.status(
                locale.text("Saving credential", "保存凭证"),
                locale.text(
                    "This system operation may require unlocking the credential store.",
                    "该系统操作可能需要解锁凭证库。",
                ),
                locale.text(
                    "Waiting for authorization; the credential write cannot be cancelled safely.",
                    "正在等待系统授权；凭证写入期间无法安全取消。",
                ),
            )?;
            // Never block a Tokio worker with OS credential-store authorization.
            // Do not claim that cancellation can undo an already-issued OS write.
            let account = provider_id.to_string();
            let value = secret.clone();
            let result = tokio::task::spawn_blocking(move || {
                store_keychain_credential("morphz.provider", &account, value.as_str())
            })
            .await?;
            match result {
                Ok(()) => {
                    credential.name = Some(provider_id.to_string());
                    return Ok(());
                }
                Err(error) => {
                    let action = ui
                        .choose(
                            locale.text("Could not save credential", "无法保存凭证"),
                            &explain_keychain_error(locale, &error.to_string()),
                            &[
                                Choice::new(
                                    locale.text("Retry system store", "重试系统凭证库"),
                                    locale.text("Unlock the store first", "请先解锁系统凭证库"),
                                ),
                                Choice::new(
                                    locale
                                        .text("Choose Morphz secrets file", "改用 Morphz 密钥文件"),
                                    locale.text(
                                        "Explicitly save plaintext in the user directory",
                                        "明确选择在用户目录保存明文密钥",
                                    ),
                                ),
                                Choice::new(
                                    locale.text("Cancel", "取消"),
                                    locale.text("Do not save this configuration", "不保存本次配置"),
                                ),
                            ],
                            0,
                        )
                        .await?;
                    match action {
                        0 => continue,
                        1 => {
                            credential.source = CredentialSource::Env;
                            credential.name = Some(
                                ui.input(
                                    locale.text("Environment variable", "环境变量"),
                                    locale.text(
                                        "Select the variable to save.",
                                        "选择要保存的变量名。",
                                    ),
                                    Some(default_env),
                                    InputKind::EnvName,
                                )
                                .await?,
                            );
                            credential.service = None;
                            break;
                        }
                        _ => return Err(ui.cancelled()),
                    }
                }
            }
        }
    }
    let name = credential
        .name
        .as_deref()
        .ok_or("credential variable is missing")?;
    store_host_env_credential(name, secret.as_str())?;
    // The first-run invocation resumes in the same process after Setup.
    std::env::set_var(name, secret.as_str());
    Ok(())
}

async fn select_model(ui: &mut SetupTerminal, models: &[String]) -> Result<String, SetupError> {
    let locale = ui.locale;
    if models.is_empty() {
        return ui
            .input(
                locale.text("Model ID", "模型标识"),
                locale.text(
                    "The model catalog is unavailable. Enter the exact model name accepted by the provider.",
                    "模型目录不可用，请填写模型服务商接受的精确模型名称。",
                ),
                None,
                InputKind::Text,
            )
            .await;
    }
    let mut choices = models
        .iter()
        .map(|model| {
            Choice::new(
                model,
                locale.text("Provider model catalog", "服务商模型目录"),
            )
        })
        .collect::<Vec<_>>();
    choices.push(Choice::new(
        locale.text("Enter a model ID manually", "手工输入模型标识"),
        locale.text(
            "Use when the target model is not in the catalog",
            "目标模型不在目录中时使用",
        ),
    ));
    let selected = ui
        .choose(
            locale.text("Choose a model", "选择模型"),
            &if locale.is_chinese() {
                format!("模型服务商返回了 {} 个模型。", models.len())
            } else {
                format!("The provider returned {} models.", models.len())
            },
            &choices,
            0,
        )
        .await?;
    if selected < choices.len() - 1 {
        Ok(models[selected].clone())
    } else {
        ui.input(
            locale.text("Model ID", "模型标识"),
            locale.text(
                "Enter the exact model name accepted by the provider.",
                "填写模型服务商接受的精确模型名称。",
            ),
            None,
            InputKind::Text,
        )
        .await
    }
}

fn validate_env_name(name: &str) -> Result<(), SetupError> {
    let mut chars = name.chars();
    let valid_start = chars
        .next()
        .is_some_and(|character| character == '_' || character.is_ascii_alphabetic());
    if !valid_start || !chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
    {
        let locale = Locale::detect();
        return Err(if locale.is_chinese() {
            format!("'{name}' 不是合法的环境变量名").into()
        } else {
            format!("'{name}' is not a valid environment variable name").into()
        });
    }
    Ok(())
}

fn store_host_env_credential(name: &str, secret: &str) -> Result<PathBuf, SetupError> {
    let locale = Locale::detect();
    let home = morphz_home_dir().ok_or_else(|| {
        locale.text(
            "Could not determine the Morphz user configuration directory",
            "无法确定 Morphz 用户配置目录",
        )
    })?;
    store_host_env_credential_at(&home, name, secret)
}

fn store_host_env_credential_at(
    home: &Path,
    name: &str,
    secret: &str,
) -> Result<PathBuf, SetupError> {
    validate_env_name(name)?;
    if secret.is_empty()
        || secret
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    {
        return Err(Locale::detect()
            .text(
                "The API key cannot be empty or contain a newline",
                "接口密钥不能为空或包含换行符",
            )
            .into());
    }
    std::fs::create_dir_all(home)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = home.join(".env");
    let existing = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let encoded = format!("{name}={}\n", quote_env_value(secret));
    let mut replaced = false;
    let mut output = String::new();
    for line in existing.lines() {
        let assignment = line
            .trim_start()
            .strip_prefix("export ")
            .unwrap_or(line.trim_start());
        if assignment
            .split_once('=')
            .is_some_and(|(key, _)| key.trim() == name)
        {
            if !replaced {
                output.push_str(&encoded);
                replaced = true;
            }
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    if !replaced {
        output.push_str(&encoded);
    }
    // NamedTempFile creates an unpredictable, exclusive, mode-0600 file on
    // Unix, so there is no plaintext window before chmod or symlink race.
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(home)?;
    temporary.write_all(output.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(&path)?;
    Ok(path)
}

fn quote_env_value(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('\"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`")
    )
}

fn explain_keychain_error(locale: Locale, error: &str) -> String {
    if error.contains("-25308") || error.contains("User interaction is not allowed") {
        locale
            .text(
                "macOS must unlock or authorize the system keychain, but the current terminal process cannot display that interaction. The key has not been saved.",
                "macOS 需要解锁或授权系统钥匙串，但当前终端进程无法展示这次系统交互。密钥尚未保存。",
            )
            .to_string()
    } else if locale.is_chinese() {
        format!("操作系统拒绝了这次钥匙串写入：{error}。密钥尚未保存。")
    } else {
        format!("The operating system rejected the keychain write: {error}. The key has not been saved.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn test_theme() -> Theme {
        Theme::for_appearance(TuiTheme::Cyan, crate::tui::TerminalAppearance::Dark)
    }

    #[test]
    fn provider_presets_are_catalog_backed_and_protocol_explicit() {
        let presets = presets();
        assert_eq!(presets.len(), 5);
        assert_eq!(presets[0].protocol, ModelProtocol::OpenaiResponses);
        assert_eq!(presets[1].adapter, "openai-codex");
        assert_eq!(presets[1].oauth_adapter, Some("codex-oauth"));
        assert_eq!(presets[2].protocol, ModelProtocol::AnthropicMessages);
        assert_eq!(presets[3].protocol, ModelProtocol::GeminiContent);
        assert_eq!(presets[4].adapter, "kimi-code");
        assert_eq!(presets[4].protocol, ModelProtocol::OpenaiChat);
        assert_eq!(presets[4].oauth_adapter, Some("kimi-oauth"));
        assert!(presets
            .iter()
            .all(|preset| preset.base_url.starts_with("https://")));
    }

    #[test]
    fn environment_names_are_strict() {
        assert!(validate_env_name("MORPHZ_API_KEY_2").is_ok());
        assert!(validate_env_name("2BAD").is_err());
        assert!(validate_env_name("BAD-NAME").is_err());
    }

    #[test]
    fn input_validation_rejects_bad_urls_ids_and_reserved_variables() {
        let locale = Locale::English;
        for value in [
            "localhost:18804",
            "file:///etc/hosts",
            "https://user:key@api.test",
            "https://api.test?key=secret",
            "https://api.test/#token",
        ] {
            assert!(
                validate_input(InputKind::Url, value, locale).is_err(),
                "{value}"
            );
        }
        for value in [
            "http://localhost:18804/v1",
            "http://[::1]:18804/v1",
            "https://api.example.com/v1",
        ] {
            assert!(
                validate_input(InputKind::Url, value, locale).is_ok(),
                "{value}"
            );
        }
        assert!(validate_input(InputKind::ProviderId, "../bad", locale).is_err());
        assert!(validate_input(InputKind::ProviderId, "my-local_2", locale).is_ok());
        assert!(validate_input(InputKind::EnvName, "HOME", locale).is_err());
        assert!(validate_input(InputKind::EnvName, "MY_API_KEY", locale).is_ok());
        assert!(validate_input(InputKind::Text, "", locale).is_err());
    }

    fn key(code: KeyCode) -> crossterm::event::KeyEvent {
        crossterm::event::KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn input_editor_handles_unicode_midline_editing_and_sanitized_paste() {
        let mut input = InputBuffer::default();
        input.insert("a中🦀z");
        input.key(key(KeyCode::Left));
        input.key(key(KeyCode::Backspace));
        assert_eq!(input.value.as_str(), "a中z");
        input.insert("文\n\r\t");
        assert_eq!(input.value.as_str(), "a中文z");
        input.key(key(KeyCode::Home));
        input.key(key(KeyCode::Delete));
        assert_eq!(input.value.as_str(), "中文z");
        input.key(key(KeyCode::Right));
        input.insert("!");
        assert_eq!(input.value.as_str(), "中!文z");
        input.key(crossterm::event::KeyEvent::new(
            KeyCode::Char('u'),
            KeyModifiers::CONTROL,
        ));
        assert!(input.value.is_empty());
        assert_eq!(input.cursor, 0);
    }

    #[test]
    fn model_search_keeps_indices_beyond_the_old_eighteen_model_limit() {
        let choices: Vec<_> = (0..100)
            .map(|index| Choice::new(format!("model-{index:02}"), "catalog"))
            .collect();
        let mut selection = ChoiceSelection::new(0, choices.len());
        selection.key(key(KeyCode::End), choices.len());
        assert_eq!(selection.selected, 99);
        selection.key(key(KeyCode::Down), choices.len());
        assert_eq!(selection.selected, 0);
        selection.key(key(KeyCode::Char('/')), choices.len());
        for c in "MODEL-98".chars() {
            selection.key(key(KeyCode::Char(c)), choices.len());
        }
        assert_eq!(selection.matches(&choices), vec![98]);
        selection.query = "no-match".into();
        selection.key(key(KeyCode::Down), 0);
        assert!(selection.matches(&choices).is_empty());
        assert_eq!(selection.selected, 0);
    }

    #[test]
    fn input_viewport_always_leaves_a_cell_for_the_caret() {
        for value in ["abcdefghijklm", "中文🦀输入内容", ""] {
            for (index, _) in value
                .char_indices()
                .chain(std::iter::once((value.len(), '\0')))
            {
                let cursor = UnicodeWidthStr::width(&value[..index]);
                for width in 0..12 {
                    let (visible, caret) = visible_input_tail(value, cursor, width, true);
                    assert!(UnicodeWidthStr::width(visible.as_str()) <= width);
                    assert!(width == 0 || caret < width, "{value}, {cursor}, {width}");
                }
            }
        }
    }

    #[test]
    fn choice_layout_keeps_selection_and_footer_visible_at_supported_sizes() {
        let choices: Vec<_> = (0..50)
            .map(|index| Choice::new(format!("model-{index:02}"), "模型目录 / Catalog"))
            .collect();
        let indices: Vec<_> = (0..50).collect();
        for (width, height) in [(40, 16), (60, 20), (80, 24), (100, 32)] {
            for locale in [Locale::English, Locale::SimplifiedChinese] {
                for selected in [0, 18, 49] {
                    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                    terminal
                        .draw(|frame| {
                            render_setup_page(
                                frame,
                                SetupPage {
                                    step: 4,
                                    total_steps: 5,
                                    title: locale.text("Choose a model", "选择模型"),
                                    subtitle: locale.text(
                                        "Choose a catalog entry or search by model name.",
                                        "选择模型目录中的模型，或通过名称搜索。",
                                    ),
                                    body: vec![],
                                    footer: locale
                                        .text("Enter Confirm · Esc Cancel", "回车确认 · Esc 取消"),
                                    border_color: test_theme().brand,
                                    theme: test_theme(),
                                    input: None,
                                    choices: Some(SetupChoices {
                                        choices: &choices,
                                        indices: &indices,
                                        selected,
                                        query: "",
                                        searching: false,
                                    }),
                                    scroll: 0,
                                    locale,
                                },
                            )
                        })
                        .unwrap();
                    let buffer = terminal.backend().buffer();
                    let screen: String =
                        buffer.content().iter().map(|cell| cell.symbol()).collect();
                    assert!(
                        screen.contains(&format!("model-{selected:02}")),
                        "{width}x{height}: {screen}"
                    );
                    assert!(screen.contains("Esc"), "{width}x{height}: {screen}");
                    assert!(!terminal.backend().cursor_visible());
                    assert!(buffer.content().iter().all(|cell| cell.bg == Color::Reset));
                    assert!(buffer
                        .content()
                        .iter()
                        .any(|cell| cell.fg == Color::Rgb(86, 208, 222)));
                }
            }
        }
    }

    #[test]
    fn setup_reuses_contrast_correct_cyan_and_no_color_themes() {
        use crate::tui::TerminalAppearance;
        assert_eq!(
            Theme::for_appearance(TuiTheme::default(), TerminalAppearance::Dark).brand,
            Color::Rgb(86, 208, 222)
        );
        assert_eq!(
            Theme::for_appearance(TuiTheme::default(), TerminalAppearance::Light).brand,
            Color::Rgb(8, 124, 138)
        );
        let theme = Theme::for_appearance(TuiTheme::NoColor, TerminalAppearance::Dark);
        assert_eq!(theme.brand, Color::Reset);
        assert_eq!(theme.error, Color::Reset);
        assert_eq!(theme.success, Color::Reset);
    }

    #[test]
    fn secret_file_round_trips_special_characters_and_replaces_export_assignments() {
        let home = TempDir::new().unwrap();
        let path = home.path().join(".env");
        std::fs::write(
            &path,
            "# keep comment\nexport TOKEN = old\nOTHER=preserved\nTOKEN=duplicate\n",
        )
        .unwrap();
        let secret = "quotes\" dollar$ slash\\ hash# backtick`";
        store_host_env_credential_at(home.path(), "TOKEN", secret).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let values: Vec<_> = content
            .lines()
            .filter_map(|line| {
                let (name, raw) = line.split_once('=')?;
                Some((
                    name.to_string(),
                    crate::config::parse_env_value(raw).unwrap(),
                ))
            })
            .collect();
        assert_eq!(values.iter().filter(|(name, _)| name == "TOKEN").count(), 1);
        assert_eq!(
            values.iter().find(|(name, _)| name == "TOKEN").unwrap().1,
            secret
        );
        assert!(content.contains("# keep comment"));
        assert!(content.contains("OTHER=preserved"));
        assert_eq!(
            std::fs::read_dir(home.path()).unwrap().count(),
            1,
            "No temporary plaintext file left behind"
        );
    }

    #[test]
    fn host_secret_file_is_private_and_updates_one_variable() {
        let home = TempDir::new().unwrap();
        let path = store_host_env_credential_at(home.path(), "TOKEN", "first#value").unwrap();
        store_host_env_credential_at(home.path(), "OTHER", "second").unwrap();
        store_host_env_credential_at(home.path(), "TOKEN", "updated").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.matches("TOKEN=").count(), 1);
        assert!(content.contains("TOKEN=\"updated\""));
        assert!(content.contains("OTHER=\"second\""));
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn keychain_interaction_error_is_explained_in_product_language() {
        let message = explain_keychain_error(
            Locale::SimplifiedChinese,
            "PlatformFailure(Error { code: -25308, message: User interaction is not allowed. })",
        );
        assert!(message.contains("macOS"));
        assert!(message.contains("尚未保存"));
    }

    #[test]
    fn setup_input_is_focused_and_inherits_terminal_background() {
        let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
        terminal
            .draw(|frame| {
                render_setup_page(
                    frame,
                    SetupPage {
                        step: 3,
                        total_steps: 5,
                        title: "输入 API Key",
                        subtitle: "密钥只会保存到用户选择的凭证存储。",
                        body: Vec::new(),
                        footer: "Enter 确认   Esc 取消",
                        border_color: test_theme().brand,
                        theme: test_theme(),
                        choices: None,
                        scroll: 0,
                        input: Some(SetupInput {
                            label: "API KEY",
                            display: "输入 API Key".to_string(),
                            entered: false,
                            cursor_width: 0,
                            helper: "密钥原文不会显示".to_string(),
                        }),
                        locale: Locale::English,
                    },
                );
            })
            .unwrap();

        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("Morphz"));
        assert!(screen.contains("SETUP"));
        assert!(screen.contains("API KEY"));
        assert!(screen.contains('❯'));
        assert!(terminal.backend().cursor_visible());
        assert!(terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .all(|cell| cell.bg == Color::Reset));
    }

    #[test]
    fn long_setup_input_keeps_the_cursor_inside_the_visible_tail() {
        let (visible, cursor) =
            visible_input_tail("https://a-very-long-provider.example.com/v1", 44, 18, true);
        assert!(visible.starts_with('…'));
        assert!(UnicodeWidthStr::width(visible.as_str()) <= 18);
        assert_eq!(cursor, UnicodeWidthStr::width(visible.as_str()));
    }

    #[test]
    fn setup_chinese_surface_does_not_render_english_chrome() {
        let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
        terminal
            .draw(|frame| {
                render_setup_page(
                    frame,
                    SetupPage {
                        step: 1,
                        total_steps: 5,
                        title: "选择模型服务商",
                        subtitle: "模型服务商决定服务边界。",
                        body: vec![Line::from("  OpenAI")],
                        footer: "Enter 确认   Esc 取消",
                        border_color: test_theme().brand,
                        theme: test_theme(),
                        choices: None,
                        scroll: 0,
                        input: None,
                        locale: Locale::SimplifiedChinese,
                    },
                );
            })
            .unwrap();
        let screen = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(screen.contains("Morphz"));
        assert!(!screen.contains("INITIAL SETUP"));
        assert!(!screen.contains("STEP"));
    }
}
