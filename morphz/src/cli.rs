//! Agent-oriented command-line routing.
//!
//! Unlike a conventional CLI parser, unknown positional text is not an error:
//! it is the prompt delivered to the Agent. Registered command paths still win
//! over a separated option value, while `--name=value` binds the value
//! explicitly. This makes invocations such as `morphz run fix the release flow`
//! natural without giving up structured commands and options.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OptionKind {
    /// A switch is present without a value, but may carry an explicit value in
    /// the `--switch=false` form.
    Switch,
    /// A value option accepts `--name value` or the unambiguous
    /// `--name=value` form.
    Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionSpec {
    name: String,
    aliases: Vec<String>,
    kind: OptionKind,
    required: bool,
}

impl OptionSpec {
    pub fn switch(
        name: impl Into<String>,
        aliases: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::new(name, aliases, OptionKind::Switch)
    }

    pub fn value(
        name: impl Into<String>,
        aliases: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::new(name, aliases, OptionKind::Value)
    }

    fn new(
        name: impl Into<String>,
        aliases: impl IntoIterator<Item = impl Into<String>>,
        kind: OptionKind,
    ) -> Self {
        Self {
            name: name.into(),
            aliases: aliases.into_iter().map(Into::into).collect(),
            kind,
            required: false,
        }
    }

    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn aliases(&self) -> &[String] {
        &self.aliases
    }

    pub fn kind(&self) -> OptionKind {
        self.kind
    }

    pub fn is_required(&self) -> bool {
        self.required
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOption {
    /// One entry per occurrence. `None` means a switch was written without an
    /// explicit value; `Some("")` means the user explicitly wrote an empty
    /// value such as `--name=`.
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

    /// Prompt tokens after command and option extraction.
    pub fn prompt_args(&self) -> &[String] {
        &self.prompt_args
    }

    /// Reconstructs the normal shell-argument representation of the prompt.
    /// The operating system has already removed shell quoting and redundant
    /// whitespace by the time argv reaches the process.
    pub fn prompt(&self) -> String {
        self.prompt_args.join(" ")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    InvalidCommandPath(String),
    DuplicateCommand(String),
    InvalidOptionName(String),
    InvalidOptionAlias(String),
    DuplicateOptionName(String),
    DuplicateOptionAlias(String),
    MissingOptionValue { option: String },
    MissingRequiredOption { option: String },
}

impl Display for CliError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidCommandPath(path) => write!(f, "invalid command path: {path:?}"),
            Self::DuplicateCommand(path) => write!(f, "command already registered: {path}"),
            Self::InvalidOptionName(name) => write!(f, "invalid option name: {name:?}"),
            Self::InvalidOptionAlias(alias) => write!(f, "invalid option alias: {alias:?}"),
            Self::DuplicateOptionName(name) => write!(f, "option already registered: {name}"),
            Self::DuplicateOptionAlias(alias) => {
                write!(f, "option alias already registered: {alias}")
            }
            Self::MissingOptionValue { option } => {
                write!(f, "option {option} requires a value")
            }
            Self::MissingRequiredOption { option } => {
                write!(f, "required option {option} was not provided")
            }
        }
    }
}

impl Error for CliError {}

/// A command grammar that keeps unclaimed arguments as an Agent prompt.
///
/// The empty command path is always available, so a bare invocation is a root
/// Agent prompt. Concrete commands and options can be registered later without
/// changing the routing algorithm.
#[derive(Debug, Clone)]
pub struct CommandLineParser {
    commands: BTreeSet<Vec<String>>,
    options: BTreeMap<String, OptionSpec>,
    aliases: BTreeMap<String, String>,
}

impl Default for CommandLineParser {
    fn default() -> Self {
        let mut commands = BTreeSet::new();
        commands.insert(Vec::new());
        Self {
            commands,
            options: BTreeMap::new(),
            aliases: BTreeMap::new(),
        }
    }
}

impl CommandLineParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_command<I, S>(&mut self, path: I) -> Result<(), CliError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let path = path.into_iter().map(Into::into).collect::<Vec<_>>();
        if path.is_empty()
            || path.iter().any(|part| {
                part.is_empty()
                    || part.trim() != part
                    || part.chars().any(char::is_whitespace)
                    || part.starts_with('-')
            })
        {
            return Err(CliError::InvalidCommandPath(path.join(" ")));
        }
        if !self.commands.insert(path.clone()) {
            return Err(CliError::DuplicateCommand(path.join(" ")));
        }
        Ok(())
    }

    pub fn add_option(&mut self, spec: OptionSpec) -> Result<(), CliError> {
        if spec.name.is_empty()
            || spec.name.trim() != spec.name
            || spec.name.starts_with('-')
            || spec.name.chars().any(char::is_whitespace)
        {
            return Err(CliError::InvalidOptionName(spec.name));
        }
        if self.options.contains_key(&spec.name) {
            return Err(CliError::DuplicateOptionName(spec.name));
        }
        if spec.aliases.is_empty() {
            return Err(CliError::InvalidOptionAlias(String::new()));
        }

        let mut local_aliases = BTreeSet::new();
        for alias in &spec.aliases {
            if alias == "--" || !is_option_token(alias) || alias.contains('=') {
                return Err(CliError::InvalidOptionAlias(alias.clone()));
            }
            if !local_aliases.insert(alias.clone()) || self.aliases.contains_key(alias) {
                return Err(CliError::DuplicateOptionAlias(alias.clone()));
            }
        }

        for alias in &spec.aliases {
            self.aliases.insert(alias.clone(), spec.name.clone());
        }
        self.options.insert(spec.name.clone(), spec);
        Ok(())
    }

    pub fn parse<I, S>(&self, args: I) -> Result<Invocation, CliError>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let args = args.into_iter().map(Into::into).collect::<Vec<_>>();
        let prompt_boundary = args.iter().position(|arg| arg == "--");
        let routable_end = prompt_boundary.unwrap_or(args.len());
        let route = self.route(&args[..routable_end]);
        let routed_args = args
            .iter()
            .take(routable_end)
            .cloned()
            .enumerate()
            .filter_map(|(index, arg)| (!route.command_indices.contains(&index)).then_some(arg))
            .collect::<Vec<_>>();
        let forced_prompt = prompt_boundary
            .map(|boundary| args[(boundary + 1)..].to_vec())
            .unwrap_or_default();

        let mut options: BTreeMap<String, ParsedOption> = BTreeMap::new();
        let mut prompt_args = Vec::new();
        let mut index = 0;
        while index < routed_args.len() {
            let token = &routed_args[index];
            let (alias, explicit_value) = split_option(token);
            let Some(canonical_name) = self.aliases.get(alias) else {
                prompt_args.push(token.clone());
                index += 1;
                continue;
            };
            let spec = self
                .options
                .get(canonical_name)
                .expect("option alias index must point to an option");

            let value = match (spec.kind, explicit_value) {
                (OptionKind::Switch, value) => value.map(str::to_owned),
                (OptionKind::Value, Some(value)) => Some(value.to_owned()),
                (OptionKind::Value, None) => {
                    let Some(next) = routed_args.get(index + 1) else {
                        return Err(CliError::MissingOptionValue {
                            option: alias.to_string(),
                        });
                    };
                    if is_option_token(next) {
                        return Err(CliError::MissingOptionValue {
                            option: alias.to_string(),
                        });
                    }
                    index += 1;
                    Some(next.clone())
                }
            };

            options
                .entry(canonical_name.clone())
                .or_insert_with(|| ParsedOption {
                    occurrences: Vec::new(),
                })
                .occurrences
                .push(value);
            index += 1;
        }

        for spec in self.options.values() {
            if spec.required && !options.contains_key(&spec.name) {
                return Err(CliError::MissingRequiredOption {
                    option: spec.aliases[0].clone(),
                });
            }
        }

        prompt_args.extend(forced_prompt);

        Ok(Invocation {
            command_path: route.command_path,
            options,
            prompt_args,
        })
    }

    fn route(&self, args: &[String]) -> Route {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        enum State {
            Command,
            CommandPrefix,
            OptionFlag,
            OptionArgument,
            Prompt,
        }

        let mut state = State::Command;
        let mut candidate_path = Vec::<String>::new();
        let mut candidate_indices = Vec::<usize>::new();
        let mut selected_path = Vec::<String>::new();
        let mut selected_indices = BTreeSet::<usize>::new();

        for (index, arg) in args.iter().enumerate() {
            match state {
                State::Command => {
                    if is_option_token(arg) {
                        state = State::OptionFlag;
                    } else if let Some(match_kind) = self.extend_command(&candidate_path, arg) {
                        candidate_path.push(arg.clone());
                        candidate_indices.push(index);
                        if match_kind.exact {
                            selected_path.clone_from(&candidate_path);
                            selected_indices = candidate_indices.iter().copied().collect();
                            state = State::Command;
                        } else {
                            state = State::CommandPrefix;
                        }
                    } else {
                        candidate_path.clone_from(&selected_path);
                        candidate_indices = selected_indices.iter().copied().collect();
                        state = State::Prompt;
                    }
                }
                State::CommandPrefix => {
                    if is_option_token(arg) {
                        state = State::OptionFlag;
                    } else if let Some(match_kind) = self.extend_command(&candidate_path, arg) {
                        candidate_path.push(arg.clone());
                        candidate_indices.push(index);
                        if match_kind.exact {
                            selected_path.clone_from(&candidate_path);
                            selected_indices = candidate_indices.iter().copied().collect();
                            state = State::Command;
                        }
                    } else {
                        candidate_path.clone_from(&selected_path);
                        candidate_indices = selected_indices.iter().copied().collect();
                        state = State::Prompt;
                    }
                }
                State::OptionFlag => {
                    if is_option_token(arg) {
                        continue;
                    }
                    if let Some(match_kind) = self.extend_command(&candidate_path, arg) {
                        candidate_path.push(arg.clone());
                        candidate_indices.push(index);
                        if match_kind.exact {
                            selected_path.clone_from(&candidate_path);
                            selected_indices = candidate_indices.iter().copied().collect();
                            state = State::Command;
                        } else {
                            state = State::CommandPrefix;
                        }
                    } else {
                        state = State::OptionArgument;
                    }
                }
                State::OptionArgument => {
                    if is_option_token(arg) {
                        state = State::OptionFlag;
                    } else if let Some(match_kind) = self.extend_command(&candidate_path, arg) {
                        candidate_path.push(arg.clone());
                        candidate_indices.push(index);
                        if match_kind.exact {
                            selected_path.clone_from(&candidate_path);
                            selected_indices = candidate_indices.iter().copied().collect();
                            state = State::Command;
                        } else {
                            state = State::CommandPrefix;
                        }
                    } else {
                        state = State::Prompt;
                    }
                }
                State::Prompt => {
                    if is_option_token(arg) {
                        candidate_path.clone_from(&selected_path);
                        candidate_indices = selected_indices.iter().copied().collect();
                        state = State::OptionFlag;
                    }
                }
            }
        }

        Route {
            command_path: selected_path,
            command_indices: selected_indices,
        }
    }

    fn extend_command(&self, path: &[String], next: &str) -> Option<CommandMatch> {
        let mut candidate = path.to_vec();
        candidate.push(next.to_string());
        let exact = self.commands.contains(&candidate);
        let prefix = self
            .commands
            .iter()
            .any(|command| command.len() > candidate.len() && command.starts_with(&candidate));
        (exact || prefix).then_some(CommandMatch { exact })
    }
}

#[derive(Debug)]
struct CommandMatch {
    exact: bool,
}

#[derive(Debug)]
struct Route {
    command_path: Vec<String>,
    command_indices: BTreeSet<usize>,
}

fn is_option_token(value: &str) -> bool {
    value.len() > 1 && value.starts_with('-')
}

fn split_option(value: &str) -> (&str, Option<&str>) {
    if !is_option_token(value) {
        return (value, None);
    }
    value
        .split_once('=')
        .map_or((value, None), |(key, value)| (key, Some(value)))
}

/// Builds the product-level Morphz CLI grammar without attaching command
/// behavior. Keeping registration separate from dispatch lets the Runtime add
/// commands gradually while all frontends share one deterministic parser.
pub fn morphz_command_line_parser() -> CommandLineParser {
    let mut parser = CommandLineParser::new();
    for path in [
        &["exec"][..],
        &["serve"],
        &["context"],
        &["context", "show"],
        &["context", "status"],
        &["context", "list"],
        &["session"],
        &["session", "list"],
        &["session", "show"],
        &["session", "create"],
        &["session", "resume"],
        &["agent"],
        &["agent", "list"],
        &["agent", "show"],
        &["agent", "create"],
        &["job"],
        &["job", "list"],
        &["job", "cancel"],
        &["config"],
        &["config", "show"],
        &["config", "check"],
        &["config", "path"],
        &["doctor"],
        &["completion"],
        &["version"],
        &["help"],
    ] {
        parser
            .add_command(path.iter().copied())
            .expect("built-in Morphz command paths must be valid and unique");
    }

    for spec in [
        OptionSpec::switch("help", ["--help", "-h"]),
        OptionSpec::switch("version", ["--version", "-V"]),
        OptionSpec::value("cwd", ["--cwd", "-C"]),
        OptionSpec::value("add-dir", ["--add-dir"]),
        OptionSpec::value("profile", ["--profile", "-p"]),
        OptionSpec::value("provider", ["--provider"]),
        OptionSpec::value("model", ["--model", "-m"]),
        OptionSpec::value("agent", ["--agent"]),
        OptionSpec::value("context", ["--context"]),
        OptionSpec::value("session", ["--session"]),
        OptionSpec::value("sandbox", ["--sandbox", "-s"]),
        OptionSpec::value("approval", ["--approval", "-a"]),
        OptionSpec::value("config-file", ["--config-file"]),
        OptionSpec::value("set", ["--set", "-c"]),
        OptionSpec::value("log-level", ["--log-level"]),
        OptionSpec::value("format", ["--format"]),
        OptionSpec::value("output", ["--output", "-o"]),
        OptionSpec::value("schema", ["--schema"]),
        OptionSpec::value("bind", ["--bind"]),
        OptionSpec::value("id", ["--id"]),
        OptionSpec::value("title", ["--title"]),
        OptionSpec::switch("independent", ["--independent"]),
        OptionSpec::switch("last", ["--last"]),
        OptionSpec::switch("include-archived", ["--include-archived"]),
        OptionSpec::switch("network", ["--network"]),
    ] {
        parser
            .add_option(spec)
            .expect("built-in Morphz options must be valid and unique");
    }
    parser
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> CommandLineParser {
        let mut parser = CommandLineParser::new();
        parser.add_command(["agent", "run"]).unwrap();
        parser.add_command(["admin"]).unwrap();
        parser.add_command(["admin", "user", "add"]).unwrap();
        parser.add_command(["production"]).unwrap();
        parser
            .add_option(OptionSpec::value("profile", ["--profile", "-p"]))
            .unwrap();
        parser
            .add_option(OptionSpec::value("count", ["--count", "-c"]).required())
            .unwrap();
        parser
            .add_option(OptionSpec::switch("verbose", ["--verbose", "-v"]))
            .unwrap();
        parser
    }

    #[test]
    fn bare_text_is_a_root_agent_prompt() {
        let parser = CommandLineParser::new();
        let invocation = parser.parse(["帮我", "分析当前项目"]).unwrap();

        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "帮我 分析当前项目");
    }

    #[test]
    fn longest_registered_command_is_removed_from_prompt() {
        let mut parser = CommandLineParser::new();
        parser.add_command(["agent"]).unwrap();
        parser.add_command(["agent", "run"]).unwrap();

        let invocation = parser
            .parse(["agent", "run", "继续优化坦克大战", "检查发布流程"])
            .unwrap();

        assert_eq!(invocation.command_path(), ["agent", "run"]);
        assert_eq!(invocation.prompt(), "继续优化坦克大战 检查发布流程");
    }

    #[test]
    fn registered_parent_consumes_unmatched_tail_as_prompt() {
        let mut parser = CommandLineParser::new();
        parser.add_command(["admin"]).unwrap();
        parser.add_command(["admin", "user", "add"]).unwrap();

        let invocation = parser.parse(["admin", "wrong", "tail"]).unwrap();

        assert_eq!(invocation.command_path(), ["admin"]);
        assert_eq!(invocation.prompt_args(), ["wrong", "tail"]);
    }

    #[test]
    fn incomplete_command_prefix_is_never_silently_dropped() {
        let mut parser = CommandLineParser::new();
        parser.add_command(["admin", "user", "add"]).unwrap();

        let invocation = parser.parse(["admin", "wrong", "tail"]).unwrap();

        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt_args(), ["admin", "wrong", "tail"]);
    }

    #[test]
    fn registered_command_wins_over_separated_option_value() {
        let invocation = parser()
            .parse(["--profile", "production", "--count=1", "deploy"])
            .unwrap_err();

        assert_eq!(
            invocation,
            CliError::MissingOptionValue {
                option: "--profile".to_string()
            }
        );
    }

    #[test]
    fn equals_disambiguates_option_value_from_registered_command() {
        let invocation = parser()
            .parse(["--profile=production", "--count=1", "deploy"])
            .unwrap();

        assert!(invocation.command_path().is_empty());
        assert_eq!(
            invocation.option("profile").unwrap().last_value(),
            Some("production")
        );
        assert_eq!(invocation.prompt(), "deploy");
    }

    #[test]
    fn options_can_be_interleaved_with_command_words() {
        let invocation = parser()
            .parse(["agent", "--verbose", "run", "--count=2", "fix", "it"])
            .unwrap();

        assert_eq!(invocation.command_path(), ["agent", "run"]);
        assert!(invocation.has_option("verbose"));
        assert_eq!(invocation.option("count").unwrap().last_value(), Some("2"));
        assert_eq!(invocation.prompt(), "fix it");
    }

    #[test]
    fn required_zero_false_and_empty_values_are_present() {
        let mut zero = parser();
        zero.add_option(OptionSpec::value("enabled", ["--enabled"]).required())
            .unwrap();

        let invocation = zero
            .parse(["--count=0", "--enabled=false", "--profile="])
            .unwrap();

        assert_eq!(invocation.option("count").unwrap().last_value(), Some("0"));
        assert_eq!(
            invocation.option("enabled").unwrap().last_value(),
            Some("false")
        );
        assert_eq!(invocation.option("profile").unwrap().last_value(), Some(""));
    }

    #[test]
    fn dash_leading_value_requires_equals_form() {
        let error = parser().parse(["--count", "-1"]).unwrap_err();
        assert_eq!(
            error,
            CliError::MissingOptionValue {
                option: "--count".to_string()
            }
        );

        let invocation = parser().parse(["--count=-1"]).unwrap();
        assert_eq!(invocation.option("count").unwrap().last_value(), Some("-1"));
    }

    #[test]
    fn unknown_options_are_prompt_text() {
        let invocation = parser()
            .parse(["--count=3", "explain", "--not-a-real-option"])
            .unwrap();

        assert_eq!(invocation.prompt(), "explain --not-a-real-option");
    }

    #[test]
    fn double_dash_forces_every_remaining_token_to_be_prompt_text() {
        let invocation = parser()
            .parse(["--count=3", "--", "production", "--profile=ignored", "-1"])
            .unwrap();

        assert!(invocation.command_path().is_empty());
        assert_eq!(
            invocation.prompt_args(),
            ["production", "--profile=ignored", "-1"]
        );
        assert!(!invocation.has_option("profile"));
    }

    #[test]
    fn repeated_options_preserve_all_occurrences() {
        let invocation = parser()
            .parse(["--count=1", "-c=2", "-v", "--verbose=false"])
            .unwrap();

        assert_eq!(
            invocation.option("count").unwrap().occurrences(),
            [Some("1".to_string()), Some("2".to_string())]
        );
        assert_eq!(
            invocation.option("verbose").unwrap().occurrences(),
            [None, Some("false".to_string())]
        );
    }

    #[test]
    fn missing_required_option_depends_on_presence_not_parsed_value() {
        let error = parser().parse(["hello"]).unwrap_err();

        assert_eq!(
            error,
            CliError::MissingRequiredOption {
                option: "--count".to_string()
            }
        );
    }

    #[test]
    fn duplicate_alias_is_rejected_when_building_schema() {
        let mut parser = CommandLineParser::new();
        parser
            .add_option(OptionSpec::switch("first", ["--same"]))
            .unwrap();

        let error = parser
            .add_option(OptionSpec::switch("second", ["--same"]))
            .unwrap_err();
        assert_eq!(error, CliError::DuplicateOptionAlias("--same".to_string()));
    }

    #[test]
    fn morphz_grammar_keeps_a_free_form_prompt_after_global_options() {
        let invocation = morphz_command_line_parser()
            .parse([
                "--profile=game",
                "--sandbox=workspace-write",
                "继续优化坦克大战",
                "并检查发布流程",
            ])
            .unwrap();

        assert!(invocation.command_path().is_empty());
        assert_eq!(invocation.prompt(), "继续优化坦克大战 并检查发布流程");
        assert_eq!(
            invocation.option("profile").unwrap().last_value(),
            Some("game")
        );
    }

    #[test]
    fn morphz_resume_is_session_scoped_instead_of_a_top_level_continue() {
        let parser = morphz_command_line_parser();
        let resume = parser
            .parse(["session", "resume", "--last", "继续刚才的发布任务"])
            .unwrap();
        assert_eq!(resume.command_path(), ["session", "resume"]);
        assert!(resume.has_option("last"));
        assert_eq!(resume.prompt(), "继续刚才的发布任务");

        let ordinary_prompt = parser.parse(["continue", "刚才的工作"]).unwrap();
        assert!(ordinary_prompt.command_path().is_empty());
        assert_eq!(ordinary_prompt.prompt(), "continue 刚才的工作");
    }
}
