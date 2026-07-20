//! Product-level command-line schema powered by Clap.
//!
//! Morphz keeps one intentionally unusual convenience: text entered directly
//! after `morphz` is an Agent prompt. Exact command names still select the
//! structured CLI, and `--` always forces the remaining text to be a prompt.
//! Everything below that boundary follows conventional Clap semantics.

use crate::i18n::Locale;
use clap::{
    builder::{StringValueParser, TypedValueParser},
    error::ErrorKind,
    Arg, ArgAction, ArgMatches, Command, Error as ClapError,
};
use std::collections::BTreeMap;
use std::ffi::OsString;

const VALUE_OPTIONS: &[&str] = &[
    "cwd",
    "add-dir",
    "profile",
    "provider",
    "model",
    "reasoning-effort",
    "agent",
    "context",
    "session",
    "sandbox",
    "approval",
    "config-file",
    "set",
    "log-level",
    "theme",
    "language",
    "format",
    "bind",
    "id",
    "title",
    "limit",
    "reason",
    "token-budget",
    "network",
];

const SWITCH_OPTIONS: &[&str] = &[
    "independent",
    "last",
    "include-archived",
    "include-terminal",
    "tui",
    "plain",
];

const TOP_LEVEL_COMMANDS: &[&str] = &[
    "exec",
    "resume",
    "serve",
    "dashboard",
    "setup",
    "provider",
    "model",
    "profile",
    "context",
    "scheduler",
    "session",
    "agent",
    "objective",
    "job",
    "config",
    "doctor",
    "completion",
    "version",
    "help",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOption {
    occurrences: Vec<Option<String>>,
}

impl ParsedOption {
    pub fn occurrences(&self) -> &[Option<String>] {
        &self.occurrences
    }

    pub fn last_value(&self) -> Option<&str> {
        self.occurrences.last().and_then(|value| value.as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    command_path: Vec<String>,
    options: BTreeMap<String, ParsedOption>,
    prompt_args: Vec<String>,
}

impl Invocation {
    pub fn command_path(&self) -> &[String] {
        &self.command_path
    }

    pub fn options(&self) -> &BTreeMap<String, ParsedOption> {
        &self.options
    }

    pub fn option(&self, name: &str) -> Option<&ParsedOption> {
        self.options.get(name)
    }

    pub fn has_option(&self, name: &str) -> bool {
        self.options.contains_key(name)
    }

    pub fn prompt_args(&self) -> &[String] {
        &self.prompt_args
    }

    pub fn prompt(&self) -> String {
        self.prompt_args.join(" ")
    }

    fn from_matches(matches: &ArgMatches) -> Self {
        let mut options = BTreeMap::new();
        for name in VALUE_OPTIONS {
            if let Some(values) = matched_values(matches, name) {
                options.insert(
                    (*name).to_string(),
                    ParsedOption {
                        occurrences: values.into_iter().map(Some).collect(),
                    },
                );
            }
        }
        for name in SWITCH_OPTIONS {
            if matched_switch(matches, name) {
                options.insert(
                    (*name).to_string(),
                    ParsedOption {
                        occurrences: vec![None],
                    },
                );
            }
        }
        Self {
            command_path: command_path(matches),
            options,
            prompt_args: matched_prompt(matches),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CommandLineParser {
    command: Command,
}

impl CommandLineParser {
    pub fn parse<I, S>(&self, args: I) -> Result<Invocation, ClapError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let raw = args.into_iter().map(Into::into).collect::<Vec<_>>();
        if raw.first().is_some_and(|value| value == "help") {
            let help_argv = std::iter::once(OsString::from("morphz"))
                .chain(raw.iter().skip(1).cloned())
                .chain(std::iter::once(OsString::from("--help")));
            return match self.command.clone().try_get_matches_from(help_argv) {
                Err(error) => Err(error),
                Ok(_) => unreachable!("--help must terminate Clap parsing"),
            };
        }
        let argv = std::iter::once(OsString::from("morphz")).chain(raw.iter().cloned());
        let matches = self.command.clone().try_get_matches_from(argv)?;
        let invocation = Invocation::from_matches(&matches);

        if invocation.command_path.is_empty() && !raw.iter().any(|value| value == "--") {
            if let Some(typed) = invocation.prompt_args.first() {
                if let Some(suggestion) = nearest_command(typed) {
                    let mut command = self.command.clone();
                    return Err(command.error(
                        ErrorKind::InvalidSubcommand,
                        format!(
                            "unrecognized subcommand '{typed}'\n\n  tip: a similar subcommand exists: '{suggestion}'"
                        ),
                    ));
                }
            }
        }

        Ok(invocation)
    }
}

pub fn morphz_command_line_parser() -> CommandLineParser {
    morphz_command_line_parser_for(Locale::English)
}

pub fn morphz_command_line_parser_for(locale: Locale) -> CommandLineParser {
    CommandLineParser {
        command: morphz_command_for(locale),
    }
}

/// Returns the canonical command schema for help, parsing and completions.
pub fn morphz_command() -> Command {
    morphz_command_for(Locale::English)
}

pub fn morphz_command_for(locale: Locale) -> Command {
    let command = Command::new("morphz")
        .version(env!("CARGO_PKG_VERSION"))
        .about(locale.text(
            "Agent runtime with Context-owned Sessions",
            "由上下文承载会话的代理运行时",
        ))
        .long_about(locale.text(
            "Morphz is an Agent runtime with persistent Context, Sessions, Objectives and a fullscreen terminal UI.\n\nText entered without a subcommand is sent directly to the Agent.",
            "Morphz 是具有持久上下文、会话、目标和全屏终端界面的代理运行时。\n\n不带子命令输入的文本会直接发送给代理。",
        ))
        .propagate_version(true)
        .next_line_help(true)
        .help_expected(true)
        .args(global_args(locale))
        .arg(prompt_arg("PROMPT", 0, None).help(locale.text(
            "Send text directly to the Agent",
            "直接向代理发送文本",
        )))
        .subcommands([
            exec_command(locale),
            resume_command("resume", locale),
            serve_command(locale),
            dashboard_command(locale),
            Command::new("setup")
                .about(locale.text(
                    "Configure a model provider interactively",
                    "交互式配置模型服务商",
                ))
                .after_help(locale.text("Example:\n  morphz setup", "示例：\n  morphz setup")),
            provider_command(locale),
            model_command(locale),
            profile_command(locale),
            context_command(locale),
            scheduler_command(locale),
            session_command(locale),
            agent_command(locale),
            objective_command(locale),
            job_command(locale),
            config_command(locale),
            Command::new("doctor")
                .about(locale.text(
                    "Check storage, workspace, permissions and provider setup",
                    "检查存储、工作区、权限和模型服务商配置",
                ))
                .after_help(locale.text("Example:\n  morphz doctor", "示例：\n  morphz doctor")),
            Command::new("completion")
                .about(locale.text(
                    "Generate shell completion definitions",
                    "生成命令行补全定义",
                ))
                .arg(
                    prompt_arg("SHELL", 1, Some(1))
                        .value_parser(["bash", "elvish", "fish", "powershell", "zsh"])
                        .help(locale.text(
                            "Shell to generate completions for",
                            "要生成补全定义的命令行环境",
                        )),
                )
                .after_help(locale.text(
                    "Example:\n  morphz completion zsh > ~/.zfunc/_morphz",
                    "示例：\n  morphz completion zsh > ~/.zfunc/_morphz",
                )),
            Command::new("version")
                .about(locale.text("Print the Morphz version", "显示 Morphz 版本"))
                .after_help(locale.text("Example:\n  morphz version", "示例：\n  morphz version")),
        ])
        .after_help(locale.text(
            "Examples:\n  morphz\n  morphz please help me fix this project\n  morphz -- session list\n  morphz session list --format=json\n  morphz resume --context=context-default",
            "示例：\n  morphz\n  morphz 请帮我修复这个项目\n  morphz -- session list\n  morphz session list --format=json\n  morphz resume --context=context-default",
        ));

    localize_command_chrome(command, locale, true)
}

const ZH_HELP_TEMPLATE_FULL: &str = "{before-help}{about-with-newline}\n用法：{usage}\n\n命令：\n{subcommands}\n参数：\n{positionals}\n选项：\n{options}{after-help}";
const ZH_HELP_TEMPLATE_COMMANDS: &str = "{before-help}{about-with-newline}\n用法：{usage}\n\n命令：\n{subcommands}\n选项：\n{options}{after-help}";
const ZH_HELP_TEMPLATE_POSITIONALS: &str = "{before-help}{about-with-newline}\n用法：{usage}\n\n参数：\n{positionals}\n选项：\n{options}{after-help}";
const ZH_HELP_TEMPLATE_OPTIONS: &str =
    "{before-help}{about-with-newline}\n用法：{usage}\n\n选项：\n{options}{after-help}";

fn localize_command_chrome(command: Command, locale: Locale, root: bool) -> Command {
    if !locale.is_chinese() {
        return command;
    }

    let command =
        command.mut_subcommands(|subcommand| localize_command_chrome(subcommand, locale, false));
    let has_subcommands = command.get_subcommands().next().is_some();
    let has_positionals = command.get_positionals().next().is_some();
    let template = match (has_subcommands, has_positionals) {
        (true, true) => ZH_HELP_TEMPLATE_FULL,
        (true, false) => ZH_HELP_TEMPLATE_COMMANDS,
        (false, true) => ZH_HELP_TEMPLATE_POSITIONALS,
        (false, false) => ZH_HELP_TEMPLATE_OPTIONS,
    };

    let command = command
        .disable_help_subcommand(true)
        .disable_help_flag(true)
        .hide_possible_values(true)
        .help_template(template)
        .arg(
            Arg::new("help")
                .short('h')
                .long("help")
                .action(ArgAction::Help)
                .help("显示帮助"),
        );

    if root {
        command.disable_version_flag(true).arg(
            Arg::new("version")
                .short('V')
                .long("version")
                .global(true)
                .action(ArgAction::Version)
                .help("显示版本"),
        )
    } else {
        command
    }
}

fn global_args(locale: Locale) -> Vec<Arg> {
    vec![
        value_arg(
            "cwd",
            "cwd",
            "DIR",
            locale.text(
                "Change working directory before loading configuration",
                "在加载配置前更改工作目录",
            ),
        )
        .short('C'),
        value_arg(
            "config-file",
            "config-file",
            "FILE",
            locale.text(
                "Load an explicit trusted configuration file",
                "加载指定的可信配置文件",
            ),
        ),
        value_arg(
            "profile",
            "profile",
            "NAME",
            locale.text("Load a named configuration profile", "加载具名配置方案"),
        )
        .short('p'),
        value_arg(
            "provider",
            "provider",
            "ID",
            locale.text(
                "Override the configured model provider",
                "覆盖已配置的模型服务商",
            ),
        ),
        value_arg(
            "model",
            "model",
            "MODEL",
            locale.text("Override the configured model", "覆盖已配置的模型"),
        )
        .short('m'),
        value_arg(
            "reasoning-effort",
            "reasoning-effort",
            "LEVEL",
            locale.text("Set model reasoning effort", "设置模型推理强度"),
        )
        .value_parser([
            "default", "auto", "none", "off", "low", "medium", "high", "max",
        ]),
        value_arg(
            "agent",
            "agent",
            "ID",
            locale.text("Select an Agent", "选择代理"),
        ),
        value_arg(
            "context",
            "context",
            "ID",
            locale.text(
                "Select or mount a Cognitive Context",
                "选择或挂载认知上下文",
            ),
        ),
        value_arg(
            "session",
            "session",
            "ID",
            locale.text("Reattach an existing Session", "重新连接现有会话"),
        ),
        value_arg(
            "sandbox",
            "sandbox",
            "MODE",
            locale.text("Set the command sandbox mode", "设置命令沙箱模式"),
        )
        .short('s')
        .value_parser(["workspace-write", "full-access", "danger-full-access"]),
        value_arg(
            "approval",
            "approval",
            "MODE",
            locale.text("Set the approval policy", "设置权限审批策略"),
        )
        .short('a')
        .value_parser(["human", "ask", "auto", "auto-review", "never", "deny"]),
        value_arg(
            "add-dir",
            "add-dir",
            "DIR",
            locale.text("Add a readable and writable directory", "添加可读写目录"),
        )
        .action(ArgAction::Append),
        Arg::new("network")
            .long("network")
            .global(true)
            .num_args(0..=1)
            .require_equals(true)
            .default_missing_value("true")
            .value_name("BOOL")
            .value_parser(["true", "false", "1", "0", "yes", "no", "on", "off"])
            .help(locale.text(
                "Allow sandboxed commands to access the network",
                "允许沙箱命令访问网络",
            )),
        value_arg(
            "set",
            "set",
            "KEY=VALUE",
            locale.text("Override one configuration value", "覆盖单个配置值"),
        )
        .short('c')
        .action(ArgAction::Append),
        value_arg(
            "log-level",
            "log-level",
            "FILTER",
            locale.text("Override the tracing filter", "覆盖日志过滤器"),
        ),
        value_arg(
            "theme",
            "theme",
            "THEME",
            locale.text("Select the TUI color theme", "选择终端界面颜色主题"),
        )
        .value_parser(["system", "mono", "iris", "cyan", "coral", "no-color"]),
        value_arg(
            "language",
            "language",
            "LANGUAGE",
            locale.text("Select the user-interface language", "选择用户界面语言"),
        )
        .alias("lang")
        .value_parser(["auto", "en", "zh-CN"]),
        value_arg(
            "format",
            "format",
            "FORMAT",
            locale.text(
                "Select management-command output format",
                "选择管理命令输出格式",
            ),
        )
        .value_parser(["human", "json"]),
        switch_arg(
            "tui",
            "tui",
            locale.text("Force the fullscreen terminal UI", "强制使用全屏终端界面"),
        )
        .conflicts_with("plain"),
        switch_arg(
            "plain",
            "plain",
            locale.text("Use the classic line-oriented terminal", "使用经典行式终端"),
        )
        .conflicts_with("tui"),
    ]
}

fn value_arg(id: &'static str, long: &'static str, value: &'static str, help: &'static str) -> Arg {
    Arg::new(id)
        .long(long)
        .global(true)
        .value_name(value)
        .help(help)
}

fn local_value_arg(
    id: &'static str,
    long: &'static str,
    value: &'static str,
    help: &'static str,
) -> Arg {
    Arg::new(id).long(long).value_name(value).help(help)
}

fn switch_arg(id: &'static str, long: &'static str, help: &'static str) -> Arg {
    Arg::new(id)
        .long(long)
        .global(true)
        .action(ArgAction::SetTrue)
        .help(help)
}

fn local_switch_arg(id: &'static str, long: &'static str, help: &'static str) -> Arg {
    Arg::new(id)
        .long(long)
        .action(ArgAction::SetTrue)
        .help(help)
}

fn prompt_arg(value_name: &'static str, minimum: usize, maximum: Option<usize>) -> Arg {
    let arg = Arg::new("prompt")
        .value_name(value_name)
        .required(minimum > 0);
    match maximum {
        Some(maximum) => arg.num_args(minimum..=maximum),
        None => arg.num_args(minimum..),
    }
}

fn output_examples(locale: Locale, command: Command, examples: &'static str) -> Command {
    if locale.is_chinese() {
        command.after_help(examples.replacen("Examples:", "示例：", 1).replacen(
            "Example:",
            "示例：",
            1,
        ))
    } else {
        command.after_help(examples)
    }
}

fn exec_command(locale: Locale) -> Command {
    output_examples(
        locale,
        Command::new("exec")
            .about(locale.text(
                "Run one prompt and print the final reply",
                "执行一次提示并输出最终回复",
            ))
            .arg(prompt_arg("PROMPT", 1, None).help(locale.text(
                "Prompt to send to the Agent",
                "要发送给代理的提示",
            ))),
        "Examples:\n  morphz exec explain this repository\n  morphz exec -- --text-that-starts-with-a-dash",
    )
}

fn resume_command(name: &'static str, locale: Locale) -> Command {
    output_examples(
        locale,
        Command::new(name)
            .about(locale.text(
                "Reattach an existing or recently active Session",
                "重新连接现有或最近活跃的会话",
            ))
            .long_about(locale.text(
                "Reattach a Session without changing its identity. With no ID, resumes the most recently active matching Session.",
                "在不改变会话身份的前提下重新连接。不指定标识时，默认继续最近活跃的匹配会话。",
            ))
            .arg(local_switch_arg(
                "last",
                "last",
                locale.text(
                    "Resume the most recently active matching Session",
                    "继续最近活跃的匹配会话",
                ),
            ))
            .arg(
                prompt_arg("[SESSION] [PROMPT]", 0, None)
                    .help(locale.text(
                        "Optional Session ID followed by an optional prompt",
                        "可选的会话标识，之后可跟可选提示",
                    )),
            ),
        "Examples:\n  morphz resume\n  morphz resume session_123\n  morphz resume session_123 continue the task\n  morphz resume --context=context-default",
    )
}

fn serve_command(locale: Locale) -> Command {
    output_examples(
        locale,
        Command::new("serve")
            .about(locale.text(
                "Start the HTTP/WebSocket runtime and embedded Dashboard",
                "启动网络运行时和内置控制台",
            ))
            .long_about(locale.text(
                "Start the HTTP/WebSocket runtime and embedded Dashboard. Loopback addresses may run without Dashboard authentication; non-loopback addresses require MORPHZ_DASHBOARD_TOKEN.",
                "启动 HTTP/WebSocket 运行时和内置控制台。环回地址可以不启用控制台认证；非环回地址需要 MORPHZ_DASHBOARD_TOKEN。",
            ))
            .arg(local_value_arg(
                "bind",
                "bind",
                "ADDR",
                locale.text("Listen address", "监听地址"),
            )),
        "Examples:\n  morphz serve\n  morphz serve --bind=127.0.0.1:9090\n  MORPHZ_DASHBOARD_TOKEN=replace-with-a-secret morphz serve --bind=0.0.0.0:8080",
    )
}

fn dashboard_command(locale: Locale) -> Command {
    output_examples(
        locale,
        Command::new("dashboard")
            .about(locale.text(
                "Start the Dashboard and open it in the default browser",
                "启动控制台并在默认浏览器中打开",
            ))
            .long_about(locale.text(
                "Start the embedded Dashboard with a cryptographically random temporary authentication token and open its local URL in the default browser.",
                "使用密码学安全的随机临时认证令牌启动内置控制台，并在默认浏览器中打开本地地址。",
            ))
            .arg(local_value_arg(
                "bind",
                "bind",
                "ADDR",
                locale.text("Listen address", "监听地址"),
            )),
        "Examples:\n  morphz dashboard\n  morphz dashboard --bind=0.0.0.0:8080",
    )
}

fn provider_command(locale: Locale) -> Command {
    Command::new("provider")
        .about(locale.text("Inspect and verify model providers", "检查并验证模型服务商"))
        .subcommands([
            output_examples(
                locale,
                Command::new("list").about(locale.text(
                    "List catalog and configured providers",
                    "列出目录和已配置的模型服务商",
                )),
                "Example:\n  morphz provider list --format=json",
            ),
            output_examples(
                locale,
                Command::new("test")
                    .about(locale.text(
                        "Verify a provider catalog, stream and tool call",
                        "验证模型服务商的目录、流式响应和工具调用",
                    ))
                    .arg(
                        prompt_arg("PROVIDER", 0, Some(1))
                            .help(locale.text("Provider ID to test", "要测试的模型服务商标识")),
                    ),
                "Examples:\n  morphz provider test\n  morphz provider test anthropic",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz provider <COMMAND> --help` for command-specific help.",
            "运行 `morphz provider <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn model_command(locale: Locale) -> Command {
    Command::new("model")
        .about(locale.text("Discover or select models", "发现或选择模型"))
        .subcommands([
            output_examples(
                locale,
                Command::new("list").about(locale.text(
                    "List models exposed by a provider",
                    "列出模型服务商提供的模型",
                )),
                "Examples:\n  morphz model list\n  morphz model list --provider=anthropic",
            ),
            output_examples(
                locale,
                Command::new("use")
                    .about(locale.text(
                        "Persist the default provider and model",
                        "保存默认模型服务商和模型",
                    ))
                    .arg(prompt_arg("[PROVIDER/]MODEL", 1, Some(1)).help(locale.text(
                        "Model selection",
                        "模型选择",
                    ))),
                "Examples:\n  morphz model use claude-sonnet\n  morphz model use anthropic/claude-sonnet",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz model <COMMAND> --help` for command-specific help.",
            "运行 `morphz model <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn profile_command(locale: Locale) -> Command {
    Command::new("profile")
        .about(locale.text(
            "Inspect or select configuration profiles",
            "检查或选择配置方案",
        ))
        .subcommands([
            output_examples(
                locale,
                Command::new("list")
                    .about(locale.text("List available profiles", "列出可用的配置方案")),
                "Example:\n  morphz profile list --format=json",
            ),
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text(
                        "Show the resolved contents of a profile",
                        "显示配置方案的解析结果",
                    ))
                    .arg(
                        prompt_arg("NAME", 1, Some(1))
                            .help(locale.text("Profile name", "配置方案名称")),
                    ),
                "Example:\n  morphz profile show work",
            ),
            output_examples(
                locale,
                Command::new("use")
                    .about(locale.text("Select the default profile", "选择默认配置方案"))
                    .arg(
                        prompt_arg("NAME", 1, Some(1))
                            .help(locale.text("Profile name", "配置方案名称")),
                    ),
                "Example:\n  morphz profile use work",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz profile <COMMAND> --help` for command-specific help.",
            "运行 `morphz profile <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn context_command(locale: Locale) -> Command {
    Command::new("context")
        .about(locale.text(
            "Inspect persistent Cognitive Contexts",
            "检查持久认知上下文",
        ))
        .subcommands([
            output_examples(
                locale,
                Command::new("list")
                    .about(locale.text("List Cognitive Contexts", "列出认知上下文"))
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        locale.text("Include archived Contexts", "包含已归档的上下文"),
                    )),
                "Example:\n  morphz context list --format=json",
            ),
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text("Show one Cognitive Context", "显示一个认知上下文"))
                    .arg(prompt_arg("ID", 0, Some(1)).help(locale.text(
                        "Context ID; defaults to --context",
                        "上下文标识；默认使用 --context",
                    ))),
                "Example:\n  morphz context show context-default",
            ),
            output_examples(
                locale,
                Command::new("status")
                    .about(locale.text(
                        "Show Context state, Sessions and active work",
                        "显示上下文状态、会话和活跃工作",
                    ))
                    .arg(prompt_arg("ID", 0, Some(1)).help(locale.text(
                        "Context ID; defaults to --context",
                        "上下文标识；默认使用 --context",
                    ))),
                "Example:\n  morphz context status context-default",
            ),
            output_examples(
                locale,
                Command::new("audit")
                    .about(locale.text(
                        "Verify the Context Mind projection against its ledger",
                        "对照账本验证上下文的认知投影",
                    ))
                    .arg(prompt_arg("ID", 0, Some(1)).help(locale.text(
                        "Context ID; defaults to --context",
                        "上下文标识；默认使用 --context",
                    ))),
                "Example:\n  morphz context audit context-default",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz context <COMMAND> --help` for command-specific help.",
            "运行 `morphz context <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn scheduler_command(locale: Locale) -> Command {
    Command::new("scheduler")
        .about(locale.text(
            "Inspect authoritative Scheduler state",
            "检查权威调度器状态",
        ))
        .subcommand(output_examples(
            locale,
            Command::new("show")
                .about(locale.text(
                    "Show Threads, activations, jobs, approvals and schedules",
                    "显示线程、求值、作业、审批和调度计划",
                ))
                .arg(local_switch_arg(
                    "include-terminal",
                    "include-terminal",
                    locale.text(
                        "Include terminal Scheduler records",
                        "包含已终止的调度器记录",
                    ),
                ))
                .arg(
                    local_value_arg(
                        "limit",
                        "limit",
                        "N",
                        locale.text("Limit Scheduler history", "限制调度器历史数量"),
                    )
                        .value_parser(StringValueParser::new().try_map(move |value| {
                            value
                                .parse::<usize>()
                                .ok()
                                .filter(|value| (1..=2_000).contains(value))
                                .map(|_| value.clone())
                                .ok_or_else(|| {
                                    locale
                                        .text(
                                            "must be an integer in 1..=2000",
                                            "必须是 1 到 2000 之间的整数",
                                        )
                                        .to_string()
                                })
                        })),
                ),
            "Example:\n  morphz scheduler show --context=context-default --include-terminal --limit=50",
        ))
        .after_help(locale.text(
            "Run `morphz scheduler show --help` for command-specific help.",
            "运行 `morphz scheduler show --help` 查看具体命令的帮助。",
        ))
}

fn session_command(locale: Locale) -> Command {
    Command::new("session")
        .about(locale.text(
            "Manage Session identities and Context mounts",
            "管理会话身份和上下文挂载",
        ))
        .subcommands([
            output_examples(
                locale,
                Command::new("list")
                    .about(locale.text("List Sessions", "列出会话"))
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        locale.text(
                            "Include archived Sessions",
                            "包含已归档的会话",
                        ),
                    )),
                "Examples:\n  morphz session list\n  morphz session list --context=context-default --format=json",
            ),
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text("Show one Session", "显示一个会话"))
                    .arg(prompt_arg("ID", 0, Some(1)).help(locale.text(
                        "Session ID; may also use --session",
                        "会话标识；也可使用 --session",
                    ))),
                "Example:\n  morphz session show session_123",
            ),
            output_examples(
                locale,
                Command::new("create")
                    .about(locale.text(
                        "Create a Session mounted in a selected Context",
                        "创建挂载到指定上下文的会话",
                    ))
                    .arg(local_value_arg(
                        "id",
                        "id",
                        "ID",
                        locale.text("Use an explicit Session ID", "使用指定的会话标识"),
                    ))
                    .arg(local_value_arg(
                        "title",
                        "title",
                        "TEXT",
                        locale.text("Set the Session title", "设置会话标题"),
                    ))
                    .arg(local_switch_arg(
                        "independent",
                        "independent",
                        locale.text(
                            "Create an independent Context seeded from the selected Mind",
                            "使用所选认知创建独立上下文",
                        ),
                    )),
                "Examples:\n  morphz session create --title='Release work'\n  morphz session create --context=context-default --independent",
            ),
            resume_command("resume", locale),
        ])
        .after_help(locale.text(
            "Run `morphz session <COMMAND> --help` for command-specific help.",
            "运行 `morphz session <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn agent_command(locale: Locale) -> Command {
    Command::new("agent")
        .about(locale.text("Manage persistent Agents", "管理持久代理"))
        .subcommands([
            output_examples(
                locale,
                Command::new("list")
                    .about(locale.text("List Agents", "列出代理"))
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        locale.text("Include archived Agents", "包含已归档的代理"),
                    )),
                "Example:\n  morphz agent list --format=json",
            ),
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text("Show one Agent", "显示一个代理"))
                    .arg(prompt_arg("ID", 0, Some(1)).help(locale.text(
                        "Agent ID; defaults to --agent",
                        "代理标识；默认使用 --agent",
                    ))),
                "Example:\n  morphz agent show default-agent",
            ),
            output_examples(
                locale,
                Command::new("create")
                    .about(locale.text(
                        "Create an Agent with a Root Context and initial Session",
                        "创建带根上下文和初始会话的代理",
                    ))
                    .arg(local_value_arg(
                        "id",
                        "id",
                        "ID",
                        locale.text("Use an explicit Agent ID", "使用指定的代理标识"),
                    ))
                    .arg(local_value_arg(
                        "title",
                        "title",
                        "TEXT",
                        locale.text("Set the Agent title", "设置代理标题"),
                    )),
                "Example:\n  morphz agent create --id=reviewer --title='Review Agent'",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz agent <COMMAND> --help` for command-specific help.",
            "运行 `morphz agent <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn objective_command(locale: Locale) -> Command {
    Command::new("objective")
        .about(locale.text("Manage long-lived Objectives", "管理长期目标"))
        .subcommands([
            output_examples(
                locale,
                Command::new("list")
                    .about(locale.text("List Objectives in a Context", "列出上下文中的目标"))
                    .arg(local_switch_arg(
                        "include-terminal",
                        "include-terminal",
                        locale.text(
                            "Include completed and cancelled Objectives",
                            "包含已完成和已取消的目标",
                        ),
                    )),
                "Example:\n  morphz objective list --context=context-default",
            ),
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text("Show one Objective", "显示一个目标"))
                    .arg(
                        prompt_arg("ID", 1, Some(1)).help(locale.text("Objective ID", "目标标识")),
                    ),
                "Example:\n  morphz objective show objective_123",
            ),
            output_examples(
                locale,
                Command::new("create")
                    .about(locale.text(
                        "Create and run a long-lived Objective",
                        "创建并运行长期目标",
                    ))
                    .arg(local_value_arg(
                        "id",
                        "id",
                        "ID",
                        locale.text("Use an explicit Objective ID", "使用指定的目标标识"),
                    ))
                    .arg(
                        local_value_arg(
                            "token-budget",
                            "token-budget",
                            "N",
                            locale.text(
                                "Set a positive Objective token budget",
                                "设置正数目标词元预算",
                            ),
                        )
                        .value_parser(StringValueParser::new().try_map(
                            move |value| {
                                value
                                    .parse::<u64>()
                                    .ok()
                                    .filter(|value| *value > 0)
                                    .map(|_| value.clone())
                                    .ok_or_else(|| {
                                        locale
                                            .text("must be a positive integer", "必须是正整数")
                                            .to_string()
                                    })
                            },
                        )),
                    )
                    .arg(
                        prompt_arg("GOAL", 1, None).help(locale.text("Objective goal", "目标内容")),
                    ),
                "Example:\n  morphz objective create --token-budget=256000 build a news system",
            ),
            output_examples(
                locale,
                Command::new("edit")
                    .about(locale.text(
                        "Replace an Objective goal using revision fencing",
                        "使用修订隔离替换目标内容",
                    ))
                    .arg(prompt_arg("ID NEW_GOAL", 2, None).help(locale.text(
                        "Objective ID and replacement goal",
                        "目标标识和替换后的目标内容",
                    ))),
                "Example:\n  morphz objective edit objective_123 narrow the release scope",
            ),
            objective_lifecycle_command("pause", "Pause an Objective", locale),
            objective_lifecycle_command("resume", "Resume an Objective", locale),
            objective_lifecycle_command("cancel", "Cancel an Objective", locale),
        ])
        .after_help(locale.text(
            "Run `morphz objective <COMMAND> --help` for command-specific help.",
            "运行 `morphz objective <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn objective_lifecycle_command(name: &'static str, about: &'static str, locale: Locale) -> Command {
    let about = if locale.is_chinese() {
        match name {
            "pause" => "暂停目标",
            "resume" => "继续目标",
            _ => "取消目标",
        }
    } else {
        about
    };
    output_examples(
        locale,
        Command::new(name)
            .about(about)
            .arg(local_value_arg(
                "reason",
                "reason",
                "TEXT",
                locale.text(
                    "Record an auditable lifecycle reason",
                    "记录可审计的生命周期原因",
                ),
            ))
            .arg(
                prompt_arg("ID [REASON]", 1, None)
                    .help(locale.text("Objective ID and optional reason", "目标标识和可选原因")),
            ),
        match name {
            "pause" => {
                "Example:\n  morphz objective pause objective_123 --reason='Waiting for input'"
            }
            "resume" => "Example:\n  morphz objective resume objective_123",
            _ => "Example:\n  morphz objective cancel objective_123 --reason='No longer needed'",
        },
    )
}

fn job_command(locale: Locale) -> Command {
    Command::new("job")
        .about(locale.text(
            "Inspect or cancel delegated Sub Agent jobs",
            "检查或取消子代理委派",
        ))
        .subcommands([
            output_examples(
                locale,
                Command::new("list").about(locale.text("List delegated jobs", "列出子代理委派")),
                "Example:\n  morphz job list --format=json",
            ),
            output_examples(
                locale,
                Command::new("cancel")
                    .about(locale.text(
                        "Cancel a delegated job and its descendants",
                        "取消子代理委派及其后代",
                    ))
                    .arg(
                        prompt_arg("ID", 1, Some(1))
                            .help(locale.text("Delegation job ID", "委派标识")),
                    ),
                "Example:\n  morphz job cancel delegation_123",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz job <COMMAND> --help` for command-specific help.",
            "运行 `morphz job <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn config_command(locale: Locale) -> Command {
    Command::new("config")
        .about(locale.text(
            "Inspect resolved configuration and provenance",
            "检查解析后的配置及其来源",
        ))
        .subcommands([
            output_examples(
                locale,
                Command::new("show")
                    .about(locale.text("Print the resolved configuration", "输出解析后的配置")),
                "Example:\n  morphz config show",
            ),
            output_examples(
                locale,
                Command::new("check").about(locale.text(
                    "Validate all loaded configuration layers",
                    "验证所有已加载的配置层",
                )),
                "Example:\n  morphz config check",
            ),
            output_examples(
                locale,
                Command::new("path").about(locale.text(
                    "List loaded configuration files in precedence order",
                    "按优先级列出已加载的配置文件",
                )),
                "Example:\n  morphz config path",
            ),
            output_examples(
                locale,
                Command::new("explain").about(locale.text(
                    "Explain the source of every resolved value",
                    "说明每个解析值的来源",
                )),
                "Example:\n  morphz config explain --format=json",
            ),
        ])
        .after_help(locale.text(
            "Run `morphz config <COMMAND> --help` for command-specific help.",
            "运行 `morphz config <COMMAND> --help` 查看具体命令的帮助。",
        ))
}

fn command_path(matches: &ArgMatches) -> Vec<String> {
    let mut path = Vec::new();
    let mut current = matches;
    while let Some((name, child)) = current.subcommand() {
        path.push(name.to_string());
        current = child;
    }
    path
}

fn matched_prompt(matches: &ArgMatches) -> Vec<String> {
    if let Some((_, child)) = matches.subcommand() {
        return matched_prompt(child);
    }
    matches
        .try_get_many::<String>("prompt")
        .ok()
        .flatten()
        .map(|values| values.cloned().collect())
        .unwrap_or_default()
}

fn matched_values(matches: &ArgMatches, name: &str) -> Option<Vec<String>> {
    if let Ok(Some(values)) = matches.try_get_many::<String>(name) {
        return Some(values.cloned().collect());
    }
    matches
        .subcommand()
        .and_then(|(_, child)| matched_values(child, name))
}

fn matched_switch(matches: &ArgMatches, name: &str) -> bool {
    if matches
        .try_get_one::<bool>(name)
        .ok()
        .flatten()
        .copied()
        .unwrap_or(false)
    {
        return true;
    }
    matches
        .subcommand()
        .is_some_and(|(_, child)| matched_switch(child, name))
}

fn nearest_command(typed: &str) -> Option<&'static str> {
    if !typed.is_ascii() || typed.len() < 3 {
        return None;
    }
    TOP_LEVEL_COMMANDS
        .iter()
        .copied()
        .filter(|candidate| *candidate != "help")
        .map(|candidate| (candidate, damerau_levenshtein(typed, candidate)))
        .filter(|(_, distance)| *distance == 1)
        .min_by_key(|(_, distance)| *distance)
        .map(|(candidate, _)| candidate)
}

fn damerau_levenshtein(left: &str, right: &str) -> usize {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut table = vec![vec![0; right.len() + 1]; left.len() + 1];
    for (index, row) in table.iter_mut().enumerate() {
        row[0] = index;
    }
    for (index, cell) in table[0].iter_mut().enumerate() {
        *cell = index;
    }
    for i in 1..=left.len() {
        for j in 1..=right.len() {
            let cost = usize::from(left[i - 1] != right[j - 1]);
            table[i][j] = (table[i - 1][j] + 1)
                .min(table[i][j - 1] + 1)
                .min(table[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && left[i - 1] == right[j - 2] && left[i - 2] == right[j - 1] {
                table[i][j] = table[i][j].min(table[i - 2][j - 2] + 1);
            }
        }
    }
    table[left.len()][right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Invocation {
        morphz_command_line_parser()
            .parse(args.iter().copied())
            .unwrap()
    }

    #[test]
    fn bare_text_is_a_root_agent_prompt() {
        let invocation = parse(&["帮我", "分析当前项目"]);
        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "帮我 分析当前项目");
    }

    #[test]
    fn command_words_inside_a_prompt_do_not_steal_the_route() {
        let invocation = parse(&["please", "review", "the", "session", "list"]);
        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "please review the session list");
    }

    #[test]
    fn ordinary_ascii_prompts_are_not_mistaken_for_help_typos() {
        let invocation = parse(&["hello", "world"]);
        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "hello world");
    }

    #[test]
    fn empty_invocation_opens_the_root_conversation() {
        let invocation = parse(&[]);
        assert!(invocation.command_path().is_empty());
        assert!(invocation.prompt_args().is_empty());
    }

    #[test]
    fn exact_command_names_select_the_structured_cli() {
        let invocation = parse(&["session", "list", "--format=json"]);
        assert_eq!(invocation.command_path(), ["session", "list"]);
        assert_eq!(
            invocation.option("format").unwrap().last_value(),
            Some("json")
        );
    }

    #[test]
    fn double_dash_forces_command_words_to_be_prompt_text() {
        let invocation = parse(&["--", "session", "list"]);
        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "session list");
    }

    #[test]
    fn global_options_work_before_or_after_subcommands() {
        let before = parse(&["--context=context-a", "session", "list"]);
        let after = parse(&["session", "list", "--context=context-a"]);
        assert_eq!(
            before.option("context").unwrap().last_value(),
            Some("context-a")
        );
        assert_eq!(
            after.option("context").unwrap().last_value(),
            Some("context-a")
        );
    }

    #[test]
    fn prompt_tail_keeps_dash_prefixed_text() {
        let invocation = parse(&["exec", "--", "explain", "--not-a-morphz-option"]);
        assert_eq!(invocation.command_path(), ["exec"]);
        assert_eq!(invocation.prompt(), "explain --not-a-morphz-option");
    }

    #[test]
    fn repeated_configuration_overrides_are_preserved() {
        let invocation = parse(&["--set=a=1", "--set=b=2", "hello"]);
        assert_eq!(
            invocation.option("set").unwrap().occurrences(),
            [Some("a=1".to_string()), Some("b=2".to_string())]
        );
    }

    #[test]
    fn incompatible_terminal_modes_fail_during_parsing() {
        let error = morphz_command_line_parser()
            .parse(["--tui", "--plain"])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::ArgumentConflict);
        assert!(error.to_string().contains("--tui"));
        assert!(error.to_string().contains("--plain"));
    }

    #[test]
    fn invalid_enumerated_values_show_the_allowed_values() {
        let error = morphz_command_line_parser()
            .parse(["--theme=purple"])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidValue);
        let rendered = error.to_string();
        assert!(rendered.contains("purple"));
        assert!(rendered.contains("coral"));
    }

    #[test]
    fn top_level_command_typos_receive_a_suggestion() {
        let error = morphz_command_line_parser()
            .parse(["sessoin", "list"])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
        assert!(error.to_string().contains("session"));
    }

    #[test]
    fn nested_command_typos_receive_claps_suggestion() {
        let error = morphz_command_line_parser()
            .parse(["session", "lits"])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidSubcommand);
        assert!(error.to_string().contains("list"));
    }

    #[test]
    fn every_registered_command_has_contextual_help() {
        for path in [
            &["exec"][..],
            &["session", "list"],
            &["session", "create"],
            &["objective", "create"],
            &["config", "explain"],
            &["completion"],
        ] {
            let mut args = path.to_vec();
            args.push("--help");
            let error = morphz_command_line_parser().parse(args).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::DisplayHelp, "path={path:?}");
            let rendered = error.to_string();
            assert!(rendered.contains("Usage:"), "path={path:?}\n{rendered}");
            assert!(rendered.contains("Example"), "path={path:?}\n{rendered}");
        }
    }

    #[test]
    fn the_complete_command_tree_renders_help_without_runtime_work() {
        fn collect_paths(command: &Command, prefix: &[String], output: &mut Vec<Vec<String>>) {
            for child in command.get_subcommands() {
                let mut path = prefix.to_vec();
                path.push(child.get_name().to_string());
                output.push(path.clone());
                collect_paths(child, &path, output);
            }
        }

        let command = morphz_command();
        let mut paths = Vec::new();
        collect_paths(&command, &[], &mut paths);
        assert!(
            paths.len() >= 40,
            "command tree unexpectedly shrank: {paths:?}"
        );

        for path in paths {
            let mut args = path.clone();
            args.push("--help".to_string());
            let error = morphz_command_line_parser().parse(args).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::DisplayHelp, "path={path:?}");
            let rendered = error.to_string();
            assert!(rendered.contains("Usage:"), "path={path:?}\n{rendered}");
            assert!(
                rendered
                    .lines()
                    .next()
                    .is_some_and(|line| !line.trim().is_empty()),
                "path={path:?}\n{rendered}"
            );
        }
    }

    #[test]
    fn objective_commands_preserve_free_form_goals_and_reasons() {
        let create = parse(&[
            "objective",
            "create",
            "--token-budget=256000",
            "实现",
            "一个",
            "新闻系统",
        ]);
        assert_eq!(create.command_path(), ["objective", "create"]);
        assert_eq!(create.prompt(), "实现 一个 新闻系统");

        let pause = parse(&[
            "objective",
            "pause",
            "objective-1",
            "--reason=等待用户确认范围",
        ]);
        assert_eq!(pause.command_path(), ["objective", "pause"]);
        assert_eq!(pause.prompt(), "objective-1");
        assert_eq!(
            pause.option("reason").unwrap().last_value(),
            Some("等待用户确认范围")
        );
    }

    #[test]
    fn help_is_generated_before_runtime_initialization() {
        let error = morphz_command_line_parser().parse(["--help"]).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        let rendered = error.to_string();
        assert!(rendered.contains("Text entered without a subcommand"));
        assert!(rendered.contains("session"));
        assert!(rendered.contains("objective"));
    }

    #[test]
    fn help_subcommand_renders_the_requested_command() {
        let error = morphz_command_line_parser()
            .parse(["help", "session", "create"])
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::DisplayHelp);
        let rendered = error.to_string();
        assert!(rendered.contains("Usage: morphz session create"));
        assert!(rendered.contains("--independent"));
    }

    #[test]
    fn language_option_selects_one_localized_help_catalog() {
        let invocation = morphz_command_line_parser()
            .parse(["--language=zh-CN", "hello"])
            .unwrap();
        assert_eq!(
            invocation.option("language").unwrap().last_value(),
            Some("zh-CN")
        );

        let error = morphz_command_line_parser_for(Locale::SimplifiedChinese)
            .parse(["--help"])
            .unwrap_err();
        let rendered = error.to_string();
        assert!(rendered.contains("具有持久上下文、会话、目标"));
        assert!(rendered.contains("用法："));
        assert!(rendered.contains("用户界面语言"));
        assert!(!rendered.contains("Agent runtime with Context-owned Sessions"));
        assert!(!rendered.contains("Usage:"));
    }
}
