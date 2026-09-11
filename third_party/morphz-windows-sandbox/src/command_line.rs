/// Quote a regular Windows argv element using CommandLineToArgvW/CRT rules.
pub fn quote_windows_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty()
        || arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"'));
    if !needs_quotes {
        return arg.to_string();
    }
    let mut quoted = String::with_capacity(arg.len() + 2);
    quoted.push('"');
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                if backslashes > 0 {
                    quoted.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                }
                quoted.push(ch);
            }
        }
    }
    if backslashes > 0 {
        quoted.push_str(&"\\".repeat(backslashes * 2));
    }
    quoted.push('"');
    quoted
}

/// Build the command line consumed by the selected Windows executable.
pub fn argv_to_command_line(argv: &[String]) -> String {
    if argv.len() >= 3 {
        let program = &argv[0];
        let leaf = program.rsplit(['\\', '/']).next().unwrap_or(program);
        let tail = argv.len() - 1;
        let switches = &argv[1..tail - 1];
        if (leaf.eq_ignore_ascii_case("cmd.exe") || leaf.eq_ignore_ascii_case("cmd"))
            && argv[tail - 1].eq_ignore_ascii_case("/c")
            && switches.iter().all(|arg| {
                ["/d", "/s", "/q"]
                    .iter()
                    .any(|switch| arg.eq_ignore_ascii_case(switch))
            })
        {
            // cmd's /C tail is a shell program, not one CRT argv element.
            // CRT escaping introduces literal backslashes before its quotes,
            // turning a nested PowerShell -Command into a quoted expression.
            // /S removes exactly this outer pair; the approved script is kept
            // byte-for-byte inside it. Normal executable arguments below still
            // use CRT escaping. Do not broaden the command's authority here.
            let mut prefix = argv[..tail]
                .iter()
                .map(|arg| quote_windows_arg(arg))
                .collect::<Vec<_>>();
            if !switches.iter().any(|arg| arg.eq_ignore_ascii_case("/s")) {
                prefix.insert(1, "/S".to_string());
            }
            return format!("{} \"{}\"", prefix.join(" "), argv[tail]);
        }
    }
    argv.iter()
        .map(|arg| quote_windows_arg(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{argv_to_command_line, quote_windows_arg};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn cmd_tail_preserves_nested_powershell_quotes() {
        let command = r#"powershell -NoProfile -Command "Write-Output 'MORPHZ_OK'""#;
        assert_eq!(
            argv_to_command_line(&args(&["cmd.exe", "/D", "/S", "/C", command])),
            format!("cmd.exe /D /S /C \"{command}\"")
        );
    }

    #[test]
    fn regular_program_args_keep_crt_escaping() {
        assert_eq!(
            argv_to_command_line(&args(&[
                "pwsh.exe",
                "-Command",
                "Write-Output \"hello world\""
            ])),
            "pwsh.exe -Command \"Write-Output \\\"hello world\\\"\""
        );
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(
            quote_windows_arg("C:\\has space\\"),
            "\"C:\\has space\\\\\""
        );
    }

    #[test]
    fn cmd_paths_and_builtins_keep_the_single_script_tail() {
        let command = r#""C:\Program Files\nodejs\node.exe" -e "console.log('a & b')""#;
        assert_eq!(
            argv_to_command_line(&args(&["cmd.exe", "/c", command])),
            format!("cmd.exe /S /c \"{command}\"")
        );
        assert_eq!(
            argv_to_command_line(&args(&[
                r"C:\Windows\System32\CMD.EXE",
                "/d",
                "/s",
                "/c",
                r#"type proof.txt > "receipt & spaces.txt""#
            ])),
            r#"C:\Windows\System32\CMD.EXE /d /s /c "type proof.txt > "receipt & spaces.txt"""#
        );
        // /C in an ordinary executable's arguments is not a shell contract.
        assert_eq!(
            argv_to_command_line(&args(&["not-cmd.exe", "/C", "echo \"hi\""])),
            "not-cmd.exe /C \"echo \\\"hi\\\"\""
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_cmd_preserves_scripts_and_relative_file_io() {
        use std::os::windows::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let bytes = b"MORPHZ_WINDOWS_QUOTED_COMMAND\r\n";
        std::fs::write(root.path().join("proof.txt"), bytes).unwrap();
        let cases = [
            (
                r#"powershell.exe -NoProfile -Command "Copy-Item -LiteralPath 'proof.txt' -Destination 'receipt-ps.txt'; Get-Content -LiteralPath 'receipt-ps.txt'""#,
                "receipt-ps.txt",
            ),
            (
                r#"cmd /c "type proof.txt > receipt-cmd.txt""#,
                "receipt-cmd.txt",
            ),
            (
                r#"type proof.txt > "receipt & spaces.txt""#,
                "receipt & spaces.txt",
            ),
        ];
        for (script, receipt) in cases {
            let line = argv_to_command_line(&args(&["cmd.exe", "/D", "/S", "/C", script]));
            let output = std::process::Command::new("cmd.exe")
                .raw_arg(line.strip_prefix("cmd.exe ").unwrap())
                .current_dir(root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{receipt}: stdout={} stderr={}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(std::fs::read(root.path().join(receipt)).unwrap(), bytes);
        }
    }
}
