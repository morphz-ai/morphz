"""Exercise exact-commit release admission without contacting GitHub."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_ci", ROOT / "scripts/verify-release-ci.py")
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)
REPOSITORY = "morphz-ai/morphz"
COMMIT = "a" * 40
BRANCH = "release/0.1.4"


def run(identity=10, attempt=2, **changes):
    return {"id": identity, "run_attempt": attempt, "head_sha": COMMIT,
            "head_branch": BRANCH, "event": "push", "status": "completed",
            "conclusion": "success", "repository": {"full_name": REPOSITORY},
            "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{identity}", **changes}


def jobs(workflow="ci.yml", current=None):
    current = current or run()
    return [{"id": index, "run_id": current["id"], "run_attempt": current["run_attempt"],
             "head_sha": COMMIT, "name": name, "status": "completed", "conclusion": "success"}
            for index, name in enumerate(sorted(CI.REQUIRED_JOBS[workflow]), 1)]


def pages(items):
    return [{"total_count": len(items), "jobs": items}]


class ReleaseCiTests(unittest.TestCase):
    def test_local_runtime_path_dependency_locks_match_the_candidate_version(self):
        expected = tomllib.loads((ROOT / "morphz/Cargo.toml").read_text())["package"]["version"]
        locks = subprocess.run(["git", "ls-files", "--", "*Cargo.lock"], cwd=ROOT,
                               check=True, capture_output=True, text=True).stdout.splitlines()
        checked = []
        for name in locks:
            path = ROOT / name
            manifest = path.with_name("Cargo.toml")
            data = tomllib.loads(manifest.read_text())
            direct_paths = [dependency["path"] for section in ("dependencies", "dev-dependencies", "build-dependencies")
                            for dependency in data.get(section, {}).values()
                            if isinstance(dependency, dict) and "path" in dependency]
            if path != ROOT / "Cargo.lock" and not any(
                    (manifest.parent / value).resolve() == ROOT / "morphz" for value in direct_paths):
                continue
            versions = [package["version"] for package in tomllib.loads(path.read_text())["package"]
                        if package["name"] == "morphz" and "source" not in package]
            self.assertEqual(versions, [expected], name)
            checked.append(name)
        self.assertIn("Cargo.lock", checked)
        self.assertIn("experiments/response-annotations/Cargo.lock", checked)

    def test_exact_repository_commit_branch_push_and_latest_attempt_pass(self):
        current = run()
        self.assertEqual(CI.select_run([{"workflow_runs": [current]}], REPOSITORY, COMMIT, BRANCH), current)
        CI.verify_jobs(pages(jobs()), current, "ci.yml")

    def test_stable_main_admission_does_not_borrow_release_branch_checks(self):
        current = run(head_branch="main")
        self.assertEqual(CI.select_run([{"workflow_runs": [current]}], REPOSITORY, COMMIT, "main"), current)
        with self.assertRaises(CI.AdmissionError):
            CI.select_run([{"workflow_runs": [run()]}], REPOSITORY, COMMIT, "main")

    def test_old_green_cannot_mask_new_failed_pending_or_cancelled_run(self):
        for status, conclusion in [("completed", "failure"), ("in_progress", None),
                                   ("completed", "cancelled"), ("queued", None)]:
            with self.subTest(status=status, conclusion=conclusion):
                with self.assertRaises(CI.AdmissionError):
                    CI.select_run([{"workflow_runs": [run(10), run(11, status=status, conclusion=conclusion)]}],
                                  REPOSITORY, COMMIT, BRANCH)

    def test_duplicate_run_snapshot_never_selects_an_older_attempt(self):
        snapshots = [run(attempt=1), run(attempt=2, conclusion="failure")]
        with self.assertRaises(CI.AdmissionError):
            CI.select_run([{"workflow_runs": snapshots}], REPOSITORY, COMMIT, BRANCH)

    def test_other_repository_commit_branch_and_pull_request_are_not_release_evidence(self):
        for changed in [{"repository": {"full_name": "other/morphz"}}, {"head_sha": "b" * 40},
                        {"head_branch": "main"}, {"head_branch": "release/0.2.0"}, {"event": "pull_request"}]:
            with self.subTest(changed=changed):
                with self.assertRaises(CI.AdmissionError):
                    CI.select_run([{"workflow_runs": [run(**changed)]}], REPOSITORY, COMMIT, BRANCH)

    def test_only_latest_attempt_is_accepted(self):
        for changed in [{"run_attempt": 1}, {"run_id": 9}, {"head_sha": "b" * 40}]:
            inventory = jobs()
            inventory[0].update(changed)
            with self.subTest(changed=changed):
                with self.assertRaises(CI.AdmissionError):
                    CI.verify_jobs(pages(inventory), run(), "ci.yml")

    def test_missing_invalid_duplicate_or_truncated_job_inventory_is_rejected(self):
        inventory = jobs()
        for invalid in [[], [{"total_count": 1, "jobs": []}],
                        [{"total_count": len(inventory) + 1, "jobs": inventory}],
                        pages([inventory[0], inventory[0]]), pages(inventory[:-1])]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(CI.AdmissionError):
                    CI.verify_jobs(invalid, run(), "ci.yml")
        inventory[0]["id"] = None
        with self.assertRaises(CI.AdmissionError):
            CI.verify_jobs(pages(inventory), run(), "ci.yml")

    def test_full_paginated_jobs_are_checked_including_late_failure(self):
        inventory = jobs()
        split = len(inventory) // 2
        response = [{"total_count": len(inventory), "jobs": inventory[:split]},
                    {"total_count": len(inventory), "jobs": inventory[split:]}]
        CI.verify_jobs(response, run(), "ci.yml")
        response[-1]["jobs"][-1]["conclusion"] = "failure"
        with self.assertRaises(CI.AdmissionError):
            CI.verify_jobs(response, run(), "ci.yml")

    def test_no_required_job_can_be_skipped_cancelled_or_incomplete(self):
        for status, conclusion in [("completed", "skipped"), ("completed", "cancelled"),
                                   ("in_progress", None), ("completed", "neutral")]:
            inventory = jobs()
            inventory[0].update(status=status, conclusion=conclusion)
            with self.assertRaises(CI.AdmissionError):
                CI.verify_jobs(pages(inventory), run(), "ci.yml")

    def test_only_explicit_optional_profile_can_be_skipped_not_failed(self):
        inventory = jobs()
        optional = {**inventory[0], "id": 99, "name": "conversation-profile", "conclusion": "skipped"}
        CI.verify_jobs(pages(inventory + [optional]), run(), "ci.yml")
        for name, conclusion in [("different-profile", "skipped"), ("conversation-profile", "failure")]:
            with self.assertRaises(CI.AdmissionError):
                CI.verify_jobs(pages(inventory + [{**optional, "name": name, "conclusion": conclusion}]), run(), "ci.yml")

    def test_reusable_job_names_keep_full_required_inventory(self):
        inventory = jobs()
        for job in inventory:
            job["name"] = "caller / " + job["name"]
        CI.verify_jobs(pages(inventory), run(), "ci.yml")

    def test_full_verifier_fetches_both_workflows_and_exact_attempt_jobs_without_retries(self):
        calls = []
        def fetch(endpoint):
            calls.append(endpoint)
            if "/workflows/" in endpoint:
                workflow = endpoint.split("/workflows/")[1].split("/")[0]
                current = run(10 if workflow == "ci.yml" else 20)
                return [{"workflow_runs": [current]}]
            workflow = "ci.yml" if "/runs/10/" in endpoint else "application.yml"
            return pages(jobs(workflow, run(10 if workflow == "ci.yml" else 20)))
        receipts = CI.verify(REPOSITORY, COMMIT, BRANCH, fetch)
        self.assertEqual([item["workflow"] for item in receipts], list(CI.REQUIRED_WORKFLOWS))
        self.assertEqual(len(calls), 6)
        self.assertIn("/runs/10/attempts/2/jobs?per_page=100", calls[1])
        self.assertIn(f"head_sha={COMMIT}&event=push&per_page=100", calls[0])

    def test_full_verifier_admits_main_and_checks_exact_main_runs(self):
        def fetch(endpoint):
            if "/workflows/" in endpoint:
                workflow = endpoint.split("/workflows/")[1].split("/")[0]
                return [{"workflow_runs": [run(10 if workflow == "ci.yml" else 20, head_branch="main")]}]
            workflow = "ci.yml" if "/runs/10/" in endpoint else "application.yml"
            return pages(jobs(workflow, run(10 if workflow == "ci.yml" else 20, head_branch="main")))
        self.assertEqual(len(CI.verify(REPOSITORY, COMMIT, "main", fetch)), 2)
        with self.assertRaisesRegex(CI.AdmissionError, "No push CI run"):
            CI.verify(REPOSITORY, COMMIT, "main", lambda _: [{"workflow_runs": [run()]}])

    def test_concurrent_rerun_invalidates_previous_green_evidence(self):
        calls = 0
        def fetch(endpoint):
            nonlocal calls
            calls += 1
            if "/workflows/" in endpoint:
                return [{"workflow_runs": [run(attempt=2 if calls == 1 else 3)]}]
            return pages(jobs())
        with self.assertRaisesRegex(CI.AdmissionError, "re-run"):
            CI.verify(REPOSITORY, COMMIT, BRANCH, fetch)
        self.assertEqual(calls, 3)

    def test_invalid_identity_never_calls_github(self):
        def never(_endpoint):
            self.fail("Invalid identity must fail before contacting GitHub")
        for repository, commit, branch in [("bad/repo/extra", COMMIT, BRANCH),
                                           (REPOSITORY, "short", BRANCH),
                                           (REPOSITORY, COMMIT, "feature/0.1.5"),
                                           (REPOSITORY, COMMIT, "main\n"),
                                           (REPOSITORY, COMMIT, "release/0.1.4\n")]:
            with self.assertRaises(CI.AdmissionError):
                CI.verify(repository, commit, branch, never)

    def test_gh_api_requests_all_pages_and_uses_argument_vector(self):
        result = subprocess.CompletedProcess([], 0, json.dumps([{"workflow_runs": []}]))
        with mock.patch.object(CI.subprocess, "run", return_value=result) as process:
            self.assertEqual(CI.github_pages("repos/owner/repo/actions/runs?per_page=100"), [{"workflow_runs": []}])
        process.assert_called_once_with(
            ["gh", "api", "--paginate", "--slurp", "repos/owner/repo/actions/runs?per_page=100"],
            check=True, capture_output=True, text=True,
        )


class ManifestChannelTests(unittest.TestCase):
    def test_signer_refuses_prerelease_stable_output_before_reading_key(self):
        # A tiny real archive-shaped fixture exercises the production signer
        # CLI; refusal must happen before any output or signature is written.
        with tempfile.TemporaryDirectory(prefix="morphz-release-channel-") as directory:
            temporary = Path(directory)
            artifact = temporary / "edge.tar.gz"
            artifact.write_bytes(b"synthetic archive")
            output = temporary / "manifest.json"
            command = ["python3", str(ROOT / "scripts/edge/build_release_manifest.py"),
                       "--version", "0.1.4-rc.1+test", "--signing-key", str(temporary / "missing.pem"),
                       "--output", str(output), "--artifact",
                       f"linux=x86_64={artifact}=https://example.invalid/edge.tar.gz"]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("require --channel prerelease", result.stderr)
            self.assertFalse(output.exists())
            explicit = subprocess.run(command + ["--channel", "prerelease"], capture_output=True, text=True)
            self.assertNotEqual(explicit.returncode, 0)
            self.assertIn("under a prereleases directory", explicit.stderr)
            self.assertFalse(output.exists())

    def test_real_signer_keeps_stable_and_explicit_rc_manifests_separate(self):
        with tempfile.TemporaryDirectory(prefix="morphz-release-channel-") as directory:
            temporary = Path(directory)
            artifact = temporary / "edge.tar.gz"
            artifact.write_bytes(b"synthetic archive")
            private_key, public_key = temporary / "key.pem", temporary / "public.pem"
            subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout",
                            "-out", str(private_key)], check=True, capture_output=True)
            subprocess.run(["openssl", "ec", "-in", str(private_key), "-pubout", "-out", str(public_key)],
                           check=True, capture_output=True)
            def build(version, output, extra=()):
                return subprocess.run([
                    "python3", str(ROOT / "scripts/edge/build_release_manifest.py"),
                    "--version", version, "--signing-key", str(private_key), "--output", str(output),
                    "--artifact", f"linux=x86_64={artifact}=https://example.invalid/edge.tar.gz", *extra,
                ], capture_output=True, text=True)
            stable = temporary / "manifest.json"
            self.assertEqual(build("0.1.4", stable).returncode, 0)
            stable_bytes = stable.read_bytes()
            rc = temporary / "prereleases/0.1.4-rc.1/manifest.json"
            result = build("0.1.4-rc.1", rc, ["--channel", "prerelease"])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stable.read_bytes(), stable_bytes)
            self.assertEqual(json.loads(stable_bytes)["channel"], "stable")
            self.assertEqual(json.loads(rc.read_bytes())["channel"], "prerelease")
            subprocess.run(["openssl", "dgst", "-sha256", "-verify", str(public_key), "-signature",
                            str(rc) + ".sig", str(rc)], check=True, capture_output=True)
            # Directory traversal or a symlink named prereleases must not turn
            # explicit opt-in into permission to overwrite the stable path.
            traversal = temporary / "prereleases/../manifest.json"
            rejected = build("0.1.4-rc.2", traversal, ["--channel", "prerelease"])
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(stable.read_bytes(), stable_bytes)
            alias = temporary / "alias/prereleases"
            alias.parent.mkdir()
            alias.symlink_to(temporary, target_is_directory=True)
            rejected = build("0.1.4-rc.2", alias / "manifest.json", ["--channel", "prerelease"])
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(stable.read_bytes(), stable_bytes)


if __name__ == "__main__":
    unittest.main()
