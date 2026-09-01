#[cfg(target_os = "linux")]
mod linux {
    use morphz::sandbox::{
        BackendKind, EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPathPattern,
        SandboxPolicy, ShellRequest,
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
        policy.deny_pattern(SandboxPathPattern::new(&workspace, "**/.env"));
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
        assert_eq!(prepared.report.status, EnforcementStatus::Enforced);
        assert!(prepared.startup_stdin.is_none());

        let status = Command::new(prepared.program)
            .args(prepared.arguments)
            .current_dir(&workspace)
            .status()
            .unwrap();

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
}
