"""Harbor agent that restores immutable file snapshots from a Morphz trial DB.

This agent performs no model calls.  It is used only for isolated, post-hoc
verifier recovery when the original shared Docker environment has already been
deleted by Harbor.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ReplaySnapshotAgent(BaseAgent):
    """Restore the final file_change snapshots recorded by Morphz."""

    def __init__(
        self,
        *args,
        source_db: str,
        expected_source_db_sha256: str,
        post_command: str | None = None,
        **kwargs,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.source_db = Path(source_db)
        self.expected_source_db_sha256 = expected_source_db_sha256
        self.post_command = post_command

    @staticmethod
    @override
    def name() -> str:
        return "replay-snapshot"

    @override
    def version(self) -> str:
        return "1.0.0"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        return None

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        actual_db_sha256 = _sha256(self.source_db)
        if actual_db_sha256 != self.expected_source_db_sha256:
            raise RuntimeError(
                "Source DB hash mismatch: "
                f"expected {self.expected_source_db_sha256}, got {actual_db_sha256}"
            )

        snapshots: dict[str, dict[str, object]] = {}
        connection = sqlite3.connect(f"file:{self.source_db}?mode=ro", uri=True)
        try:
            mutations = connection.execute(
                "SELECT tool_name, request_json FROM execution_jobs "
                "WHERE status = 'succeeded' AND tool_name IN ('write', 'edit') "
                "ORDER BY created_at, id"
            ).fetchall()
            file_changes = connection.execute(
                "SELECT payload FROM events WHERE type = 'file_change' "
                "ORDER BY timestamp, id"
            ).fetchall()
        finally:
            connection.close()

        final_hashes: dict[str, str] = {}
        for (raw_payload,) in file_changes:
            payload = json.loads(raw_payload)
            path = payload.get("path")
            after_sha256 = payload.get("after_sha256")
            if not isinstance(path, str) or not path.startswith("/app/"):
                raise RuntimeError(f"Unsafe or missing replay path: {path!r}")
            if payload.get("operation") == "delete":
                final_hashes.pop(path, None)
            elif isinstance(after_sha256, str):
                final_hashes[path] = after_sha256

        file_texts: dict[str, str] = {}
        for tool_name, raw_request in mutations:
            request = json.loads(raw_request)
            path = request.get("path")
            if not isinstance(path, str) or not path.startswith("/app/"):
                raise RuntimeError(f"Unsafe or missing mutation path: {path!r}")
            if tool_name == "write":
                content = request.get("content")
                if not isinstance(content, str):
                    raise RuntimeError(f"Write request has no text content for {path}")
                file_texts[path] = content
            elif tool_name == "edit":
                if path not in file_texts:
                    raise RuntimeError(f"Edit has no replayed base content for {path}")
                content = file_texts[path]
                expected = request.get("expected_sha256")
                if isinstance(expected, str):
                    observed = hashlib.sha256(content.encode("utf-8")).hexdigest()
                    if observed != expected:
                        raise RuntimeError(
                            f"Pre-edit hash mismatch for {path}: "
                            f"expected {expected}, got {observed}"
                        )
                for edit in request.get("edits", []):
                    old_text = edit.get("old_text")
                    new_text = edit.get("new_text")
                    if not isinstance(old_text, str) or not isinstance(new_text, str):
                        raise RuntimeError(f"Malformed edit request for {path}")
                    occurrences = content.count(old_text)
                    if occurrences != 1:
                        raise RuntimeError(
                            f"Edit for {path} expected one match, found {occurrences}"
                        )
                    content = content.replace(old_text, new_text, 1)
                file_texts[path] = content

        for path, text in file_texts.items():
            after_sha256 = final_hashes.get(path)
            if not isinstance(after_sha256, str):
                raise RuntimeError(f"No final file hash recorded for {path}")
            encoded = text.encode("utf-8")
            actual_text_sha256 = hashlib.sha256(encoded).hexdigest()
            if actual_text_sha256 != after_sha256:
                raise RuntimeError(
                    f"Snapshot hash mismatch for {path}: "
                    f"event {after_sha256}, text {actual_text_sha256}"
                )
            snapshots[path] = {
                "text": text,
                "sha256": after_sha256,
                "bytes": len(encoded),
            }

        if not snapshots:
            raise RuntimeError("Source trial contains no replayable file_change snapshots")

        manifest_files: list[dict[str, object]] = []
        with tempfile.TemporaryDirectory(prefix="harbor-replay-") as temp_dir:
            temp_root = Path(temp_dir)
            for index, (target_path, snapshot) in enumerate(sorted(snapshots.items())):
                local_path = temp_root / f"snapshot-{index}"
                local_path.write_text(str(snapshot["text"]), encoding="utf-8")
                await environment.exec(
                    command=f"mkdir -p {Path(target_path).parent}",
                    user="root",
                    timeout_sec=30,
                )
                await environment.upload_file(local_path, target_path)
                check = await environment.exec(
                    command=f"sha256sum {target_path}",
                    user="root",
                    timeout_sec=30,
                )
                observed = (check.stdout or "").split()[0] if check.return_code == 0 else ""
                if observed != snapshot["sha256"]:
                    raise RuntimeError(
                        f"Container snapshot hash mismatch for {target_path}: "
                        f"expected {snapshot['sha256']}, got {observed or 'missing'}"
                    )
                manifest_files.append(
                    {
                        "path": target_path,
                        "sha256": snapshot["sha256"],
                        "bytes": snapshot["bytes"],
                    }
                )

        if self.post_command:
            result = await environment.exec(
                command=self.post_command,
                cwd="/app",
                user="root",
                timeout_sec=900,
            )
            if result.return_code != 0:
                raise RuntimeError(
                    f"Post-replay command failed with code {result.return_code}: "
                    f"{(result.stderr or result.stdout or '')[-2000:]}"
                )

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "replay_manifest.json").write_text(
            json.dumps(
                {
                    "source_db": str(self.source_db),
                    "source_db_sha256": actual_db_sha256,
                    "files": manifest_files,
                    "post_command": self.post_command,
                    "model_calls": 0,
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
