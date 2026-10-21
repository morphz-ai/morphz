"""Keep explicitly ignored PostgreSQL Runtime contracts owned by required CI."""

import contextlib
import importlib.util
import io
from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "runtime_postgres_runner", ROOT / "scripts/test_runtime_postgres_lib.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def postgres_source_cases():
    found = {}
    pattern = re.compile(
        r'#\[ignore\s*=\s*"([^"]+)"\]\s*(?:#\[[^\]]+\]\s*)*'
        r'(?:async\s+)?fn\s+(\w+)\s*\('
    )
    for source in (ROOT / "morphz/src").rglob("*.rs"):
        for reason, name in pattern.findall(source.read_text()):
            if "postgres" in reason.lower():
                if name in found:
                    raise AssertionError(f"Ambiguous PostgreSQL case: {name}")
                found[name] = source.relative_to(ROOT).as_posix()
    return found


def job_source(workflow, name):
    marker = f"\n  {name}:\n"
    if marker not in workflow:
        raise AssertionError(f"Missing {name} job")
    tail = workflow.split(marker, 1)[1]
    next_job = re.search(r"^  [a-z][a-z0-9-]*:\s*$", tail, re.MULTILINE)
    return tail[:next_job.start()] if next_job else tail


def verify_coverage(cases, workflow, io_workflow):
    owned = {case.rsplit("::", 1)[1] for case in runner.CASES}
    io_cases = {name for name, source in cases.items() if "/session_io/" in source}
    if set(cases) != owned | io_cases:
        raise AssertionError("Ignored PostgreSQL library inventory does not match its CI owners")
    if len(owned) != len(runner.CASES) or len(owned) < 5 or len(io_cases) < 2:
        raise AssertionError("PostgreSQL contract inventory was duplicated or reduced")
    unit_job = job_source(workflow, "test")
    marker = "python3 scripts/test_runtime_postgres_lib.py"
    steps = [step for step in unit_job.split("\n      - ") if marker in step]
    if len(steps) != 1:
        raise AssertionError("Missing required Runtime PostgreSQL library step")
    if not re.search(r"if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}", steps[0]):
        raise AssertionError("An unrelated default-suite failure must not omit the PostgreSQL contracts")
    if re.search(r"continue-on-error|\|\|\s*true", steps[0]):
        raise AssertionError("PostgreSQL contracts cannot be optional")
    if "MORPHZ_TEST_POSTGRES_URL: postgres://morphz:morphz@127.0.0.1:5432/morphz_test" not in unit_job:
        raise AssertionError("Only the existing job-owned PostgreSQL service supplies credentials")
    if not re.search(r"apt-get install[^\n]*bubblewrap", unit_job):
        raise AssertionError("Real terminal coverage requires the existing native sandbox fixture")
    if "python3 -m unittest discover -s scripts/tests -p test_runtime_postgres_ci.py -v" not in job_source(workflow, "check"):
        raise AssertionError("The inventory guard must run in CI")
    if not re.search(r"cargo test --locked -p morphz --lib session_io:: -- --include-ignored --test-threads=1", io_workflow):
        raise AssertionError("Session IO PostgreSQL contracts lost their existing owner")


class PostgresCiTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/ci.yml").read_text()
        self.io_workflow = (ROOT / ".github/workflows/session-io.yml").read_text()
        self.cases = postgres_source_cases()

    def test_every_explicitly_ignored_postgres_case_has_a_required_owner(self):
        verify_coverage(self.cases, self.workflow, self.io_workflow)

    def test_missing_case_or_new_unowned_case_is_rejected(self):
        for changed in [
            {name: source for name, source in self.cases.items() if name != "terminal_postgres_store_and_real_pty_contract"},
            {**self.cases, "postgres_new_contract": "morphz/src/example.rs"},
        ]:
            with self.assertRaisesRegex(AssertionError, "inventory does not match"):
                verify_coverage(changed, self.workflow, self.io_workflow)

    def test_missing_optional_or_success_only_step_is_rejected(self):
        marker = "python3 scripts/test_runtime_postgres_lib.py"
        for changed, message in [
            (self.workflow.replace(marker, "echo omitted"), "Missing required"),
            (self.workflow.replace(marker, f"{marker} || true"), "cannot be optional"),
            (self.workflow.replace("if: ${{ !cancelled() }}", "if: success()"), "must not omit"),
        ]:
            with self.assertRaisesRegex(AssertionError, message):
                verify_coverage(self.cases, changed, self.io_workflow)

    def test_missing_session_io_owner_or_inventory_guard_is_rejected(self):
        changed_io = self.io_workflow.replace("--include-ignored", "")
        with self.assertRaisesRegex(AssertionError, "Session IO PostgreSQL"):
            verify_coverage(self.cases, self.workflow, changed_io)
        changed_workflow = self.workflow.replace(
            "python3 -m unittest discover -s scripts/tests -p test_runtime_postgres_ci.py -v", "echo omitted"
        )
        with self.assertRaisesRegex(AssertionError, "inventory guard must run"):
            verify_coverage(self.cases, changed_workflow, self.io_workflow)

    def test_only_one_actually_executed_passing_case_is_success(self):
        good = "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1682 filtered out;\n"
        self.assertTrue(runner.accepted_result(subprocess.CompletedProcess([], 0, good)))
        for code, output in [
            (1, good), (0, ""), (0, good.replace("1 passed", "0 passed")),
            (0, good.replace("0 ignored", "1 ignored")), (0, good + good),
            (0, good.replace("0 failed", "1 failed")),
        ]:
            self.assertFalse(runner.accepted_result(subprocess.CompletedProcess([], code, output)))

    def test_missing_database_never_invokes_cargo(self):
        def no_run(*args, **kwargs):
            self.fail("Cargo must not run without an explicit dedicated test database")
        with contextlib.redirect_stderr(io.StringIO()):
            for env in [{}, {"MORPHZ_TEST_POSTGRES_URL": " "}]:
                self.assertEqual(runner.run_tests(no_run, env), 2)

    def test_all_exact_cases_are_collected_after_a_failure_without_retries(self):
        calls = []
        environment = {"MORPHZ_TEST_POSTGRES_URL": "postgresql://catalog.invalid/not-connected"}
        def controlled_run(args, **kwargs):
            calls.append(args)
            self.assertIs(kwargs["env"], environment)
            output = "test result: ok. 1 passed; 0 failed; 0 ignored;\n"
            return subprocess.CompletedProcess(args, 1 if len(calls) == 1 else 0, output)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(runner.run_tests(controlled_run, environment), 1)
        self.assertEqual(len(calls), len(runner.CASES))
        for args, name in zip(calls, runner.CASES):
            self.assertEqual(args[1:], [
                "test", "--locked", "-p", "morphz", "--lib", name,
                "--", "--exact", "--ignored", "--test-threads=1", "--nocapture",
            ])

    def test_administrator_installed_binary_preserves_every_exact_case_and_summary_check(self):
        calls = []
        environment = {"MORPHZ_TEST_POSTGRES_URL": "postgresql://catalog.invalid/not-connected",
                       "MORPHZ_TEST_RUNTIME_LIB": "/installed/native-test"}
        def controlled_run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 0, "test result: ok. 1 passed; 0 failed; 0 ignored;\n")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.run_tests(controlled_run, environment), 0)
        self.assertEqual(calls, [["/installed/native-test", case, "--exact", "--ignored",
                                 "--test-threads=1", "--nocapture"] for case in runner.CASES])


if __name__ == "__main__":
    unittest.main()
