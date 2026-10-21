#[cfg(target_os = "linux")]
mod linux {
    use morphz::sandbox::{
        BackendKind, EnforcementStatus, NativeSandbox, NetworkPolicy, SandboxPolicy, ShellRequest,
    };
    use std::process::Command;

    #[test]
    fn namespace_handles_do_not_authorize_writes_or_namespace_transitions() {
        let fixture = std::env::var("MORPHZ_TEST_HOST_NETNS").ok();
        if std::env::var_os("MORPHZ_REQUIRE_LINUX_SANDBOX_ATTACK_TEST").is_some() {
            assert!(
                fixture.is_some(),
                "CI requires a real host namespace bind mount"
            );
        }
        let handle = fixture.as_deref().unwrap_or("/proc/self/ns/net");
        let directory = tempfile::tempdir().unwrap();
        let script = format!(
            r#"python3 - <<'PY'
import ctypes, errno, fcntl, os, stat
path = {}
original = os.readlink('/proc/self/ns/net')
fd = os.open(path, os.O_RDONLY)
assert fcntl.ioctl(fd, 0xb703) == 0x40000000
assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o444
if {}:
    assert os.fstat(fd).st_ino != os.stat('/proc/self/ns/net').st_ino
try:
    writable = os.open(path, os.O_WRONLY)
except OSError as failure:
    assert failure.errno in (errno.EPERM, errno.EACCES, errno.EROFS)
else:
    os.close(writable)
    raise AssertionError('namespace handle accepted writable access')
libc = ctypes.CDLL(None, use_errno=True)
assert libc.setns(fd, 0x40000000) == -1 and ctypes.get_errno() == errno.EPERM
assert libc.unshare(0x10000000) == -1 and ctypes.get_errno() == errno.EPERM
assert os.readlink('/proc/self/ns/net') == original
os.close(fd)
print('namespace-authority-preserved')
PY"#,
            serde_json::to_string(handle).unwrap(),
            if fixture.is_some() { "True" } else { "False" },
        );
        let prepared = NativeSandbox::for_current_platform()
            .prepare_shell(&ShellRequest {
                command: script,
                cwd: directory.path().to_path_buf(),
                policy: SandboxPolicy::workspace(directory.path()),
            })
            .unwrap();
        let child = Command::new(&prepared.program)
            .args(&prepared.arguments)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        prepared.startup_receipt.as_ref().unwrap().wait().unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"namespace-authority-preserved\n");
    }

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
                "set -eu; printf allowed > allowed.txt; \
                 if printf denied > '{}'; then exit 10; fi; \
                 if cat .env >/dev/null 2>&1; then exit 12; fi; \
                 rustc --edition=2021 --test check.rs -o check-bin; \
                 ./check-bin; \
                 if python3 -c 'import socket; s=socket.socket(); s.settimeout(0.2); s.connect((\"1.1.1.1\", 53))' >/dev/null 2>&1; then exit 11; fi",
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
    fn installed_service_preserves_exact_file_grants_without_opening_their_parent() {
        let directory = tempfile::TempDir::new().unwrap();
        let workspace = directory.path().join("work");
        std::fs::create_dir(&workspace).unwrap();
        let reference = directory.path().join("reference 中文.txt");
        let writable = directory.path().join("approved-output.txt");
        let sibling = directory.path().join("unapproved.txt");
        std::fs::write(&reference, "reference").unwrap();
        std::fs::write(&writable, "before").unwrap();
        std::fs::write(&sibling, "private sibling").unwrap();
        let mut policy = SandboxPolicy::workspace(&workspace);
        policy.read_roots.push(reference.clone());
        policy.write_roots.push(writable.clone());
        let prepared = NativeSandbox::for_current_platform()
            .prepare_shell(&ShellRequest {
                command: format!(
                    "set -eu; cat '{}'; printf after > '{}'; \
                     if printf bad > '{}'; then exit 41; fi; \
                     if cat '{}' >/dev/null 2>&1; then exit 42; fi; \
                     if printf bad > '{}'; then exit 43; fi",
                    reference.display(),
                    writable.display(),
                    reference.display(),
                    sibling.display(),
                    sibling.display()
                ),
                cwd: workspace,
                policy,
            })
            .unwrap();
        let child = Command::new(&prepared.program)
            .args(&prepared.arguments)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        prepared.startup_receipt.as_ref().unwrap().wait().unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"reference");
        assert_eq!(std::fs::read_to_string(reference).unwrap(), "reference");
        assert_eq!(std::fs::read_to_string(writable).unwrap(), "after");
        assert_eq!(std::fs::read_to_string(sibling).unwrap(), "private sibling");
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
