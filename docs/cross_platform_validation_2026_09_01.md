# Morphz Cross-Platform Validation Baseline — 2026-09-01

## Status

The product source baseline is `e110f651` (`test(platform): make process lifecycle gates load independent`). The source tree was validated on three physical operating-system boundaries rather than through Docker emulation:

| Platform | Validation host | Architecture and toolchain | Complete library result | Attempt-loop result |
| --- | --- | --- | --- | --- |
| macOS 26.5.1 | Local macOS host | Apple Silicon (`arm64`), Rust 1.97.1 | 1,099 passed, 0 failed, 6 ignored | 76 passed, 0 failed |
| Ubuntu 26.04 | Local Ubuntu VM | ARM64, 4 GiB VM, Rust 1.97.1 | 1,087 passed, 0 failed, 6 ignored | 76 passed, 0 failed |
| Windows build 10.0.26200.7628 | Local Windows host | x86_64, 32 GiB, Rust 1.92.0 MSVC | 1,081 passed, 0 failed, 6 ignored | 76 passed, 0 failed |

The differing library totals are expected: each host compiles its native `cfg`-gated Sandbox, process, credential-store, and terminal implementations.

## Source identity

The remote validation directories are test copies rather than Git worktrees. Their participating source was matched to the baseline before the final runs. The following SHA-256 values were identical on macOS, Ubuntu, and Windows where applicable:

| File | SHA-256 |
| --- | --- |
| `Cargo.lock` | `d76ff48f7ff437686d690ba9918524ad2eb3d86e4c0063f194c98d834ba42525` |
| `morphz/src/sandbox.rs` | `fddd4e00e075a31ef9dbb7004c5f9ce3c11d1cc397b64784d7d62757c4f3faa8` |
| `morphz/src/tool.rs` | `8b7d7a477fb4e636308ef2daafeecf5630b98556edc6f04344b5a1cffc429aca` |
| `third_party/morphz-windows-sandbox/src/elevated/ipc_framed.rs` | `a63e977110a296248beb5ab8bf1c6306fcfb739b321c524e8177b4b92d89caa9` |

## Coverage matrix

| Surface | macOS | Ubuntu ARM64 | Windows x86_64 | Evidence |
| --- | --- | --- | --- | --- |
| Install and build | Pass | Pass | Pass | Public `morphz` and `morphz-edge` binaries built natively; Windows helper bundle built with Morphz-branded names |
| CLI | Pass | Pass | Pass | `--version`, contextual `--help`, target commands, and `morphz-edge` status/help smokes |
| Runtime and durable store | Pass | Pass | Pass | Complete library suites plus 76-test attempt-loop integration suite |
| Native Sandbox | Seatbelt pass | Bubblewrap pass | Restricted token, ACL, WFP, private desktop, and Job Object pass | Native attack/containment tests executed on each OS |
| Execution Target | Pass | Pass | Pass | Local target, Edge target, managed SSH serialization/credential isolation, cancellation, and background lifecycle tests |
| Background execution | Pass | Pass | Pass | Immediate managed receipt, output/terminal ownership, process-tree cancellation, and exactly-once wake tests |
| Dashboard backend contract | Pass | Pass | Pass | Embedded Dashboard/API tests are part of every complete library suite |
| Dashboard frontend | Pass | Platform-independent bundle | Platform-independent bundle | 185 tests, ESLint, TypeScript/Vite production build, committed embedded assets verified |
| Website | Pass | Platform-independent bundle | Platform-independent bundle | 13 tests, ESLint, production build |
| Optional ContextDB reference backend | Pass | Compile-gated | Compile-gated | 14 tests with `context-db` enabled |

## Reproduction commands

### macOS

Native Seatbelt tests must run outside another outer Seatbelt profile; macOS does not permit an already sandboxed process to apply a second application Sandbox profile.

```bash
cargo test -q -j 1 -p morphz --lib
cargo test -q -j 1 -p morphz --test attempt_loop
cargo test -p morphz sandbox::tests -- --nocapture
cargo test -p morphz tool::tests::exec_ -- --nocapture
cargo clippy -j 1 -p morphz --lib -- -D warnings
cargo fmt --all -- --check
git diff --check
```

### Ubuntu ARM64 with 4 GiB RAM

The Rust 1.97.1 toolchain already contains ARM64 LLD. Using it avoids GNU BFD's peak memory while retaining the complete library test binary; no extra system package or larger VM is required.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
morphz_rust_sysroot=$(rustc --print sysroot)
export PATH="$morphz_rust_sysroot/lib/rustlib/aarch64-unknown-linux-gnu/bin/gcc-ld:$PATH"
mkdir -p "$HOME/morphz-test-tmp"
ulimit -n 65535
export TMPDIR="$HOME/morphz-test-tmp"
export CARGO_BUILD_JOBS=1
export CARGO_PROFILE_TEST_DEBUG=0
export RUSTFLAGS="-C linker=gcc -C link-arg=-fuse-ld=lld"

cargo test -q -j 1 -p morphz --lib -- --test-threads=1
cargo test -q -j 1 -p morphz --test attempt_loop
cargo test -p morphz --test native_sandbox_contract -- --nocapture
cargo clippy -j 1 -p morphz --lib -- -D warnings
```

The dedicated Bubblewrap contract verifies workspace writes, outside-write denial, protected `.env` reads, network denial, and compiling/running Rust inside the Sandbox. Test temporary files should use the disk-backed `TMPDIR` above instead of Ubuntu's small `/tmp` tmpfs and may be deleted after the run; the Cargo `target` directory should be retained for incremental build speed.

### Windows

Run from an ordinary PowerShell or OpenSSH session with the complete Morphz Windows helper bundle beside the Rust test executable:

```powershell
cargo build -p morphz --bin morphz --bin morphz-edge --bin morphz-windows-sandbox-runner
cargo build -p morphz-windows-sandbox --bins
cargo test -q -j 1 -p morphz --lib
cargo test -q -j 1 -p morphz --test attempt_loop
$env:MORPHZ_RUN_WINDOWS_SANDBOX_ATTACK_TEST = "1"
cargo test -p morphz sandbox::windows::tests -- --nocapture --test-threads=1
cargo clippy -j 1 -p morphz --lib -- -D warnings
```

Public artifacts are named `morphz-windows-sandbox-runner.exe`, `morphz-windows-command-runner.exe`, and `morphz-windows-sandbox-setup.exe`. Codex is named only in upstream attribution and license material.

### Dashboard and website

```bash
cd dashboard
npm run lint
npm test
npm run build

cd ../website
npm run lint
npm test
```

## Findings closed during validation

1. Windows native execution now uses restricted tokens, filesystem ACLs, WFP network isolation, a private desktop, and Job Objects while preserving Morphz's own Session/Edge/background lifecycle contract.
2. Linux uses a real Bubblewrap mount/network/process boundary and fails closed when the backend is unavailable.
3. Public Windows helper names no longer suggest that Morphz is a Codex executable; upstream provenance remains auditable.
4. Explicit-background and kill lifecycle tests now assert semantic ordering and terminal convergence instead of assuming cold PowerShell startup under load is below five seconds or that Job Object exit observation is below 500 ms.
5. The low-memory Ubuntu full suite is reproducible with toolchain-provided LLD, a disk-backed temporary directory, one compile job, and a raised file-descriptor limit.
6. One macOS attempt-loop run experienced a loaded-runner timing miss. The exact test passed three consecutive isolated runs and the unchanged full suite then passed 76/76; no product defect was reproduced.
7. Running native macOS boundary tests inside the Codex workspace Sandbox predictably produced `Operation not permitted` for loopback listeners and nested Seatbelt. Running the same unchanged tests at the physical OS boundary passed the complete suite.

## Workspace hygiene

- The main worktree and every retained worktree were clean at validation time.
- Three obsolete temporary deployment/CI worktrees were removed only after their differences were preserved as named Git stashes; already-integrated product changes were verified against main first.
- A separately authored, incomplete ContextDB shared-transaction change discovered during the final audit was preserved as `wip/contextdb-shared-runtime-transaction-discovered-during-platform-validation-20260901` and was not mixed into this baseline.
- Two ME-08 prefix-cache A/B branches remain intentionally unmerged because they contain mutually exclusive frozen toolchain locks.
- Windows test-copy artifacts accidentally written to non-source paths and the six-byte ACL probe were removed after hash/path verification.
- Ubuntu's 1.9 GiB test-only temporary directory was cleared after the final run; its Cargo target cache was retained.
