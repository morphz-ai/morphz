use crate::config::{
    morphz_home_dir, save_managed_provider_catalog, AppConfig, AuthAccountConfig, CredentialConfig,
    CredentialSource, ModelProtocol, ModelRouteAffinity, ModelRouteCandidateConfig,
    ModelRouteConfig, ModelRouteSelection, ProviderConfig, ProviderInstanceConfig,
};
use crate::i18n::Locale;
use crate::provider::{
    builtin_provider_catalog, list_provider_models, probe_provider, store_keychain_credential,
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
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
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

// Setup deliberately inherits the terminal background. Named ANSI colors are
// resolved by the user's terminal theme and remain readable in light and dark
// appearances without Morphz owning the surface color.
const ACCENT: Color = Color::LightMagenta;
const MUTED: Color = Color::DarkGray;
const SUCCESS: Color = Color::Green;
const WARNING: Color = Color::Yellow;
const ERROR: Color = Color::Red;

#[derive(Debug, Clone)]
struct ProviderPreset {
    id: &'static str,
    adapter: &'static str,
    protocol: ModelProtocol,
    base_url: String,
    env_name: &'static str,
    oauth_adapter: Option<&'static str>,
    default_model: Option<&'static str>,
    default_alias: Option<&'static str>,
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
            default_model: None,
            default_alias: None,
        },
        ProviderPreset {
            id: "codex-subscription",
            adapter: "openai-codex",
            protocol: ModelProtocol::OpenaiResponses,
            base_url: "https://chatgpt.com/backend-api/codex".to_string(),
            env_name: "",
            oauth_adapter: Some("codex-oauth"),
            default_model: Some("gpt-5.6"),
            default_alias: Some("gpt-5.6"),
        },
        ProviderPreset {
            id: "anthropic",
            adapter: "protocol-compatible",
            protocol: ModelProtocol::AnthropicMessages,
            base_url: catalog["anthropic"].base_url.clone(),
            env_name: "ANTHROPIC_API_KEY",
            oauth_adapter: None,
            default_model: None,
            default_alias: None,
        },
        ProviderPreset {
            id: "gemini",
            adapter: "protocol-compatible",
            protocol: ModelProtocol::GeminiContent,
            base_url: catalog["gemini"].base_url.clone(),
            env_name: "GEMINI_API_KEY",
            oauth_adapter: None,
            default_model: None,
            default_alias: None,
        },
        ProviderPreset {
            id: "kimi-code",
            adapter: "kimi-code",
            protocol: ModelProtocol::OpenaiChat,
            base_url: "https://api.kimi.com/coding/v1".to_string(),
            env_name: "",
            oauth_adapter: Some("kimi-oauth"),
            default_model: Some("k3"),
            default_alias: Some("kimi-k3"),
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
}

impl SetupTerminal {
    fn enter(locale: Locale) -> Result<Self, SetupError> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableBracketedPaste, Hide) {
            let _ = disable_raw_mode();
            return Err(error.into());
        }
        let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        Ok(Self {
            terminal,
            events: EventStream::new(),
            step: 1,
            total_steps: 5,
            locale,
        })
    }

    fn draw_page(
        &mut self,
        title: &str,
        subtitle: &str,
        body: Vec<Line<'static>>,
        footer: &str,
        border_color: Color,
    ) -> Result<(), SetupError> {
        let page = SetupPage {
            step: self.step,
            total_steps: self.total_steps,
            title,
            subtitle,
            body,
            footer,
            border_color,
            input: None,
            locale: self.locale,
        };
        self.terminal.draw(|frame| render_setup_page(frame, page))?;
        Ok(())
    }

    fn draw_input_page(
        &mut self,
        title: &str,
        subtitle: &str,
        input: SetupInput,
        footer: &str,
    ) -> Result<(), SetupError> {
        let page = SetupPage {
            step: self.step,
            total_steps: self.total_steps,
            title,
            subtitle,
            body: Vec::new(),
            footer,
            border_color: ACCENT,
            input: Some(input),
            locale: self.locale,
        };
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

    async fn choose(
        &mut self,
        title: &str,
        subtitle: &str,
        choices: &[Choice],
        initial: usize,
    ) -> Result<usize, SetupError> {
        let mut selected = initial.min(choices.len().saturating_sub(1));
        loop {
            let mut body = Vec::new();
            let window_size = 4;
            let start = selected
                .saturating_sub(window_size / 2)
                .min(choices.len().saturating_sub(window_size));
            let end = (start + window_size).min(choices.len());
            if start > 0 {
                body.push(Line::from(Span::styled(
                    if self.locale.is_chinese() {
                        format!("      ↑ 还有 {start} 项")
                    } else {
                        format!("      ↑ {start} more")
                    },
                    Style::default().fg(MUTED),
                )));
                body.push(Line::from(""));
            }
            for (index, choice) in choices.iter().enumerate().take(end).skip(start) {
                let active = index == selected;
                body.push(Line::from(vec![
                    Span::styled(
                        if active { "  › " } else { "    " },
                        Style::default().fg(if active { ACCENT } else { MUTED }),
                    ),
                    Span::styled(
                        choice.title.clone(),
                        Style::default()
                            .fg(if active { ACCENT } else { Color::Reset })
                            .add_modifier(if active {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                ]));
                body.push(Line::from(Span::styled(
                    format!("      {}", choice.detail),
                    Style::default().fg(MUTED),
                )));
                body.push(Line::from(""));
            }
            if end < choices.len() {
                body.push(Line::from(Span::styled(
                    if self.locale.is_chinese() {
                        format!("      ↓ 还有 {} 项", choices.len() - end)
                    } else {
                        format!("      ↓ {} more", choices.len() - end)
                    },
                    Style::default().fg(MUTED),
                )));
            }
            self.draw_page(
                title,
                subtitle,
                body,
                self.locale.text(
                    "↑↓ / j k Select   Enter Confirm   Esc Cancel",
                    "方向键或 j/k 选择   回车确认   退出键取消",
                ),
                ACCENT,
            )?;
            match self.next_event().await? {
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('c')
                    {
                        return Err(self.locale.text("Setup cancelled", "设置已取消").into());
                    }
                    match key.code {
                        KeyCode::Up | KeyCode::Char('k') => {
                            selected = selected.checked_sub(1).unwrap_or(choices.len() - 1)
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            selected = (selected + 1) % choices.len()
                        }
                        KeyCode::Char(value) if value.is_ascii_digit() => {
                            if let Some(index) = value
                                .to_digit(10)
                                .and_then(|value| usize::try_from(value).ok())
                                .and_then(|value| value.checked_sub(1))
                                .filter(|index| *index < choices.len())
                            {
                                selected = index;
                            }
                        }
                        KeyCode::Enter => return Ok(selected),
                        KeyCode::Esc => {
                            return Err(self.locale.text("Setup cancelled", "设置已取消").into())
                        }
                        _ => {}
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
        secret: bool,
    ) -> Result<String, SetupError> {
        let mut value = String::new();
        loop {
            let entered = !value.is_empty();
            let display = if secret && entered {
                "•".repeat(value.chars().count())
            } else if entered {
                value.clone()
            } else {
                default
                    .map(|default| {
                        if self.locale.is_chinese() {
                            format!("默认：{default}")
                        } else {
                            format!("Default: {default}")
                        }
                    })
                    .unwrap_or_else(|| {
                        if secret {
                            self.locale.text("Enter API key", "输入密钥").to_string()
                        } else {
                            self.locale.text("Enter a value", "输入内容").to_string()
                        }
                    })
            };
            self.draw_input_page(
                title,
                subtitle,
                SetupInput {
                    label: if secret {
                        self.locale.text("API KEY", "密钥")
                    } else {
                        self.locale.text("VALUE", "输入")
                    },
                    display,
                    entered,
                    cursor_width: if entered {
                        if secret {
                            value.chars().count()
                        } else {
                            UnicodeWidthStr::width(value.as_str())
                        }
                    } else {
                        0
                    },
                    helper: if secret {
                        if entered {
                            if self.locale.is_chinese() {
                                format!("密钥已隐藏 · 已输入 {} 个字符", value.chars().count())
                            } else {
                                format!(
                                    "Secret hidden · {} characters entered",
                                    value.chars().count()
                                )
                            }
                        } else {
                            self.locale
                                .text(
                                    "The secret is never displayed or written to the project",
                                    "密钥原文不会显示或进入项目目录",
                                )
                                .to_string()
                        }
                    } else {
                        self.locale
                            .text("Type or paste a value", "支持直接输入和粘贴")
                            .to_string()
                    },
                },
                self.locale.text(
                    "Enter Confirm   Backspace Delete   Esc Cancel",
                    "回车确认   退格删除   退出键取消",
                ),
            )?;
            match self.next_event().await? {
                Event::Paste(text) => value.extend(
                    text.chars()
                        .filter(|character| !matches!(character, '\r' | '\n')),
                ),
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('c')
                    {
                        return Err(self.locale.text("Setup cancelled", "设置已取消").into());
                    }
                    match key.code {
                        KeyCode::Char(character)
                            if !key.modifiers.contains(KeyModifiers::CONTROL) =>
                        {
                            value.push(character)
                        }
                        KeyCode::Backspace => {
                            value.pop();
                        }
                        KeyCode::Enter => {
                            let result = if value.trim().is_empty() {
                                default.unwrap_or_default().to_string()
                            } else {
                                value.trim().to_string()
                            };
                            if !result.is_empty() {
                                return Ok(result);
                            }
                        }
                        KeyCode::Esc => {
                            return Err(self.locale.text("Setup cancelled", "设置已取消").into())
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    fn status(&mut self, title: &str, subtitle: &str, message: &str) -> Result<(), SetupError> {
        self.draw_page(
            title,
            subtitle,
            vec![
                Line::from(""),
                Line::from(Span::styled(
                    format!("  ◐  {message}"),
                    Style::default().fg(WARNING).add_modifier(Modifier::BOLD),
                )),
            ],
            self.locale
                .text("Working, please wait…", "正在处理，请稍候…"),
            WARNING,
        )
    }

    async fn acknowledge(
        &mut self,
        title: &str,
        subtitle: &str,
        message: &str,
        color: Color,
    ) -> Result<(), SetupError> {
        loop {
            self.draw_page(
                title,
                subtitle,
                message
                    .lines()
                    .map(|line| Line::from(format!("  {line}")))
                    .collect(),
                self.locale
                    .text("Enter Continue   Esc Cancel", "回车继续   退出键取消"),
                color,
            )?;
            if let Event::Key(key) = self.next_event().await? {
                if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                    continue;
                }
                match key.code {
                    KeyCode::Enter => return Ok(()),
                    KeyCode::Esc => {
                        return Err(self.locale.text("Setup cancelled", "设置已取消").into())
                    }
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Err(self.locale.text("Setup cancelled", "设置已取消").into())
                    }
                    _ => {}
                }
            }
        }
    }
}

impl Drop for SetupTerminal {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            Show,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = self.terminal.show_cursor();
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
    locale: Locale,
}

struct SetupInput {
    label: &'static str,
    display: String,
    entered: bool,
    cursor_width: usize,
    helper: String,
}

fn render_setup_page(frame: &mut Frame<'_>, page: SetupPage<'_>) {
    let SetupPage {
        step,
        total_steps,
        title,
        subtitle,
        body,
        footer,
        border_color,
        input,
        locale,
    } = page;
    let area = centered_setup_rect(frame.area());
    frame.render_widget(Clear, area);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(2),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(area);
    let header = Paragraph::new(Line::from(vec![
        Span::styled("◆", Style::default().fg(ACCENT)),
        Span::styled(
            "  Morphz",
            Style::default()
                .fg(Color::Reset)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            locale.text("  /  INITIAL SETUP", "  /  初始设置"),
            Style::default().fg(MUTED),
        ),
    ]));
    frame.render_widget(header, chunks[0]);
    let progress = setup_progress(step, total_steps, locale);
    frame.render_widget(Paragraph::new(progress), chunks[1]);

    let card = Block::default()
        .title(Line::from(vec![
            Span::styled("  ", Style::default()),
            Span::styled(
                title.to_uppercase(),
                Style::default()
                    .fg(border_color)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("  ", Style::default()),
        ]))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(MUTED))
        .padding(Padding::new(2, 2, 1, 1));
    let card_inner = card.inner(chunks[2]);
    frame.render_widget(card, chunks[2]);

    let content_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(3)])
        .split(card_inner);
    frame.render_widget(
        Paragraph::new(subtitle)
            .style(Style::default().fg(MUTED))
            .wrap(Wrap { trim: true }),
        content_chunks[0],
    );
    if let Some(input) = input {
        render_setup_input(frame, content_chunks[1], input, border_color);
    } else {
        frame.render_widget(
            Paragraph::new(body)
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(Color::Reset)),
            content_chunks[1],
        );
    }
    let footer = Paragraph::new(footer)
        .alignment(Alignment::Center)
        .style(Style::default().fg(MUTED));
    frame.render_widget(footer, chunks[3]);
}

fn setup_progress(step: usize, total_steps: usize, locale: Locale) -> Line<'static> {
    let mut spans = vec![
        Span::styled(locale.text("STEP ", "步骤 "), Style::default().fg(MUTED)),
        Span::styled(
            format!("{step:02}"),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" / {total_steps:02}    "),
            Style::default().fg(MUTED),
        ),
    ];
    for index in 1..=total_steps {
        spans.push(Span::styled(
            if index <= step { "●" } else { "○" },
            Style::default().fg(if index <= step { ACCENT } else { MUTED }),
        ));
        if index < total_steps {
            spans.push(Span::styled(" ─ ", Style::default().fg(MUTED)));
        }
    }
    Line::from(spans)
}

fn render_setup_input(frame: &mut Frame<'_>, area: Rect, input: SetupInput, color: Color) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(2),
            Constraint::Min(0),
        ])
        .split(area);
    let input_block = Block::default()
        .title(format!(" {} ", input.label))
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(color))
        .padding(Padding::horizontal(1));
    let input_inner = input_block.inner(rows[0]);
    frame.render_widget(input_block, rows[0]);

    let prefix = "› ";
    let available = input_inner
        .width
        .saturating_sub(UnicodeWidthStr::width(prefix) as u16) as usize;
    let (visible, visible_cursor) =
        visible_input_tail(&input.display, input.cursor_width, available, input.entered);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                prefix,
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                visible,
                Style::default()
                    .fg(if input.entered { Color::Reset } else { MUTED })
                    .add_modifier(if input.entered {
                        Modifier::BOLD
                    } else {
                        Modifier::ITALIC
                    }),
            ),
        ])),
        input_inner,
    );
    frame.render_widget(
        Paragraph::new(input.helper).style(Style::default().fg(MUTED)),
        rows[1],
    );
    let cursor_x = input_inner
        .x
        .saturating_add(UnicodeWidthStr::width(prefix) as u16)
        .saturating_add(visible_cursor as u16)
        .min(input_inner.right().saturating_sub(1));
    frame.set_cursor_position((cursor_x, input_inner.y));
}

fn visible_input_tail(
    display: &str,
    cursor_width: usize,
    available: usize,
    entered: bool,
) -> (String, usize) {
    if !entered {
        return (truncate_to_width(display, available), 0);
    }
    if cursor_width <= available {
        return (display.to_string(), cursor_width);
    }
    let content_width = available.saturating_sub(1);
    let mut width = 0;
    let mut tail = Vec::new();
    for character in display.chars().rev() {
        let character_width = character.width().unwrap_or(0);
        if width + character_width > content_width {
            break;
        }
        width += character_width;
        tail.push(character);
    }
    tail.reverse();
    (
        format!("…{}", tail.into_iter().collect::<String>()),
        width + 1,
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
    let width = area.width.saturating_sub(4).min(88);
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
    let mut ui = SetupTerminal::enter(locale)?;
    let locale = ui.locale;
    let catalog = presets();
    let provider_choice = ui
        .choose(
            locale.text("Choose a provider", "选择模型服务商"),
            locale.text(
                "The provider defines the model service boundary. The protocol is selected separately.",
                "模型服务商决定服务边界，通信协议将在下一步单独选择。",
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
    let (
        provider_id,
        provider_adapter,
        protocol,
        base_url,
        default_env,
        oauth_adapter,
        default_model,
        default_alias,
    ) = if let Some(preset) = catalog.get(provider_choice) {
        (
            preset.id.to_string(),
            preset.adapter.to_string(),
            preset.protocol,
            preset.base_url.clone(),
            preset.env_name.to_string(),
            preset.oauth_adapter.map(str::to_string),
            preset.default_model.map(str::to_string),
            preset.default_alias.map(str::to_string),
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
                false,
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
                    false,
                )
                .await?;
        (
            provider_id,
            "protocol-compatible".to_string(),
            protocol,
            base_url,
            "MORPHZ_PROVIDER_API_KEY".to_string(),
            None,
            None,
            None,
        )
    };

    ui.step = 3;
    let credential_id = provider_id.clone();
    let (credential, oauth_secret_backend) = if oauth_adapter.is_some() {
        (
            None,
            configure_oauth_secret_backend(&mut ui, &provider_id).await?,
        )
    } else {
        (
            configure_credential(&mut ui, &provider_id, &default_env).await?,
            None,
        )
    };

    let (model, route_id, connection_verified, verification_message) = if oauth_adapter.is_some() {
        ui.step = 4;
        let model = ui
            .input(
                locale.text("Provider model ID", "服务商模型标识"),
                locale.text(
                    "Use the exact physical model ID accepted by the subscription endpoint.",
                    "填写订阅接口实际接受的物理模型标识。",
                ),
                default_model.as_deref(),
                false,
            )
            .await?;
        let route_id = ui
            .input(
                locale.text("Model alias", "模型别名"),
                locale.text(
                    "Runtime evaluations use this stable alias; it may differ from the Provider model ID.",
                    "Runtime 求值使用这个稳定别名，它可以与服务商模型标识不同。",
                ),
                default_alias.as_deref().or(Some(model.as_str())),
                false,
            )
            .await?;
        let account_id = format!("{provider_id}-default");
        let verification_message = if locale.is_chinese() {
            format!(
                "OAuth Provider 图已保存。接下来 Morphz 将通过 Runtime 的统一账号生命周期启动登录。授权完成后可运行：\n\n  morphz model route test {route_id} --account {account_id}\n\n以后如需重新登录，可运行：\n\n  morphz provider account login {account_id}"
            )
        } else {
            format!(
                "The OAuth provider graph is saved. Morphz will now start login through the Runtime's unified account lifecycle. After authorization, you can run:\n\n  morphz model route test {route_id} --account {account_id}\n\nTo sign in again later, run:\n\n  morphz provider account login {account_id}"
            )
        };
        (model, route_id, false, verification_message)
    } else {
        let provider = ProviderConfig {
            protocol,
            base_url: base_url.clone(),
            credential: credential.as_ref().map(|_| credential_id.clone()),
            ..ProviderConfig::default()
        };
        let mut probe_config = AppConfig::default();
        probe_config.providers.insert(provider_id.clone(), provider);
        if let Some(credential) = credential.clone() {
            probe_config
                .credentials
                .insert(credential_id.clone(), credential);
        }
        probe_config.llm.provider = Some(provider_id.clone());

        ui.step = 4;
        ui.status(
            locale.text("Discovering models", "发现模型"),
            &format!("{} · {}", provider_id, protocol.as_str()),
            locale.text(
                "Connecting to the provider and reading its model catalog",
                "正在连接模型服务商并读取模型目录",
            ),
        )?;
        let (models, catalog_error) = match list_provider_models(&probe_config, &provider_id).await
        {
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
                WARNING,
            )
            .await?;
        }
        let model = select_model(&mut ui, &models).await?;
        probe_config.llm.model = model.clone();

        ui.step = 5;
        ui.status(
            locale.text("Verifying capabilities", "验证能力"),
            &format!("{} · {}", provider_id, model),
            locale.text(
                "Verifying streamed text and standard tool calls",
                "正在验证流式文本与标准工具调用",
            ),
        )?;
        let (verified, message) = match probe_provider(&probe_config, &provider_id, Some(&model))
            .await
        {
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
                        "模型服务商可以访问，但能力握手不完整。\n\n流式文本={}\n工具调用={}\n\n配置仍会保存，可使用 `morphz provider test {provider_id}` 复查。",
                        probe.completion_stream_verified, probe.tool_call_verified
                    )
                } else {
                    format!(
                        "The provider is reachable, but capability verification is incomplete.\n\nstream={}\ntool_call={}\n\nThe configuration will still be saved. Run `morphz provider test {provider_id}` to retry.",
                        probe.completion_stream_verified, probe.tool_call_verified
                    )
                },
            ),
            Err(error) => (
                false,
                if locale.is_chinese() {
                    format!("能力握手失败：\n\n{error}\n\n配置仍会保存，可使用 `morphz provider test {provider_id}` 复查。")
                } else {
                    format!("Capability verification failed:\n\n{error}\n\nThe configuration will still be saved. Run `morphz provider test {provider_id}` to retry.")
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
    let route = ModelRouteConfig {
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
    let config_path = save_managed_provider_catalog(
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
    )?;
    ui.acknowledge(
        if connection_verified {
            locale.text("Setup complete", "设置完成")
        } else {
            locale.text("Configuration saved", "配置已保存")
        },
        &format!("{} · {} · {}", provider_id, protocol.as_str(), route_id),
        &format!(
            "{verification_message}\n\n{}：{}",
            locale.text("Configuration", "配置文件"),
            config_path.display()
        ),
        if connection_verified {
            SUCCESS
        } else {
            WARNING
        },
    )
    .await?;
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
                "OAuth access and refresh tokens never enter configuration, prompts, Ledger, or logs.",
                "OAuth 访问令牌和刷新令牌不会进入配置、提示词、事件账本或日志。",
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
            WARNING,
        )
        .await?;
        Ok(Some("morphz_env_file".to_string()))
    }
}

async fn configure_credential(
    ui: &mut SetupTerminal,
    provider_id: &str,
    default_env: &str,
) -> Result<Option<CredentialConfig>, SetupError> {
    let locale = ui.locale;
    loop {
        let mode = ui
            .choose(
                locale.text("Configure credentials", "配置凭证"),
                locale.text(
                    "The key is stored only in the selected credential store and is never written to the project.",
                    "密钥只会进入明确选择的凭证存储，不会写入项目目录。",
                ),
                &[
                    Choice::new(
                        locale.text("System keychain", "系统钥匙串"),
                        locale.text(
                            "Recommended; protected by the operating system and may require unlocking",
                            "推荐使用，由操作系统保护，可能需要解锁",
                        ),
                    ),
                    Choice::new(
                        locale.text("Morphz secrets file", "Morphz 密钥文件"),
                        if locale.is_chinese() {
                            format!("用户级明文文件，权限为 0600；直接写入 {default_env}")
                        } else {
                            format!("User-level plaintext with mode 0600; writes {default_env}")
                        },
                    ),
                    Choice::new(
                        locale.text("Existing environment variable", "已有环境变量"),
                        if locale.is_chinese() {
                            format!("直接引用 {default_env}，不读取或保存密钥原文")
                        } else {
                            format!("References {default_env} without reading or storing the secret")
                        },
                    ),
                    Choice::new(
                        locale.text("No authentication", "无需认证"),
                        locale.text(
                            "Only for local services that require no credential",
                            "仅适用于不要求凭证的本地服务",
                        ),
                    ),
                ],
                0,
            )
            .await?;
        match mode {
            0 => {
                let secret = Zeroizing::new(
                    ui.input(
                        locale.text("Enter API key", "输入接口密钥"),
                        locale.text(
                            "Input is hidden; dots and a character count confirm that typing is active.",
                            "输入内容会被隐藏，界面通过圆点和字符数量反馈输入状态。",
                        ),
                        None,
                        true,
                    )
                    .await?,
                );
                loop {
                    ui.status(
                        locale.text("Saving to keychain", "保存到系统钥匙串"),
                        locale.text(
                            "Morphz is writing to the current user's credential store.",
                            "Morphz 正在写入当前用户的系统凭证库。",
                        ),
                        locale.text(
                            "Requesting access to the macOS keychain",
                            "正在请求访问 macOS 系统钥匙串",
                        ),
                    )?;
                    match store_keychain_credential("morphz.provider", provider_id, secret.as_str())
                    {
                        Ok(()) => {
                            return Ok(Some(CredentialConfig {
                                source: CredentialSource::Keychain,
                                name: Some(provider_id.to_string()),
                                service: Some("morphz.provider".to_string()),
                                command: Vec::new(),
                            }));
                        }
                        Err(error) => {
                            let explanation = explain_keychain_error(locale, &error.to_string());
                            let action = ui
                                .choose(
                                    locale.text(
                                        "Could not write to the keychain",
                                        "无法写入系统钥匙串",
                                    ),
                                    &explanation,
                                    &[
                                        Choice::new(
                                            locale.text("Retry keychain", "重试系统钥匙串"),
                                            locale.text(
                                                "Unlock the login keychain and try again",
                                                "解锁登录钥匙串后再次尝试",
                                            ),
                                        ),
                                        Choice::new(
                                            locale.text(
                                                "Use the Morphz secrets file",
                                                "改用 Morphz 密钥文件",
                                            ),
                                            locale.text(
                                                "Store the entered key in a user-level plaintext file with mode 0600",
                                                "将刚才输入的密钥写入权限为 0600 的用户级明文文件",
                                            ),
                                        ),
                                        Choice::new(
                                            locale.text(
                                                "Return to credential choices",
                                                "返回凭证选择",
                                            ),
                                            locale.text(
                                                "Discard the key that was just entered",
                                                "丢弃刚才输入的密钥",
                                            ),
                                        ),
                                    ],
                                    1,
                                )
                                .await?;
                            match action {
                                0 => continue,
                                1 => {
                                    let env_name = default_env.to_string();
                                    store_host_env_credential(&env_name, secret.as_str())?;
                                    std::env::set_var(&env_name, secret.as_str());
                                    return Ok(Some(CredentialConfig {
                                        source: CredentialSource::Env,
                                        name: Some(env_name),
                                        service: None,
                                        command: Vec::new(),
                                    }));
                                }
                                _ => break,
                            }
                        }
                    }
                }
            }
            1 => {
                let env_name = default_env.to_string();
                validate_env_name(&env_name)?;
                let secret = Zeroizing::new(
                    ui.input(
                        locale.text("Enter API key", "输入接口密钥"),
                        &if locale.is_chinese() {
                            format!("将以 {env_name} 写入权限为 0600 的 Morphz 密钥文件。")
                        } else {
                            format!("The key will be written as {env_name} to the Morphz secrets file with mode 0600.")
                        },
                        None,
                        true,
                    )
                    .await?,
                );
                store_host_env_credential(&env_name, secret.as_str())?;
                std::env::set_var(&env_name, secret.as_str());
                return Ok(Some(CredentialConfig {
                    source: CredentialSource::Env,
                    name: Some(env_name),
                    service: None,
                    command: Vec::new(),
                }));
            }
            2 => {
                let env_name = default_env.to_string();
                validate_env_name(&env_name)?;
                if std::env::var_os(&env_name).is_none() {
                    ui.acknowledge(
                        locale.text(
                            "Environment variable not found",
                            "环境变量不存在",
                        ),
                        locale.text(
                            "The default credential variable for this provider is not set.",
                            "当前模型服务商的默认凭证变量尚未设置。",
                        ),
                        &if locale.is_chinese() {
                            format!("当前进程中没有 {env_name}。\n\n请先设置该变量，或者选择 Morphz 密钥文件直接保存接口密钥。")
                        } else {
                            format!("{env_name} is not present in the current process.\n\nSet it first, or choose the Morphz secrets file to store the API key.")
                        },
                        ERROR,
                    )
                    .await?;
                    continue;
                }
                return Ok(Some(CredentialConfig {
                    source: CredentialSource::Env,
                    name: Some(env_name),
                    service: None,
                    command: Vec::new(),
                }));
            }
            _ => {
                return Ok(Some(CredentialConfig {
                    source: CredentialSource::None,
                    ..CredentialConfig::default()
                }))
            }
        }
    }
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
                false,
            )
            .await;
    }
    let mut choices = models
        .iter()
        .take(18)
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
            false,
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
    let prefix = format!("{name}=");
    let encoded = format!("{name}={}\n", quote_env_value(secret));
    let mut replaced = false;
    let mut output = String::new();
    for line in existing.lines() {
        if line.trim_start().starts_with(&prefix) {
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
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&temporary, output)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, &path)?;
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
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn provider_presets_are_catalog_backed_and_protocol_explicit() {
        let presets = presets();
        assert_eq!(presets.len(), 5);
        assert_eq!(presets[0].protocol, ModelProtocol::OpenaiResponses);
        assert_eq!(presets[1].adapter, "openai-codex");
        assert_eq!(presets[1].oauth_adapter, Some("codex-oauth"));
        assert_eq!(presets[1].default_model, Some("gpt-5.6"));
        assert_eq!(presets[2].protocol, ModelProtocol::AnthropicMessages);
        assert_eq!(presets[3].protocol, ModelProtocol::GeminiContent);
        assert_eq!(presets[4].adapter, "kimi-code");
        assert_eq!(presets[4].protocol, ModelProtocol::OpenaiChat);
        assert_eq!(presets[4].oauth_adapter, Some("kimi-oauth"));
        assert_eq!(presets[4].default_model, Some("k3"));
        assert_eq!(presets[4].default_alias, Some("kimi-k3"));
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
    fn host_secret_file_is_private_and_updates_one_variable() {
        let home = TempDir::new().unwrap();
        let path = store_host_env_credential_at(home.path(), "TOKEN", "first#value").unwrap();
        store_host_env_credential_at(home.path(), "OTHER", "second").unwrap();
        store_host_env_credential_at(home.path(), "TOKEN", "updated").unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.matches("TOKEN=").count(), 1);
        assert!(content.contains("TOKEN=\"updated\""));
        assert!(content.contains("OTHER=\"second\""));
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
                        border_color: ACCENT,
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
        assert!(screen.contains("INITIAL SETUP"));
        assert!(screen.matches("API KEY").count() >= 2);
        assert!(screen.contains('›'));
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
                        border_color: ACCENT,
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
