//! Product-level command-line schema powered by Clap.
//!
//! Morphz keeps one intentionally unusual convenience: text entered directly
//! after `morphz` is an Agent prompt. Exact command names still select the
//! structured CLI, and `--` always forces the remaining text to be a prompt.
//! Everything below that boundary follows conventional Clap semantics.

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
    CommandLineParser {
        command: morphz_command(),
    }
}

/// Returns the canonical command schema for help, parsing and completions.
pub fn morphz_command() -> Command {
    Command::new("morphz")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Agent runtime with Context-owned Sessions")
        .long_about(
            "Morphz is an Agent runtime with persistent Context, Sessions, Objectives and a fullscreen terminal UI.\n\nText entered without a subcommand is sent directly to the Agent.",
        )
        .propagate_version(true)
        .next_line_help(true)
        .help_expected(true)
        .args(global_args())
        .arg(prompt_arg("PROMPT", 0, None).help("Send text directly to the Agent"))
        .subcommands([
            exec_command(),
            resume_command("resume"),
            serve_command(),
            dashboard_command(),
            Command::new("setup")
                .about("Configure a model provider interactively")
                .after_help("Example:\n  morphz setup"),
            provider_command(),
            model_command(),
            profile_command(),
            context_command(),
            scheduler_command(),
            session_command(),
            agent_command(),
            objective_command(),
            job_command(),
            config_command(),
            Command::new("doctor")
                .about("Check storage, workspace, permissions and provider setup")
                .after_help("Example:\n  morphz doctor"),
            Command::new("completion")
                .about("Generate shell completion definitions")
                .arg(
                    prompt_arg("SHELL", 1, Some(1))
                        .value_parser(["bash", "elvish", "fish", "powershell", "zsh"])
                        .help("Shell to generate completions for"),
                )
                .after_help("Example:\n  morphz completion zsh > ~/.zfunc/_morphz"),
            Command::new("version")
                .about("Print the Morphz version")
                .after_help("Example:\n  morphz version"),
        ])
        .after_help(
            "Examples:\n  morphz\n  morphz please help me fix this project\n  morphz -- session list\n  morphz session list --format=json\n  morphz resume --context=context-default",
        )
}

fn global_args() -> Vec<Arg> {
    vec![
        value_arg(
            "cwd",
            "cwd",
            "DIR",
            "Change working directory before loading configuration",
        )
        .short('C'),
        value_arg(
            "config-file",
            "config-file",
            "FILE",
            "Load an explicit trusted configuration file",
        ),
        value_arg(
            "profile",
            "profile",
            "NAME",
            "Load a named configuration profile",
        )
        .short('p'),
        value_arg(
            "provider",
            "provider",
            "ID",
            "Override the configured model provider",
        ),
        value_arg("model", "model", "MODEL", "Override the configured model").short('m'),
        value_arg(
            "reasoning-effort",
            "reasoning-effort",
            "LEVEL",
            "Set model reasoning effort",
        )
        .value_parser([
            "default", "auto", "none", "off", "low", "medium", "high", "max",
        ]),
        value_arg("agent", "agent", "ID", "Select an Agent"),
        value_arg(
            "context",
            "context",
            "ID",
            "Select or mount a Cognitive Context",
        ),
        value_arg("session", "session", "ID", "Reattach an existing Session"),
        value_arg("sandbox", "sandbox", "MODE", "Set the command sandbox mode")
            .short('s')
            .value_parser(["workspace-write", "full-access", "danger-full-access"]),
        value_arg("approval", "approval", "MODE", "Set the approval policy")
            .short('a')
            .value_parser(["human", "ask", "auto", "auto-review", "never", "deny"]),
        value_arg(
            "add-dir",
            "add-dir",
            "DIR",
            "Add a readable and writable directory",
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
            .help("Allow sandboxed commands to access the network"),
        value_arg(
            "set",
            "set",
            "KEY=VALUE",
            "Override one configuration value",
        )
        .short('c')
        .action(ArgAction::Append),
        value_arg(
            "log-level",
            "log-level",
            "FILTER",
            "Override the tracing filter",
        ),
        value_arg("theme", "theme", "THEME", "Select the TUI color theme")
            .value_parser(["system", "mono", "iris", "cyan", "coral", "no-color"]),
        value_arg(
            "format",
            "format",
            "FORMAT",
            "Select management-command output format",
        )
        .value_parser(["human", "json"]),
        switch_arg("tui", "tui", "Force the fullscreen terminal UI").conflicts_with("plain"),
        switch_arg("plain", "plain", "Use the classic line-oriented terminal")
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

fn output_examples(command: Command, examples: &'static str) -> Command {
    command.after_help(examples)
}

fn exec_command() -> Command {
    output_examples(
        Command::new("exec")
            .about("Run one prompt and print the final reply")
            .arg(prompt_arg("PROMPT", 1, None).help("Prompt to send to the Agent")),
        "Examples:\n  morphz exec explain this repository\n  morphz exec -- --text-that-starts-with-a-dash",
    )
}

fn resume_command(name: &'static str) -> Command {
    output_examples(
        Command::new(name)
            .about("Reattach an existing or recently active Session")
            .long_about(
                "Reattach a Session without changing its identity. With no ID, resumes the most recently active matching Session.",
            )
            .arg(local_switch_arg("last", "last", "Resume the most recently active matching Session"))
            .arg(
                prompt_arg("[SESSION] [PROMPT]", 0, None)
                    .help("Optional Session ID followed by an optional prompt"),
            ),
        "Examples:\n  morphz resume\n  morphz resume session_123\n  morphz resume session_123 continue the task\n  morphz resume --context=context-default",
    )
}

fn serve_command() -> Command {
    output_examples(
        Command::new("serve")
            .about("Start the HTTP/WebSocket runtime and embedded Dashboard")
            .long_about(
                "Start the HTTP/WebSocket runtime and embedded Dashboard. Loopback addresses may run without Dashboard authentication; non-loopback addresses require MORPHZ_DASHBOARD_TOKEN.",
            )
            .arg(local_value_arg("bind", "bind", "ADDR", "Listen address")),
        "Examples:\n  morphz serve\n  morphz serve --bind=127.0.0.1:9090\n  MORPHZ_DASHBOARD_TOKEN=replace-with-a-secret morphz serve --bind=0.0.0.0:8080",
    )
}

fn dashboard_command() -> Command {
    output_examples(
        Command::new("dashboard")
            .about("Start the Dashboard and open it in the default browser")
            .long_about(
                "Start the embedded Dashboard with a cryptographically random temporary authentication token and open its local URL in the default browser.",
            )
            .arg(local_value_arg("bind", "bind", "ADDR", "Listen address")),
        "Examples:\n  morphz dashboard\n  morphz dashboard --bind=0.0.0.0:8080",
    )
}

fn provider_command() -> Command {
    Command::new("provider")
        .about("Inspect and verify model providers")
        .subcommands([
            output_examples(
                Command::new("list").about("List catalog and configured providers"),
                "Example:\n  morphz provider list --format=json",
            ),
            output_examples(
                Command::new("test")
                    .about("Verify a provider catalog, stream and tool call")
                    .arg(prompt_arg("PROVIDER", 0, Some(1)).help("Provider ID to test")),
                "Examples:\n  morphz provider test\n  morphz provider test anthropic",
            ),
        ])
        .after_help("Run `morphz provider <COMMAND> --help` for command-specific help.")
}

fn model_command() -> Command {
    Command::new("model")
        .about("Discover or select models")
        .subcommands([
            output_examples(
                Command::new("list").about("List models exposed by a provider"),
                "Examples:\n  morphz model list\n  morphz model list --provider=anthropic",
            ),
            output_examples(
                Command::new("use")
                    .about("Persist the default provider and model")
                    .arg(prompt_arg("[PROVIDER/]MODEL", 1, Some(1)).help("Model selection")),
                "Examples:\n  morphz model use claude-sonnet\n  morphz model use anthropic/claude-sonnet",
            ),
        ])
        .after_help("Run `morphz model <COMMAND> --help` for command-specific help.")
}

fn profile_command() -> Command {
    Command::new("profile")
        .about("Inspect or select configuration profiles")
        .subcommands([
            output_examples(
                Command::new("list").about("List available profiles"),
                "Example:\n  morphz profile list --format=json",
            ),
            output_examples(
                Command::new("show")
                    .about("Show the resolved contents of a profile")
                    .arg(prompt_arg("NAME", 1, Some(1)).help("Profile name")),
                "Example:\n  morphz profile show work",
            ),
            output_examples(
                Command::new("use")
                    .about("Select the default profile")
                    .arg(prompt_arg("NAME", 1, Some(1)).help("Profile name")),
                "Example:\n  morphz profile use work",
            ),
        ])
        .after_help("Run `morphz profile <COMMAND> --help` for command-specific help.")
}

fn context_command() -> Command {
    Command::new("context")
        .about("Inspect persistent Cognitive Contexts")
        .subcommands([
            output_examples(
                Command::new("list")
                    .about("List Cognitive Contexts")
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        "Include archived Contexts",
                    )),
                "Example:\n  morphz context list --format=json",
            ),
            output_examples(
                Command::new("show")
                    .about("Show one Cognitive Context")
                    .arg(prompt_arg("ID", 0, Some(1)).help("Context ID; defaults to --context")),
                "Example:\n  morphz context show context-default",
            ),
            output_examples(
                Command::new("status")
                    .about("Show Context state, Sessions and active work")
                    .arg(prompt_arg("ID", 0, Some(1)).help("Context ID; defaults to --context")),
                "Example:\n  morphz context status context-default",
            ),
            output_examples(
                Command::new("audit")
                    .about("Verify the Context Mind projection against its ledger")
                    .arg(prompt_arg("ID", 0, Some(1)).help("Context ID; defaults to --context")),
                "Example:\n  morphz context audit context-default",
            ),
            Command::new("recall-index")
                .about("Inspect or rebuild the derived lexical Recall index")
                .subcommands([
                    output_examples(
                        Command::new("inspect")
                            .about("Show Recall index capability and document counts")
                            .arg(prompt_arg("ID", 0, Some(1)).help("Context ID; defaults to --context")),
                        "Example:\n  morphz context recall-index inspect context-default --format=json",
                    ),
                    output_examples(
                        Command::new("rebuild")
                            .about("Rebuild the derived Recall index from Ledger and Mind")
                            .arg(prompt_arg("ID", 0, Some(1)).help("Context ID; defaults to --context")),
                        "Example:\n  morphz context recall-index rebuild context-default --format=json",
                    ),
                ]),
            Command::new("recall")
                .about("Search Context memory or traverse one Frame lineage")
                .subcommands([
                    output_examples(
                        Command::new("search")
                            .about("Search indexed Event and Frame documents")
                            .arg(prompt_arg("QUERY", 1, None).help("Unicode lexical query"))
                            .arg(local_value_arg("limit", "limit", "N", "Maximum matches")),
                        "Example:\n  morphz context recall search 沙箱 权限 --limit=20 --format=json",
                    ),
                    output_examples(
                        Command::new("frame")
                            .about("Traverse Frame sources and relations")
                            .arg(prompt_arg("FRAME", 1, Some(1)).help("Frame ID"))
                            .arg(local_value_arg("depth", "depth", "N", "Traversal depth, 0..4"))
                            .arg(local_value_arg("direction", "direction", "DIRECTION", "ancestors, descendants or both"))
                            .arg(local_value_arg("max-nodes", "max-nodes", "N", "Maximum nodes, 1..128"))
                            .arg(local_value_arg("cursor", "cursor", "CURSOR", "Opaque continuation cursor"))
                            .arg(local_switch_arg("include-events", "include-events", "Include complete Event source bodies"))
                            .arg(local_switch_arg("no-bodies", "no-bodies", "Omit Frame bodies")),
                        "Example:\n  morphz context recall frame memory/sandbox --depth=2 --direction=ancestors --format=json",
                    ),
                ]),
        ])
        .after_help("Run `morphz context <COMMAND> --help` for command-specific help.")
}

fn scheduler_command() -> Command {
    Command::new("scheduler")
        .about("Inspect authoritative Scheduler state")
        .subcommand(output_examples(
            Command::new("show")
                .about("Show Threads, activations, jobs, approvals and schedules")
                .arg(local_switch_arg(
                    "include-terminal",
                    "include-terminal",
                    "Include terminal Scheduler records",
                ))
                .arg(
                    local_value_arg("limit", "limit", "N", "Limit Scheduler history")
                        .value_parser(StringValueParser::new().try_map(|value| {
                            value
                                .parse::<usize>()
                                .ok()
                                .filter(|value| (1..=2_000).contains(value))
                                .map(|_| value.clone())
                                .ok_or_else(|| "must be an integer in 1..=2000".to_string())
                        })),
                ),
            "Example:\n  morphz scheduler show --context=context-default --include-terminal --limit=50",
        ))
        .after_help("Run `morphz scheduler show --help` for command-specific help.")
}

fn session_command() -> Command {
    Command::new("session")
        .about("Manage Session identities and Context mounts")
        .subcommands([
            output_examples(
                Command::new("list")
                    .about("List Sessions")
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        "Include archived Sessions",
                    )),
                "Examples:\n  morphz session list\n  morphz session list --context=context-default --format=json",
            ),
            output_examples(
                Command::new("show")
                    .about("Show one Session")
                    .arg(prompt_arg("ID", 0, Some(1)).help("Session ID; may also use --session")),
                "Example:\n  morphz session show session_123",
            ),
            output_examples(
                Command::new("create")
                    .about("Create a Session mounted in a selected Context")
                    .arg(local_value_arg("id", "id", "ID", "Use an explicit Session ID"))
                    .arg(local_value_arg("title", "title", "TEXT", "Set the Session title"))
                    .arg(local_switch_arg(
                        "independent",
                        "independent",
                        "Create an independent Context seeded from the selected Mind",
                    )),
                "Examples:\n  morphz session create --title='Release work'\n  morphz session create --context=context-default --independent",
            ),
            resume_command("resume"),
        ])
        .after_help("Run `morphz session <COMMAND> --help` for command-specific help.")
}

fn agent_command() -> Command {
    Command::new("agent")
        .about("Manage persistent Agents")
        .subcommands([
            output_examples(
                Command::new("list")
                    .about("List Agents")
                    .arg(local_switch_arg(
                        "include-archived",
                        "include-archived",
                        "Include archived Agents",
                    )),
                "Example:\n  morphz agent list --format=json",
            ),
            output_examples(
                Command::new("show")
                    .about("Show one Agent")
                    .arg(prompt_arg("ID", 0, Some(1)).help("Agent ID; defaults to --agent")),
                "Example:\n  morphz agent show default-agent",
            ),
            output_examples(
                Command::new("create")
                    .about("Create an Agent with a Root Context and initial Session")
                    .arg(local_value_arg(
                        "id",
                        "id",
                        "ID",
                        "Use an explicit Agent ID",
                    ))
                    .arg(local_value_arg(
                        "title",
                        "title",
                        "TEXT",
                        "Set the Agent title",
                    )),
                "Example:\n  morphz agent create --id=reviewer --title='Review Agent'",
            ),
        ])
        .after_help("Run `morphz agent <COMMAND> --help` for command-specific help.")
}

fn objective_command() -> Command {
    Command::new("objective")
        .about("Manage long-lived Objectives")
        .subcommands([
            output_examples(
                Command::new("list")
                    .about("List Objectives in a Context")
                    .arg(local_switch_arg(
                        "include-terminal",
                        "include-terminal",
                        "Include completed and cancelled Objectives",
                    )),
                "Example:\n  morphz objective list --context=context-default",
            ),
            output_examples(
                Command::new("show")
                    .about("Show one Objective")
                    .arg(prompt_arg("ID", 1, Some(1)).help("Objective ID")),
                "Example:\n  morphz objective show objective_123",
            ),
            output_examples(
                Command::new("create")
                    .about("Create and run a long-lived Objective")
                    .arg(local_value_arg(
                        "id",
                        "id",
                        "ID",
                        "Use an explicit Objective ID",
                    ))
                    .arg(
                        local_value_arg(
                            "token-budget",
                            "token-budget",
                            "N",
                            "Set a positive Objective token budget",
                        )
                        .value_parser(StringValueParser::new().try_map(
                            |value| {
                                value
                                    .parse::<u64>()
                                    .ok()
                                    .filter(|value| *value > 0)
                                    .map(|_| value.clone())
                                    .ok_or_else(|| "must be a positive integer".to_string())
                            },
                        )),
                    )
                    .arg(prompt_arg("GOAL", 1, None).help("Objective goal")),
                "Example:\n  morphz objective create --token-budget=256000 build a news system",
            ),
            output_examples(
                Command::new("edit")
                    .about("Replace an Objective goal using revision fencing")
                    .arg(
                        prompt_arg("ID NEW_GOAL", 2, None)
                            .help("Objective ID and replacement goal"),
                    ),
                "Example:\n  morphz objective edit objective_123 narrow the release scope",
            ),
            objective_lifecycle_command("pause", "Pause an Objective"),
            objective_lifecycle_command("resume", "Resume an Objective"),
            objective_lifecycle_command("cancel", "Cancel an Objective"),
        ])
        .after_help("Run `morphz objective <COMMAND> --help` for command-specific help.")
}

fn objective_lifecycle_command(name: &'static str, about: &'static str) -> Command {
    output_examples(
        Command::new(name)
            .about(about)
            .arg(local_value_arg(
                "reason",
                "reason",
                "TEXT",
                "Record an auditable lifecycle reason",
            ))
            .arg(prompt_arg("ID [REASON]", 1, None).help("Objective ID and optional reason")),
        match name {
            "pause" => {
                "Example:\n  morphz objective pause objective_123 --reason='Waiting for input'"
            }
            "resume" => "Example:\n  morphz objective resume objective_123",
            _ => "Example:\n  morphz objective cancel objective_123 --reason='No longer needed'",
        },
    )
}

fn job_command() -> Command {
    Command::new("job")
        .about("Inspect or cancel delegated Sub Agent jobs")
        .subcommands([
            output_examples(
                Command::new("list").about("List delegated jobs"),
                "Example:\n  morphz job list --format=json",
            ),
            output_examples(
                Command::new("cancel")
                    .about("Cancel a delegated job and its descendants")
                    .arg(prompt_arg("ID", 1, Some(1)).help("Delegation job ID")),
                "Example:\n  morphz job cancel delegation_123",
            ),
        ])
        .after_help("Run `morphz job <COMMAND> --help` for command-specific help.")
}

fn config_command() -> Command {
    Command::new("config")
        .about("Inspect resolved configuration and provenance")
        .subcommands([
            output_examples(
                Command::new("show").about("Print the resolved configuration"),
                "Example:\n  morphz config show",
            ),
            output_examples(
                Command::new("check").about("Validate all loaded configuration layers"),
                "Example:\n  morphz config check",
            ),
            output_examples(
                Command::new("path").about("List loaded configuration files in precedence order"),
                "Example:\n  morphz config path",
            ),
            output_examples(
                Command::new("explain").about("Explain the source of every resolved value"),
                "Example:\n  morphz config explain --format=json",
            ),
        ])
        .after_help("Run `morphz config <COMMAND> --help` for command-specific help.")
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
}
