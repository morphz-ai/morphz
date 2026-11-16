"""Exercise real Git ranges and fail-closed CI selection without product I/O."""

from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ci_impact", ROOT / "scripts/ci-impact.py")
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)
COMMIT = "a" * 40


def scopes(plan):
    return {name for name, enabled in plan["scopes"].items() if enabled}


def results(workflow, plan):
    return {"impact": {"result": "success"}, **{
        name: {"result": "success" if (plan["profile"] if scope == "profile"
                                      else plan["scopes"][scope]) else "skipped"}
        for name, scope in CI.JOBS[workflow].items()}}


def workflow_jobs(source):
    body = source.split("\njobs:\n", 1)[1]
    return {match[1]: match[2] for match in re.finditer(
        r"^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)", body, re.M | re.S)}


class ClassificationTests(unittest.TestCase):
    def test_shared_renderer_keeps_all_web_desktop_and_stability_owners(self):
        plan = CI.classify(["application/apps/web/src/ExecutionActivity.tsx",
                            "application/apps/web/src/styles/execution-activity.css"], COMMIT)
        self.assertEqual(plan["mode"], "scoped")
        self.assertEqual(scopes(plan), {"application"})
        selected = {job for job, scope in CI.JOBS["ci"].items() if scope in scopes(plan)}
        self.assertEqual(selected, {"application-source-resources", "native-regressions"})
        selected = {job for job, scope in CI.JOBS["application"].items() if scope in scopes(plan)}
        self.assertEqual(selected, {"web-node", "web-node-complete", "web-browser", "web",
                                    "macos-node", "desktop", "macos"})

    def test_changed_application_tests_keep_real_runtime_and_cloud_capabilities(self):
        plan = CI.classify(["application/tests/fixtures/actual-runtime.hns",
                            "application/apps/web/src/Conversation.tsx"], COMMIT)
        self.assertEqual(scopes(plan), {"application", "contracts", "storage"})
        self.assertFalse(plan["scopes"]["runtime"])

    def test_renderer_protocol_clients_data_logic_and_host_are_not_presentation(self):
        for path in [
            "application/apps/web/src/client.ts",
            "application/apps/web/src/platform-client.ts",
            "application/apps/web/src/cognitive-app-client.ts",
            "application/apps/web/src/application-transport.ts",
            "application/apps/web/src/legacy-storage.ts",
            "application/apps/web/src/task-runtime-projection.ts",
            "application/apps/web/src/new-protocol.ts",
            "application/apps/web/src/host/builtin-application-adapters.tsx",
            "application/apps/web/src/host/icon.svg",
            "application/apps/web/package.json",
            "application/apps/web/vite.config.ts",
            "application/apps/web/index.html",
        ]:
            with self.subTest(path=path):
                self.assertEqual(CI.classify([path], COMMIT)["mode"], "full")
                self.assertEqual(CI.classify(["application/apps/web/src/ui.css", path], COMMIT)["mode"], "full")

    def test_renderer_visual_assets_keep_ui_owners(self):
        for path in ["application/apps/web/src/Icons.tsx",
                     "application/apps/web/src/styles/tokens.css",
                     "application/apps/web/public/icon.svg",
                     "application/apps/web/public/brand.webp",
                     "application/apps/web/public/font.woff2"]:
            with self.subTest(path=path):
                self.assertEqual(scopes(CI.classify([path], COMMIT)), {"application"})

    def test_website_and_ui_union_keeps_both_consumers(self):
        plan = CI.classify(["website/content/docs/en/start.md",
                            "application/apps/web/src/ui.css"], COMMIT)
        self.assertEqual(scopes(plan), {"application", "website"})

    def test_shared_protocol_native_privileges_runtime_dependencies_and_ci_are_full(self):
        for path in [
            "morphz/src/session_io/data.rs", "morphz/tests/user_input_runtime.rs",
            "yao/src/lib.rs", "executor/src/lib.rs", "extensions/new/src/lib.rs",
            "sdk/python/morphz/session.py", "application/packages/core/src/input.ts",
            "application/packages/application/src/runtime.ts",
            "application/apps/desktop/main.cjs", "application/apps/service/src/http.ts",
            "application/harnesses/script-studio.hns", "application/package-lock.json",
            "application/package.json", "application/vite.config.ts", "Cargo.lock",
            "Cargo.toml", "dashboard/src/components/Markdown.tsx",
            "dashboard/dist/index.html", "website/public/install.sh", "AGENTS.md",
            ".github/workflows/ci.yml", "scripts/ci-impact.py", "scripts/new-file.py",
            "THIRD_PARTY_LICENSES_RUST.md", "docs/standards/new.md", "mobile/new.swift",
            "new-top-level/file", "application/docs/executable.py",
        ]:
            with self.subTest(path=path):
                plan = CI.classify([path], COMMIT)
                self.assertEqual(plan["mode"], "full")
                self.assertEqual(scopes(plan), set(CI.SCOPES))

    def test_unknown_path_in_mixed_commit_cannot_be_hidden_by_known_ui(self):
        self.assertEqual(CI.classify(["application/apps/web/src/ui.css", "new/contract"], COMMIT)["mode"], "full")

    def test_unusual_valid_names_are_data_and_traversal_is_never_a_ui_change(self):
        self.assertEqual(scopes(CI.classify(["application/apps/web/src/a\nb $(false).css"], COMMIT)), {"application"})
        for path in ["", "/application/apps/web/ui.css", "application/apps/web/../core.ts",
                     "application/apps/web//ui.css", "application/apps/web/./ui.css",
                     "application/apps/web/ui\\../../contract"]:
            with self.subTest(path=path):
                self.assertEqual(CI.classify([path], COMMIT)["mode"], "full")
        self.assertEqual(CI.classify([], COMMIT)["mode"], "full")

    def test_documentation_only_plan_still_requires_impact_and_result_gates(self):
        plan = CI.classify(["application/docs/16-ui-design-standard.md"], COMMIT)
        self.assertEqual(scopes(plan), set())
        for workflow in CI.JOBS:
            CI.verify_results(workflow, plan, results(workflow, plan), COMMIT)


class GitRangeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="morphz-ci-impact-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "CI fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.base = self.commit("application/apps/web/src/ui.css", "initial")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), "-c", "core.hooksPath=/dev/null",
                                        "-c", "commit.gpgsign=false", *args],
                                       text=True, stderr=subprocess.DEVNULL).strip()

    def commit(self, path=None, contents="changed"):
        if path:
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(contents)
        self.git("add", "-A")
        self.git("commit", "-q", "--no-verify", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def plan(self, event, kind="push", ref="refs/heads/main"):
        return CI.event_plan(self.root, event, kind, ref, self.git("rev-parse", "HEAD"))

    def test_real_ui_push_and_cli_output_receipt(self):
        head = self.commit("application/apps/web/src/ui.css", "next")
        event = {"before": self.base, "after": head}
        self.assertEqual(scopes(self.plan(event)), {"application"})
        event_file = self.root / "event.json"
        event_file.write_text(json.dumps(event))
        output = self.root / "outputs"
        summary = self.root / "summary"
        command = subprocess.run(["python3", "-B", str(ROOT / "scripts/ci-impact.py"),
                                  "plan", "--root", str(self.root), "--event", str(event_file)],
                                 env={**os.environ, "GITHUB_SHA": head, "GITHUB_EVENT_NAME": "push",
                                      "GITHUB_REF": "refs/heads/main", "GITHUB_OUTPUT": str(output),
                                      "GITHUB_STEP_SUMMARY": str(summary)},
                                 check=True, text=True, capture_output=True)
        self.assertIn("runtime=false\n", output.read_text())
        self.assertIn("application=true\n", output.read_text())
        self.assertIn(head, summary.read_text())
        self.assertEqual(json.loads(command.stdout)["commit"], head)

    def test_entire_multi_commit_push_is_used_not_just_last_commit(self):
        self.commit("morphz/src/protocol.rs")
        head = self.commit("application/apps/web/src/ui.css", "last")
        self.assertEqual(self.plan({"before": self.base, "after": head})["mode"], "full")

    def test_delete_and_rename_include_old_shared_path(self):
        base = self.commit("application/packages/core/src/contract.ts")
        old = self.root / "application/packages/core/src/contract.ts"
        old.rename(self.root / "application/apps/web/src/moved.tsx")
        head = self.commit()
        changed = CI.changed_paths(self.root, base, head, merge_base=False)
        self.assertIn("application/packages/core/src/contract.ts", changed)
        self.assertIn("application/apps/web/src/moved.tsx", changed)
        self.assertEqual(self.plan({"before": base, "after": head})["mode"], "full")
        (self.root / "application/apps/web/src/moved.tsx").unlink()
        deleted = self.commit()
        self.assertEqual(scopes(self.plan({"before": head, "after": deleted})), {"application"})

    def test_pull_request_uses_merge_base_and_whole_branch_with_merge_checkout(self):
        self.git("checkout", "-q", "-b", "feature")
        self.commit("application/apps/web/src/first.css")
        head = self.commit("application/apps/web/src/ui.css", "second")
        self.git("checkout", "-q", "main")
        base = self.commit("morphz/src/unrelated-on-base.rs")
        self.git("merge", "--no-edit", "feature")
        event = {"pull_request": {"base": {"sha": base, "ref": "main"}, "head": {"sha": head}}}
        plan = self.plan(event, "pull_request", "refs/pull/12/merge")
        self.assertEqual(scopes(plan), {"application"})
        self.assertEqual(plan["changed_paths"], 2)

    def test_missing_zero_or_bad_history_and_head_mismatch_force_full(self):
        head = self.commit("application/apps/web/src/ui.css", "next")
        for event in [{"before": "0" * 40, "after": head}, {"before": "f" * 40, "after": head},
                      {"before": "HEAD~1", "after": head}, {"before": self.base, "after": "b" * 40}, {}]:
            with self.subTest(event=event):
                self.assertEqual(self.plan(event)["mode"], "full")
        with self.assertRaises(CI.ImpactError):
            CI.event_plan(self.root, {}, "push", "refs/heads/main", self.base)

    def test_git_path_count_and_byte_budgets_cannot_produce_partial_green(self):
        head = self.commit("application/apps/web/src/a\nb $(false).css")
        self.assertEqual(scopes(self.plan({"before": self.base, "after": head})), {"application"})
        for budget, value in (("MAX_DIFF_BYTES", 1), ("MAX_PATHS", 0)):
            with mock.patch.object(CI, budget, value):
                self.assertEqual(self.plan({"before": self.base, "after": head})["mode"], "full")

    def test_release_branches_tags_release_pr_manual_and_unknown_events_are_full(self):
        head = self.commit("application/apps/web/src/ui.css", "next")
        event = {"before": self.base, "after": head}
        for ref in ("refs/heads/release/0.1.6", "refs/tags/v0.1.6", "refs/tags/desktop-v0.1.0"):
            self.assertEqual(self.plan(event, ref=ref)["mode"], "full")
        event = {"pull_request": {"base": {"sha": self.base, "ref": "release/0.1.6"}, "head": {"sha": head}}}
        self.assertEqual(self.plan(event, "pull_request", "refs/pull/12/merge")["mode"], "full")
        for kind in ("workflow_dispatch", "workflow_call", "new-event"):
            self.assertEqual(self.plan({}, kind)["mode"], "full")
        self.assertTrue(self.plan({"inputs": {"conversation_profile": "true"}}, "workflow_dispatch")["profile"])

    def test_actual_manual_payload_with_null_inputs_produces_full_cli_outputs(self):
        head = self.commit("application/apps/web/src/ui.css", "next")
        for event in ({}, {"inputs": None}, {"inputs": {}}, {"inputs": {"conversation_profile": False}}):
            with self.subTest(event=event):
                plan = self.plan(event, "workflow_dispatch")
                self.assertEqual(plan["mode"], "full")
                self.assertEqual(scopes(plan), set(CI.SCOPES))
                self.assertFalse(plan["profile"])
        event_file = self.root / "manual.json"
        event_file.write_text(json.dumps({"inputs": None}))
        output = self.root / "manual-outputs"
        subprocess.run(["python3", "-B", str(ROOT / "scripts/ci-impact.py"), "plan",
                        "--root", str(self.root), "--event", str(event_file)],
                       env={**os.environ, "GITHUB_SHA": head, "GITHUB_EVENT_NAME": "workflow_dispatch",
                            "GITHUB_REF": "refs/heads/main", "GITHUB_OUTPUT": str(output),
                            "GITHUB_STEP_SUMMARY": str(self.root / "manual-summary")},
                       check=True, capture_output=True, text=True)
        for scope in CI.SCOPES:
            self.assertIn(f"{scope}=true\n", output.read_text())
        for inputs in ([], "false", 1):
            with self.assertRaises(CI.ImpactError):
                self.plan({"inputs": inputs}, "workflow_dispatch")
        for value in (None, 0, 1, [], "unexpected"):
            with self.assertRaises(CI.ImpactError):
                self.plan({"inputs": {"conversation_profile": value}}, "workflow_dispatch")


class ReceiptTests(unittest.TestCase):
    def test_native_diagnostics_keep_failure_status_and_bound_console_evidence(self):
        source = (ROOT / ".github/workflows/application-native-regressions.yml").read_text()
        job = workflow_jobs(source)["macos-mounted-resource-passes"]
        handler = re.search(r"^          trap '([^\n]+)' EXIT$", job, re.M)[1]
        with tempfile.TemporaryDirectory(prefix="morphz-ci-failure-log-") as directory:
            output = Path(directory) / "output with spaces.log"
            output.write_bytes(b"x" * 100_000 + b"original failure detail\n")
            command = 'set -euo pipefail; output="$1"; trap \'' + handler + '\' EXIT; exit "$2"'
            for status in (0, 1, 7, 130):
                result = subprocess.run(["bash", "-c", command, "fixture", str(output), str(status)],
                                        capture_output=True)
                self.assertEqual(result.returncode, status)
                self.assertEqual(len(result.stdout), 65536 if status else 0)
                if status:
                    self.assertTrue(result.stdout.endswith(b"original failure detail\n"))

    def test_full_and_scoped_complete_receipts_pass_for_both_workflows(self):
        for plan in [CI.full_plan(COMMIT, "fixture"), CI.classify(["application/apps/web/src/ui.css"], COMMIT),
                     CI.classify(["website/app/page.tsx"], COMMIT)]:
            for workflow in CI.JOBS:
                CI.verify_results(workflow, plan, results(workflow, plan), COMMIT)

    def test_selected_failure_skip_cancellation_missing_unknown_and_unexpected_run_refuse(self):
        for workflow in CI.JOBS:
            plan = CI.full_plan(COMMIT, "fixture")
            plan["profile"] = True
            for job in CI.JOBS[workflow]:
                for outcome in ("failure", "cancelled", "skipped", "neutral", None):
                    inventory = results(workflow, plan)
                    inventory[job]["result"] = outcome
                    with self.subTest(workflow=workflow, job=job, outcome=outcome), self.assertRaises(CI.ImpactError):
                        CI.verify_results(workflow, plan, inventory, COMMIT)
                inventory = results(workflow, plan)
                del inventory[job]
                with self.assertRaises(CI.ImpactError):
                    CI.verify_results(workflow, plan, inventory, COMMIT)
            plan = CI.classify(["application/apps/web/src/ui.css"], COMMIT)
            inventory = results(workflow, plan)
            inventory["unexpected"] = {"result": "success"}
            with self.assertRaises(CI.ImpactError):
                CI.verify_results(workflow, plan, inventory, COMMIT)
            for job, receipt in results(workflow, plan).items():
                if receipt["result"] == "skipped":
                    inventory = results(workflow, plan)
                    inventory[job]["result"] = "success"
                    with self.assertRaises(CI.ImpactError):
                        CI.verify_results(workflow, plan, inventory, COMMIT)

    def test_failed_impact_wrong_sha_and_malformed_or_partial_plan_refuse(self):
        for workflow in CI.JOBS:
            plan = CI.full_plan(COMMIT, "fixture")
            for outcome in ("failure", "cancelled", "skipped"):
                inventory = results(workflow, plan)
                inventory["impact"]["result"] = outcome
                with self.assertRaises(CI.ImpactError):
                    CI.verify_results(workflow, plan, inventory, COMMIT)
            for key, value in [("version", 2), ("commit", "b" * 40), ("profile", "false")]:
                changed = {**plan, key: value}
                with self.assertRaises(CI.ImpactError):
                    CI.verify_results(workflow, changed, results(workflow, plan), COMMIT)
            for value in (False, "false"):
                changed = deepcopy(plan)
                changed["scopes"]["runtime"] = value
                with self.assertRaises(CI.ImpactError):
                    CI.verify_results(workflow, changed, results(workflow, plan), COMMIT)

    def test_bounded_job_results_do_not_copy_large_matrix_outputs_and_reject_missing_owners(self):
        for workflow in CI.JOBS:
            plan = CI.full_plan(COMMIT, "fixture")
            expected = results(workflow, plan)
            environment = {CI.result_environment_name(job): receipt["result"] for job, receipt in expected.items()}
            self.assertEqual(CI.job_results(workflow, environment), expected)
            for name in environment:
                with self.assertRaises(CI.ImpactError):
                    CI.job_results(workflow, {key: value for key, value in environment.items() if key != name})
            with self.assertRaises(CI.ImpactError):
                CI.job_results(workflow, {**environment, "CI_RESULT_UNDECLARED": "success"})
            self.assertLess(len(json.dumps(environment)), 2048)

    def test_real_gate_command_admits_scoped_receipts_and_rejects_an_unexpected_skip(self):
        for workflow in CI.JOBS:
            plan = CI.classify(["application/apps/web/src/ui.css"], COMMIT)
            environment = {**os.environ, "GITHUB_SHA": COMMIT, "IMPACT_PLAN": json.dumps(plan),
                           **{CI.result_environment_name(job): receipt["result"]
                              for job, receipt in results(workflow, plan).items()}}
            command = ["python3", "-B", str(ROOT / "scripts/ci-impact.py"), "verify", "--workflow", workflow]
            success = subprocess.run(command, env=environment, text=True, capture_output=True)
            self.assertEqual(success.returncode, 0, success.stderr)
            selected = next(job for job, scope in CI.JOBS[workflow].items() if scope == "application")
            environment[CI.result_environment_name(selected)] = "skipped"
            failure = subprocess.run(command, env=environment, text=True, capture_output=True)
            self.assertNotEqual(failure.returncode, 0)
            self.assertIn(selected, failure.stderr)

    def test_workflows_wire_every_existing_owner_and_always_run_fail_closed_gate(self):
        for workflow, expected in CI.JOBS.items():
            source = (ROOT / f".github/workflows/{workflow}.yml").read_text()
            jobs = workflow_jobs(source)
            self.assertEqual(set(jobs), {"impact", "affected", *expected})
            self.assertIn("uses: ./.github/workflows/ci-impact.yml", jobs["impact"])
            gate = jobs["affected"]
            self.assertIn("if: ${{ always() }}", gate)
            needs = re.search(r"    needs: \[([^\]]+)\]", gate)[1].split(", ")
            self.assertEqual(set(needs), {"impact", *expected})
            self.assertNotIn("toJSON(needs)", gate)
            for job in ("impact", *expected):
                self.assertIn(CI.result_environment_name(job) + ": ${{ needs." + job + ".result }}", gate)
            self.assertIn("IMPACT_PLAN: ${{ needs.impact.outputs.plan }}", gate)
            self.assertIn(f"run: python3 -B scripts/ci-impact.py verify --workflow {workflow}", gate)
            self.assertNotIn("paths:", source.split("\npermissions:")[0])
            for job, scope in expected.items():
                body = jobs[job]
                self.assertRegex(body, r"    needs: (?:impact\n|\[impact, )")
                condition = ("github.event_name == 'workflow_dispatch' && inputs.conversation_profile"
                             if scope == "profile" else f"needs.impact.outputs.{scope} == 'true'")
                if job in ("web-node-complete", "web", "macos"):
                    condition = "always() && " + condition
                self.assertEqual([line for line in body.splitlines() if line.startswith("    if:")],
                                 ["    if: ${{ " + condition + " }}"])
            for job in ("web-node-complete", "web", "macos") if workflow == "application" else ():
                self.assertIn("always() && needs.impact.outputs.application == 'true'", jobs[job])
            self.assertNotIn("continue-on-error", source)


if __name__ == "__main__":
    unittest.main()
