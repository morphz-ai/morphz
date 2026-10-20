import importlib.util
import os
from pathlib import Path
import struct
import subprocess
import shutil
import selectors
import tempfile
import time
import unittest
import tomllib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prune", Path(__file__).resolve().parents[1] / "prune_cargo_target.py")
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)


def macho(names):
    strings = b"\0"
    symbols = b""
    for name in names:
        symbols += struct.pack("<IBBHQ", len(strings), 0x66, 0, 0, 1)
        strings += name.encode() + b"\0"
    header = struct.pack("<IIIIIIII", 0xfeedfacf, 0, 0, 2, 1, 24, 0, 0)
    return header + struct.pack("<IIIIII", 2, 24, 56, len(names), 56 + len(symbols), len(strings)) + symbols + strings


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="morphz-cargo-collector-")
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name).resolve() / "target"
        self.deps = self.target / "debug/deps"
        self.deps.mkdir(parents=True)
        (self.target / "CACHEDIR.TAG").write_text(prune.TAG)
        (self.target / "debug/.cargo-lock").touch()
        self.stem = "test-0123456789abcdef"
        self.old = self.deps / (self.stem + ".old.old.rcgu.o")
        self.live = self.deps / (self.stem + ".new.new.rcgu.o")
        for p in (self.old, self.live):
            p.write_bytes(b"object")
            os.utime(p, (time.time() - 172800,) * 2)
        self.binary = self.deps / self.stem
        self.binary.write_bytes(macho([str(self.live)]))
        (self.deps / (self.stem + ".d")).touch()
        fp = self.target / "debug/.fingerprint/crate-0123456789abcdef"
        fp.mkdir(parents=True)
        self.completed = fp / "test-integration-test-test"
        self.completed.write_text("0123456789abcdef")
        self.cache = self.target / "debug/incremental/session/work-products.bin"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_bytes(b"hot incremental state")
        self.busy = patch.object(prune, "build_busy", return_value=False)
        self.busy.start()
        self.addCleanup(self.busy.stop)

    def test_dry_run_and_apply_preserve_current_objects_and_cache(self):
        self.assertEqual(prune.collect(self.target)["candidates"], 1)
        self.assertTrue(self.old.exists())
        before = self.cache.stat()
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 1)
        self.assertFalse(self.old.exists())
        self.assertTrue(self.live.exists())
        self.assertEqual(self.cache.read_bytes(), b"hot incremental state")
        self.assertEqual(prune.signature(self.cache.stat()), prune.signature(before))
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)

    def test_other_published_binary_protects_old_dependency_objects(self):
        (self.target / "debug/morphz").write_bytes(macho([str(self.old)]))
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)

    def test_hardlink_and_missing_completion_fail_closed(self):
        os.link(self.old, self.deps / "retained-link")
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)
        self.completed.unlink()
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)

    def test_unknown_artifact_and_young_objects_are_retained(self):
        self.binary.write_bytes(b"unknown")
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)
        self.binary.write_bytes(macho([str(self.live)]))
        os.utime(self.old, None)
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)

    def test_symlinks_and_wrong_target_are_refused(self):
        self.old.unlink()
        self.old.symlink_to(self.cache)
        self.assertEqual(prune.collect(self.target, apply=True)["removed"], 0)
        (self.target / "CACHEDIR.TAG").write_text("not cargo")
        with self.assertRaises(ValueError):
            prune.validate_target(self.target)

    def test_busy_and_cargo_lock_are_respected(self):
        with patch.object(prune, "build_busy", return_value=True):
            with self.assertRaises(BlockingIOError):
                prune.collect(self.target, apply=True)
        import fcntl
        with (self.target / "debug/.cargo-lock").open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                prune.collect(self.target, apply=True)

    def test_budget_does_not_touch_protected_files(self):
        self.assertEqual(prune.collect(self.target, apply=True, max_bytes=0)["removed"], 0)

    @unittest.skipUnless(shutil.which("cargo"), "Cargo unavailable")
    def test_real_cargo_obeys_same_lock(self):
        project = self.target.parent / "crate"
        (project / "src").mkdir(parents=True)
        (project / "Cargo.toml").write_text('[package]\nname="collector_lock_test"\nversion="0.0.0"\nedition="2024"\n[workspace]\n')
        (project / "src/main.rs").write_text('fn main() {}')
        child = None
        try:
            with prune.cargo_lock(self.target / "debug"):
                # CI forces colored Cargo output; ANSI between "Blocking" and
                # "waiting" must not disguise the actual lock barrier. Exercise
                # that inherited setting and explicitly request machine text.
                child = subprocess.Popen(
                    ["cargo", "build", "--color", "never", "--manifest-path", str(project / "Cargo.toml"), "--target-dir", str(self.target)],
                    env={**os.environ, "CARGO_TERM_COLOR": "always"},
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                waiting = b""
                # A fixed delay only proves Cargo is alive: cold startup may
                # not have reached its lock yet. Require the real lock barrier
                # while the collector still owns the exact inode.
                deadline = time.monotonic() + 30
                with selectors.DefaultSelector() as ready:
                    ready.register(child.stderr, selectors.EVENT_READ)
                    while b"Blocking waiting for file lock" not in waiting:
                        remaining = deadline - time.monotonic()
                        self.assertGreater(remaining, 0, waiting.decode())
                        for key, _ in ready.select(timeout=remaining):
                            chunk = os.read(key.fd, 65536)
                            self.assertTrue(chunk, "Cargo exited before waiting on the collector lock: " + waiting.decode())
                            waiting += chunk
                        self.assertIsNone(child.poll(), "Cargo bypassed the collector lock: " + waiting.decode())
                self.assertNotIn(b"\x1b[", waiting)
                self.assertFalse((self.target / "debug/collector_lock_test").exists())
            _, error = child.communicate(timeout=30)
            self.assertEqual(child.returncode, 0, (waiting + error).decode())
            self.assertTrue((self.target / "debug/collector_lock_test").is_file())
        finally:
            if child is not None:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=10)
                child.stdout.close()
                child.stderr.close()

    def test_dev_and_test_share_light_debug_and_incremental_settings(self):
        repository = Path(__file__).resolve().parents[2]
        profiles = tomllib.loads((repository / "Cargo.toml").read_text())["profile"]
        self.assertEqual(profiles["dev"], profiles["test"])
        self.assertEqual(profiles["dev"]["debug"], "line-tables-only")
        self.assertIs(profiles["dev"]["incremental"], True)
        self.assertEqual(tomllib.loads((repository / ".cargo/config.toml").read_text())["build"]["jobs"], 2)
        for workflow in (repository / ".github/workflows").glob("*.yml"):
            self.assertNotRegex(workflow.read_text(), r"CARGO_PROFILE_(DEV|TEST)_DEBUG:", str(workflow))


if __name__ == "__main__":
    unittest.main()
