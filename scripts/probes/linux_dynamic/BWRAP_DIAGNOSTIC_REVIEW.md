# Same-source UID-map diagnostic runner: implementation review

Status: implementation and pure local tests only. Not yet built/run on Linux.
This is not a production sandbox change or a proposed permission expansion.

## Frozen inputs and exact source

The current policy compiler remains
`6c846527d61d3b0a1ee71250d0d561af9d4d02cf8248c0cc3db663fff0c68531`.
The entry, loader, controller and worker also remain byte-for-byte unchanged.
`bwrap_diagnostic_runner.py` pins each hash and checks them before both campaigns.

Both binaries are built from the official Ubuntu source
`bubblewrap 0.9.0-1ubuntu0.3`, including both distribution patches. All three
source downloads, both distribution patches, both C files after patching and the
reviewed diagnostic diff have exact SHA256 pins. The HTTPS DSC's checksums are
verified; this is not a PGP signature verification claim. The source archive
extractor rejects traversal, devices, hardlinks and unreviewed symlinks.

Meson/Ninja, compiler and Debian hardening flags are identical between variants.
Only the diagnostic C patch differs. The local build skips upstream test/man/
completion compilation, not any Morphz CI gate. Versions, complete configure/
compile logs and binary hashes are retained. We do not claim bit-reproducibility
against Ubuntu's installed binary.

## Fixed-path replacement and restoration

Execution requires Linux, a non-root caller, the explicit isolated-probe marker,
GitHub Actions and the exact independent probe branch. Default mode is inert.

1. Check the installed package version and that `/usr/bin/bwrap` is canonical,
   non-symlink, regular, root:root, mode `0755`, without file capabilities.
2. Create an exclusive root-owned `/tmp/morphz-bwrap-backup-<32 hex>` directory,
   mode `0700`. Copy the original with metadata preservation and check content
   hash, size, owner, mode and capabilities. A root-owned `0400` manifest records
   the original and the two allowed replacement hashes.
3. Persist the exact recovery pointer before changing the system binary. It
   grants no authority to arbitrary paths: restoration accepts only the fixed
   backup grammar, verifies the root-owned private directory/manifest/backup,
   and always targets exactly `/usr/bin/bwrap`.
4. Use an exclusive root-owned staging directory inside `/usr/bin`. Verify the
   staged file, then atomically move it over the target. Refuse to overwrite a
   current target whose hash is neither original nor an owned variant.
5. Run each unmodified controller with a fresh evidence directory. Preserve
   both exits/stdout/stderr/receipts even when the baseline fails. A cleanup
   failure prevents starting the second campaign; normal assertions may fail
   while the diagnostic control still runs.
6. In `finally`, restore the original bytes and metadata using the same staged
   process, then verify hash/size/owner/mode/capabilities. The private backup is
   retained until the disposable runner is destroyed.
7. An `if: always()` workflow step independently repeats restoration. The first
   restoration failure remains fatal in its saved summary even if fallback
   later succeeds. Unknown/currently modified binaries are not blindly
   overwritten. This cannot undo lost machines or preemption, but no persistent
   developer machine is used.

The controller receives signals in its own process group and has 45 seconds for
its existing cleanup, then 5 seconds for an owned-process fallback kill. Forced
kill is a failure, not success. Only the controller's own group is signaled;
profile collection stays with the existing controller, never a broad scan/kill.
Signal handling does not ignore the first interrupt; further signals cannot
interrupt restoration. Restoration errors are stored independently alongside,
not instead of, earlier campaign errors.

## Verdict and limitations

The pair is green only if both campaigns succeed, both exit cleanly, and original
binary restoration succeeds. Diagnostic output is evidence, not a workaround.
Baseline divergence from the packaged failure must be investigated, not hidden.

No capabilities, ptrace permissions, profile rules, global sysctls, ordinary exec
allowlist or production installation changes. Dynamic workspace, abstract/
anonymous socket negatives and future-path protection remain unverified until
the existing lanes are actually reached. Hardlinks/delegated FD/arbitrary
production exec and the cost of protected-ancestor constraints remain outside
this diagnostic's completion claim.

## Review / execution commands

Before publication:

```sh
python3 -B -m unittest discover -s /tmp/morphz-linux-dynamic-probe.uUkbhj -p 'test_*.py' -v
python3 -B /tmp/morphz-linux-dynamic-probe.uUkbhj/bwrap_diagnostic_runner.py
```

After review, publish only the independent branch's new runner, patch, tests,
review document, frozen manifest and isolated workflow. Keep previous commits,
runs and raw evidence. No main checkout/index change and no production CI change.
The workflow uses pinned Ubuntu dependencies, compiles the unchanged entry, and
runs the pair followed by mandatory independent restoration and artifact upload.
