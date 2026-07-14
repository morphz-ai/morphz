use crate::config::{
    morphz_home_dir, save_managed_provider, AppConfig, CredentialConfig, CredentialSource,
    ModelProtocol, ProviderConfig,
};
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
use ratatui::widgets::{Block, BorderType, Borders, Clear, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use std::error::Error;
use std::io::{self, Stdout};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

type SetupError = Box<dyn Error + Send + Sync>;

const ACCENT: Color = Color::Rgb(91, 196, 255);
const MUTED: Color = Color::Rgb(127, 140, 160);
const PANEL: Color = Color::Rgb(20, 25, 34);
const SUCCESS: Color = Color::Rgb(119, 221, 119);
const WARNING: Color = Color::Rgb(245, 190, 80);
const ERROR: Color = Color::Rgb(255, 110, 120);

#[derive(Debug, Clone)]
struct ProviderPreset {
    id: &'static str,
    protocol: ModelProtocol,
    base_url: String,
    env_name: &'static str,
}

fn presets() -> Vec<ProviderPreset> {
    let catalog = builtin_provider_catalog();
    vec![
        ProviderPreset {
            id: "openai",
            protocol: ModelProtocol::OpenaiResponses,
            base_url: catalog["openai"].base_url.clone(),
            env_name: "OPENAI_API_KEY",
        },
        ProviderPreset {
            id: "anthropic",
            protocol: ModelProtocol::AnthropicMessages,
            base_url: catalog["anthropic"].base_url.clone(),
            env_name: "ANTHROPIC_API_KEY",
        },
        ProviderPreset {
            id: "gemini",
            protocol: ModelProtocol::GeminiContent,
            base_url: catalog["gemini"].base_url.clone(),
            env_name: "GEMINI_API_KEY",
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
}

impl SetupTerminal {
    fn enter() -> Result<Self, SetupError> {
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
        };
        self.terminal.draw(|frame| render_setup_page(frame, page))?;
        Ok(())
    }

    async fn next_event(&mut self) -> Result<Event, SetupError> {
        self.events
            .next()
            .await
            .ok_or("Setup 终端事件流已关闭")?
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
            let window_size = 6;
            let start = selected
                .saturating_sub(window_size / 2)
                .min(choices.len().saturating_sub(window_size));
            let end = (start + window_size).min(choices.len());
            if start > 0 {
                body.push(Line::from(Span::styled(
                    format!("      ↑ 还有 {start} 项"),
                    Style::default().fg(MUTED),
                )));
                body.push(Line::from(""));
            }
            for (index, choice) in choices.iter().enumerate().take(end).skip(start) {
                let active = index == selected;
                body.push(Line::from(vec![
                    Span::styled(
                        if active { "  ◆ " } else { "    " },
                        Style::default().fg(if active { ACCENT } else { MUTED }),
                    ),
                    Span::styled(
                        choice.title.clone(),
                        Style::default()
                            .fg(if active { Color::White } else { MUTED })
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
                    format!("      ↓ 还有 {} 项", choices.len() - end),
                    Style::default().fg(MUTED),
                )));
            }
            self.draw_page(
                title,
                subtitle,
                body,
                "↑↓ / j k 选择   Enter 确认   Esc 取消",
                ACCENT,
            )?;
            match self.next_event().await? {
                Event::Key(key)
                    if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) =>
                {
                    if key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('c')
                    {
                        return Err("Setup 已取消".into());
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
                        KeyCode::Esc => return Err("Setup 已取消".into()),
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
            let display = if secret {
                if value.is_empty() {
                    "尚未输入".to_string()
                } else {
                    format!(
                        "{}  已输入 {} 个字符",
                        "•".repeat(value.chars().count()),
                        value.chars().count()
                    )
                }
            } else if value.is_empty() {
                default
                    .map(|default| format!("默认：{default}"))
                    .unwrap_or_else(|| "请输入内容".to_string())
            } else {
                value.clone()
            };
            let body = vec![
                Line::from(""),
                Line::from(Span::styled(
                    format!("  {display}"),
                    Style::default()
                        .fg(if value.is_empty() {
                            MUTED
                        } else {
                            Color::White
                        })
                        .add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    if secret {
                        "  密钥原文永远不会显示；上面的圆点和字符数用于确认输入已经生效。"
                    } else {
                        "  支持粘贴；Enter 确认当前值。"
                    },
                    Style::default().fg(MUTED),
                )),
            ];
            self.draw_page(
                title,
                subtitle,
                body,
                "Enter 确认   Backspace 删除   Esc 取消",
                if secret { WARNING } else { ACCENT },
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
                        return Err("Setup 已取消".into());
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
                        KeyCode::Esc => return Err("Setup 已取消".into()),
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
            "正在处理，请稍候…",
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
                "Enter 继续   Esc 取消",
                color,
            )?;
            if let Event::Key(key) = self.next_event().await? {
                if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
                    continue;
                }
                match key.code {
                    KeyCode::Enter => return Ok(()),
                    KeyCode::Esc => return Err("Setup 已取消".into()),
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        return Err("Setup 已取消".into())
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
    } = page;
    let area = centered_rect(78, 78, frame.area());
    frame.render_widget(Clear, area);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(8),
            Constraint::Length(2),
        ])
        .split(area);
    let progress = (0..total_steps)
        .map(|index| if index < step { "━" } else { "─" })
        .collect::<Vec<_>>()
        .join("━━");
    let header = Paragraph::new(vec![
        Line::from(vec![
            Span::styled(
                " Morphz Setup ",
                Style::default()
                    .fg(Color::Black)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!("   {title}")),
        ]),
        Line::from(Span::styled(
            format!(" {progress}   {step}/{total_steps}   {subtitle}"),
            Style::default().fg(MUTED),
        )),
    ])
    .block(
        Block::default()
            .borders(Borders::TOP | Borders::LEFT | Borders::RIGHT)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(border_color))
            .style(Style::default().bg(PANEL)),
    );
    frame.render_widget(header, chunks[0]);
    let content = Paragraph::new(body)
        .wrap(Wrap { trim: false })
        .block(
            Block::default()
                .borders(Borders::LEFT | Borders::RIGHT)
                .border_style(Style::default().fg(border_color))
                .padding(ratatui::widgets::Padding::uniform(1)),
        )
        .style(Style::default().bg(PANEL).fg(Color::White));
    frame.render_widget(content, chunks[1]);
    let footer = Paragraph::new(footer)
        .alignment(Alignment::Center)
        .style(Style::default().fg(MUTED).bg(PANEL))
        .block(
            Block::default()
                .borders(Borders::BOTTOM | Borders::LEFT | Borders::RIGHT)
                .border_type(BorderType::Rounded)
                .border_style(Style::default().fg(border_color)),
        );
    frame.render_widget(footer, chunks[2]);
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

pub async fn run_interactive_setup() -> Result<SetupResult, SetupError> {
    let mut ui = SetupTerminal::enter()?;
    let catalog = presets();
    let provider_choice = ui
        .choose(
            "选择 Provider",
            "Provider 决定模型服务的物理边界；协议在下一步单独声明。",
            &[
                Choice::new("OpenAI", "官方 OpenAI Responses API"),
                Choice::new("Anthropic", "官方 Anthropic Messages API"),
                Choice::new("Google Gemini", "官方 Gemini generateContent API"),
                Choice::new("自定义 Provider", "本地代理、私有部署或兼容标准协议的服务"),
            ],
            0,
        )
        .await?;

    ui.step = 2;
    let (provider_id, protocol, base_url, default_env) =
        if let Some(preset) = catalog.get(provider_choice) {
            (
                preset.id.to_string(),
                preset.protocol,
                preset.base_url.clone(),
                preset.env_name.to_string(),
            )
        } else {
            let provider_id = ui
                .input(
                    "Provider 标识",
                    "这是配置中的稳定名称，例如 local-proxy。",
                    Some("custom"),
                    false,
                )
                .await?;
            let protocol_choice = ui
                .choose(
                    "选择协议",
                    "协议决定请求和流式响应的编码方式，不能从模型名称猜测。",
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
                    "Provider 地址",
                    "填写协议根地址；Morphz 会根据协议拼接具体 endpoint。",
                    None,
                    false,
                )
                .await?;
            (
                provider_id,
                protocol,
                base_url,
                "MORPHZ_PROVIDER_API_KEY".to_string(),
            )
        };

    ui.step = 3;
    let credential_id = provider_id.clone();
    let credential = configure_credential(&mut ui, &provider_id, &default_env).await?;
    let provider = ProviderConfig {
        protocol,
        base_url,
        credential: credential.as_ref().map(|_| credential_id.clone()),
        ..ProviderConfig::default()
    };
    let mut probe_config = AppConfig::default();
    probe_config
        .providers
        .insert(provider_id.clone(), provider.clone());
    if let Some(credential) = credential.clone() {
        probe_config
            .credentials
            .insert(credential_id.clone(), credential);
    }
    probe_config.llm.provider = Some(provider_id.clone());

    ui.step = 4;
    ui.status(
        "发现模型",
        &format!("{} · {}", provider_id, protocol.as_str()),
        "正在连接 Provider 并读取模型目录",
    )?;
    let (models, catalog_error) = match list_provider_models(&probe_config, &provider_id).await {
        Ok(models) => (models, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    if let Some(error) = catalog_error {
        ui.acknowledge(
            "模型目录不可用",
            "这不会阻止手工填写模型 ID。",
            &format!("读取模型目录失败：\n\n{error}\n\n请确认凭证、协议和 Base URL。"),
            WARNING,
        )
        .await?;
    }
    let model = select_model(&mut ui, &models).await?;
    probe_config.llm.model = model.clone();

    ui.step = 5;
    ui.status(
        "验证能力",
        &format!("{} · {}", provider_id, model),
        "正在验证流式正文与标准工具调用",
    )?;
    let (connection_verified, verification_message) =
        match probe_provider(&probe_config, &provider_id, Some(&model)).await {
            Ok(probe) if probe.completion_stream_verified && probe.tool_call_verified => (
                true,
                "Provider 连接成功；流式正文与工具调用握手均通过。".to_string(),
            ),
            Ok(probe) => (
                false,
                format!(
                    "Provider 可达，但能力握手不完整。\n\nstream={}\ntool_call={}\n\n配置仍会保存，可使用 `morphz provider test {provider_id}` 复查。",
                    probe.completion_stream_verified, probe.tool_call_verified
                ),
            ),
            Err(error) => (
                false,
                format!(
                    "能力握手失败：\n\n{error}\n\n配置仍会保存，可使用 `morphz provider test {provider_id}` 复查。"
                ),
            ),
        };
    let config_path = save_managed_provider(
        &provider_id,
        &provider,
        credential
            .as_ref()
            .map(|credential| (credential_id.as_str(), credential)),
        &model,
    )?;
    ui.acknowledge(
        if connection_verified {
            "Setup 完成"
        } else {
            "配置已保存"
        },
        &format!("{} · {} · {}", provider_id, protocol.as_str(), model),
        &format!(
            "{verification_message}\n\n配置文件：{}",
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
        model,
        config_path,
        connection_verified,
    })
}

async fn configure_credential(
    ui: &mut SetupTerminal,
    provider_id: &str,
    default_env: &str,
) -> Result<Option<CredentialConfig>, SetupError> {
    loop {
        let mode = ui
            .choose(
                "配置凭证",
                "密钥只进入你明确选择的安全存储；不会写入项目目录。",
                &[
                    Choice::new("系统 Keychain", "推荐；由操作系统保护，可能需要解锁"),
                    Choice::new(
                        "Morphz secrets 文件",
                        "$MORPHZ_HOME/.env 中的用户级明文；目录 0700、文件 0600",
                    ),
                    Choice::new("既有环境变量", "只记录变量名，不读取或保存密钥原文"),
                    Choice::new("无认证", "仅适用于不要求凭证的本地服务"),
                ],
                0,
            )
            .await?;
        match mode {
            0 => {
                let secret = Zeroizing::new(
                    ui.input(
                        "输入 API Key",
                        "输入被隐藏；界面会显示圆点和字符数量作为反馈。",
                        None,
                        true,
                    )
                    .await?,
                );
                loop {
                    ui.status(
                        "保存到 Keychain",
                        "Morphz 正在写入当前用户的系统凭证库。",
                        "正在请求 macOS Keychain",
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
                            let explanation = explain_keychain_error(&error.to_string());
                            let action = ui
                                .choose(
                                    "Keychain 无法写入",
                                    &explanation,
                                    &[
                                        Choice::new("重试 Keychain", "解锁登录钥匙串后再次尝试"),
                                        Choice::new(
                                            "改存 Morphz secrets 文件",
                                            "使用刚才输入的密钥，写入权限为 0600 的用户级明文文件",
                                        ),
                                        Choice::new("返回凭证选择", "丢弃刚才输入的密钥"),
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
                let env_name = ui
                    .input(
                        "凭证变量名",
                        "密钥保存在 Morphz 用户级 .env；配置只引用这个变量名。",
                        Some(default_env),
                        false,
                    )
                    .await?;
                validate_env_name(&env_name)?;
                let secret = Zeroizing::new(
                    ui.input(
                        "输入 API Key",
                        "输入被隐藏；文件会以 0600 权限原子写入。",
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
                let env_name = ui
                    .input(
                        "环境变量名",
                        "该变量必须已存在于当前进程或 Morphz 用户级 .env 中。",
                        Some(default_env),
                        false,
                    )
                    .await?;
                validate_env_name(&env_name)?;
                if std::env::var_os(&env_name).is_none() {
                    ui.acknowledge(
                        "环境变量不存在",
                        "Morphz 不会猜测或创建外部环境变量。",
                        &format!(
                            "当前进程中没有 {env_name}。\n\n请先设置该变量，或者选择 Morphz secrets 文件。"
                        ),
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
    if models.is_empty() {
        return ui
            .input(
                "模型 ID",
                "模型目录不可用，请填写 Provider 接受的精确模型名称。",
                None,
                false,
            )
            .await;
    }
    let mut choices = models
        .iter()
        .take(18)
        .map(|model| Choice::new(model, "Provider 模型目录"))
        .collect::<Vec<_>>();
    choices.push(Choice::new("手工输入模型 ID", "目录中没有目标模型时使用"));
    let selected = ui
        .choose(
            "选择模型",
            &format!("Provider 返回了 {} 个模型。", models.len()),
            &choices,
            0,
        )
        .await?;
    if selected < choices.len() - 1 {
        Ok(models[selected].clone())
    } else {
        ui.input("模型 ID", "填写 Provider 接受的精确模型名称。", None, false)
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
        return Err(format!("'{name}' 不是合法的环境变量名").into());
    }
    Ok(())
}

fn store_host_env_credential(name: &str, secret: &str) -> Result<PathBuf, SetupError> {
    let home = morphz_home_dir().ok_or("无法确定 Morphz 用户配置目录")?;
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
        return Err("API Key 不能为空或包含换行符".into());
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

fn explain_keychain_error(error: &str) -> String {
    if error.contains("-25308") || error.contains("User interaction is not allowed") {
        "macOS 需要解锁或授权 Keychain，但当前 cargo/终端进程不能展示这次系统交互。密钥尚未被保存。"
            .to_string()
    } else {
        format!("操作系统拒绝了这次 Keychain 写入：{error}。密钥尚未被保存。")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    #[test]
    fn provider_presets_are_catalog_backed_and_protocol_explicit() {
        let presets = presets();
        assert_eq!(presets.len(), 3);
        assert_eq!(presets[0].protocol, ModelProtocol::OpenaiResponses);
        assert_eq!(presets[1].protocol, ModelProtocol::AnthropicMessages);
        assert_eq!(presets[2].protocol, ModelProtocol::GeminiContent);
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
            "PlatformFailure(Error { code: -25308, message: User interaction is not allowed. })",
        );
        assert!(message.contains("macOS"));
        assert!(message.contains("尚未被保存"));
    }
}
