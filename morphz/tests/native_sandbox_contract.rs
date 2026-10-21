#[cfg(target_os = "linux")]
mod linux {
    use morphz::sandbox::{
        BackendKind, EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest,
    };
    use std::process::Command;

    #[test]
    fn bubblewrap_enforces_the_public_execution_contract() {
        let sandbox = NativeSandbox::for_current_platform();
        let report = sandbox.report();
        assert_eq!(report.backend, BackendKind::LinuxNative);
        assert_eq!(
            report.status,
            EnforcementStatus::Enforced,
            "the Linux platform gate requires a usable Bubblewrap backend: {report:?}"
        );

        let temp = tempfile::TempDir::new().unwrap();
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside.txt");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join(".env"), "SECRET=value\n").unwrap();
        std::fs::write(
            workspace.join("check.rs"),
            "#[test]\nfn sandboxed_rust_toolchain_runs() { assert_eq!(2 + 2, 4); }\n",
        )
        .unwrap();

        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.network = NetworkPolicy::Deny;
        policy.deny_path(workspace.join(".env"));
        let request = ShellRequest {
            command: format!(
                "printf allowed > allowed.txt; \
                 if printf denied > '{}'; then exit 10; fi; \
                 test ! -s .env; \
                 rustc --edition=2021 --test check.rs -o check-bin; \
                 ./check-bin; \
                 python3 -c 'import socket; s=socket.socket(); s.settimeout(0.2); s.connect((\"1.1.1.1\", 53))' >/dev/null 2>&1 && exit 11 || true",
                outside.display()
            ),
            cwd: workspace.clone(),
            policy,
        };
        let prepared = sandbox.prepare_shell(&request).unwrap();
        assert_eq!(prepared.report.status, EnforcementStatus::Pending);
        assert!(prepared.startup_stdin.is_none());
        let mut child = Command::new(&prepared.program)
            .args(&prepared.arguments)
            .current_dir(&workspace)
            .spawn()
            .unwrap();
        prepared
            .startup_receipt
            .as_ref()
            .expect("private receipt")
            .wait()
            .unwrap();
        let status = child.wait().unwrap();
        assert!(status.success());
        assert_eq!(
            std::fs::read_to_string(workspace.join("allowed.txt")).unwrap(),
            "allowed"
        );
        assert!(!outside.exists());
        assert_eq!(
            std::fs::read_to_string(workspace.join(".env")).unwrap(),
            "SECRET=value\n"
        );
    }

    #[test]
    fn installed_service_denies_protected_files_created_after_exec_admission() {
        use std::io::Write;
        use std::process::Stdio;
        let directory = tempfile::TempDir::new().unwrap();
        let workspace = directory.path().join("work");
        std::fs::create_dir(&workspace).unwrap();
        let secret = workspace.join("future.env");
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.deny_path(&secret);
        let prepared = NativeSandbox::for_current_platform().prepare_shell(&ShellRequest {
            command: "read barrier; if cat future.env >/dev/null 2>&1; then exit 41; fi; printf ordinary > allowed; printf '%s' \"$MORPHZ_SANDBOX_ENV\"".into(),
            cwd: workspace.clone(), policy,
        }).unwrap();
        let mut child = Command::new(&prepared.program)
            .args(&prepared.arguments)
            .env("MORPHZ_SANDBOX_ENV", "preserved-after-admission")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        prepared.startup_receipt.as_ref().unwrap().wait().unwrap();
        assert!(
            !secret.exists(),
            "the barrier must precede protected-file creation"
        );
        std::fs::write(&secret, "late synthetic secret").unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"continue\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "launcher stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"preserved-after-admission");
        assert_eq!(
            std::fs::read_to_string(workspace.join("allowed")).unwrap(),
            "ordinary"
        );
        assert_eq!(
            std::fs::read_to_string(secret).unwrap(),
            "late synthetic secret"
        );
    }
}
