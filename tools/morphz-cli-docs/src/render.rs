//! Deterministic public CLI reference generated from the same Clap command
//! tree used by the Morphz binary.

use crate::cli::{morphz_command_for, morphz_command_line_parser_for};
use crate::i18n::Locale;
use clap::Command;
use std::fmt::Write as _;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandEntry {
    path: Vec<String>,
    description: String,
}

fn command_description(command: &Command) -> String {
    command
        .get_about()
        .or_else(|| command.get_long_about())
        .map(ToString::to_string)
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn collect_command_entries(command: &Command, parent: &[String], output: &mut Vec<CommandEntry>) {
    for child in command.get_subcommands() {
        let mut path = parent.to_vec();
        path.push(child.get_name().to_string());
        output.push(CommandEntry {
            path: path.clone(),
            description: command_description(child),
        });
        collect_command_entries(child, &path, output);
    }
}

fn escape_table_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

fn render_help(locale: Locale, path: &[String]) -> String {
    let mut args = path.to_vec();
    args.push("--help".to_string());
    let help = morphz_command_line_parser_for(locale)
        .parse(args)
        .expect_err("--help must terminate Clap parsing")
        .to_string();
    help.trim()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Render one complete website document. The command index includes every
/// registered path; top-level help blocks retain the exact CLI wording and
/// options instead of maintaining a second handwritten reference schema.
pub fn render_cli_reference(locale: Locale) -> String {
    let command = morphz_command_for(locale);
    let mut entries = Vec::new();
    collect_command_entries(&command, &[], &mut entries);

    let (
        title,
        description,
        generated_notice,
        index_title,
        help_title,
        discovery_title,
        discovery_body,
    ) = if locale.is_chinese() {
        (
            "CLI 参考",
            "从 Morphz 当前 Clap Schema 自动生成的完整命令索引与顶层帮助。",
            "本页由 Morphz 当前 CLI Schema 自动生成。请不要直接编辑；运行生成命令刷新。",
            "命令索引",
            "顶层命令帮助",
            "查看更深层帮助",
            "每个子命令的参数仍以当前二进制为准。使用 `morphz help <COMMAND>` 或在任意命令路径后添加 `--help`。自动化应使用 `--format=json` 和稳定 ID，不要解析面向人的表格或翻译文本。",
        )
    } else {
        (
            "CLI reference",
            "Complete command index and top-level help generated from the current Morphz Clap schema.",
            "This page is generated from the current Morphz CLI schema. Do not edit it directly; run the generator to refresh it.",
            "Command index",
            "Top-level command help",
            "Discover deeper help",
            "The current binary remains authoritative for every nested flag. Use `morphz help <COMMAND>` or append `--help` to any command path. Automation should consume `--format=json` and stable IDs instead of parsing human tables or translated text.",
        )
    };

    let mut output = String::new();
    writeln!(output, "---").unwrap();
    writeln!(output, "title: {title}").unwrap();
    writeln!(output, "description: {description}").unwrap();
    writeln!(output, "section: reference").unwrap();
    writeln!(output, "order: 400").unwrap();
    writeln!(output, "status: current").unwrap();
    writeln!(output, "source: generated-cli-schema").unwrap();
    writeln!(output, "---\n").unwrap();
    writeln!(output, "> {generated_notice}\n").unwrap();
    writeln!(output, "## {index_title}\n").unwrap();
    writeln!(output, "| Command | Description |").unwrap();
    writeln!(output, "|---|---|").unwrap();
    for entry in &entries {
        let path = format!("morphz {}", entry.path.join(" "));
        writeln!(
            output,
            "| `{}` | {} |",
            escape_table_cell(&path),
            escape_table_cell(&entry.description)
        )
        .unwrap();
    }

    writeln!(output, "\n## {help_title}\n").unwrap();
    writeln!(output, "```text").unwrap();
    writeln!(output, "{}", render_help(locale, &[])).unwrap();
    writeln!(output, "```\n").unwrap();
    for entry in entries.iter().filter(|entry| entry.path.len() == 1) {
        let path = format!("morphz {}", entry.path.join(" "));
        writeln!(output, "### `{path}`\n").unwrap();
        if !entry.description.is_empty() {
            writeln!(output, "{}\n", entry.description).unwrap();
        }
        writeln!(output, "```text").unwrap();
        writeln!(output, "{}", render_help(locale, &entry.path)).unwrap();
        writeln!(output, "```\n").unwrap();
    }

    writeln!(output, "## {discovery_title}\n").unwrap();
    writeln!(output, "{discovery_body}").unwrap();
    output
}

pub fn write_cli_reference_files(content_root: &Path) -> std::io::Result<()> {
    for (directory, locale) in [("zh", Locale::SimplifiedChinese), ("en", Locale::English)] {
        let path = content_root.join(directory).join("cli-reference.md");
        std::fs::write(path, render_cli_reference(locale))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_reference_contains_every_registered_command_path() {
        for locale in [Locale::English, Locale::SimplifiedChinese] {
            let command = morphz_command_for(locale);
            let mut entries = Vec::new();
            collect_command_entries(&command, &[], &mut entries);
            let rendered = render_cli_reference(locale);
            assert!(entries.len() >= 40, "command tree unexpectedly shrank");
            for entry in entries {
                let path = format!("`morphz {}`", entry.path.join(" "));
                assert!(rendered.contains(&path), "missing {path}");
            }
        }
    }

    #[test]
    fn generated_reference_is_bilingual_and_deterministic() {
        let english = render_cli_reference(Locale::English);
        let chinese = render_cli_reference(Locale::SimplifiedChinese);
        assert_eq!(english, render_cli_reference(Locale::English));
        assert!(english.contains("## Command index"));
        assert!(english.contains("Usage:"));
        assert!(chinese.contains("## 命令索引"));
        assert!(chinese.contains("用法："));
        assert!(!chinese.contains("认知框架"));
    }
}
