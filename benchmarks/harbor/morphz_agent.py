"""Harbor custom-agent adapter for a persistent Morphz Runtime.

Harbor's ordinary installed-agent contract ends when the agent CLI returns.
Morphz may reply while persistent Objectives continue, so this adapter keeps the
line-mode Runtime alive and watches its authoritative SQLite control state before
returning control to Harbor's verifier.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shlex
import sqlite3
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmarks.harbor.benchmark_integrity import (
    append_integrity_policy,
    audit_trajectory,
)
from benchmarks.harbor.morphz_atif import write_trajectory


HARNESS_MODE_BOUND = "bound"
HARNESS_MODE_NONE = "none"
PROMPT_CACHE_STRATEGIES = {
    "auto",
    "disabled",
    "implicit-prefix",
    "implicit-content-boundaries",
    "implicit-message-boundaries",
    "experimental-structured-deltas",
    "explicit-content-boundaries",
}
CONTEXT_STORES = {"legacy", "contextdb"}


class MorphzAgent(BaseAgent):
    SUPPORTS_ATIF = True
    SUPPORTS_RESUME = False

    @staticmethod
    def name() -> str:
        return "morphz"

    def version(self) -> str | None:
        return os.environ.get("MORPHZ_HARBOR_VERSION")

    def _setting(self, name: str, default: str | None = None) -> str:
        value = self.extra_env.get(name) or os.environ.get(name) or default
        if value is None or not value.strip():
            raise ValueError(f"Morphz Harbor adapter requires {name}")
        return value.strip()

    async def _resolve_workspace_root(self, environment: BaseEnvironment) -> str:
        configured = self.extra_env.get(
            "MORPHZ_HARBOR_WORKSPACE_ROOT"
        ) or os.environ.get("MORPHZ_HARBOR_WORKSPACE_ROOT")
        if configured is not None and configured.strip():
            workspace_root = configured.strip()
        else:
            result = await environment.exec(
                command="if [ -d /app ]; then printf '%s\\n' /app; else pwd -P; fi"
            )
            if result.return_code != 0:
                raise RuntimeError(
                    "failed to discover the Harbor task workspace: "
                    + (result.stderr or result.stdout or f"exit {result.return_code}")
                )
            workspace_root = result.stdout.strip()
        if not workspace_root or "\n" in workspace_root:
            raise ValueError("Harbor task workspace discovery returned no unique path")
        if not Path(workspace_root).is_absolute():
            raise ValueError(
                "MORPHZ_HARBOR_WORKSPACE_ROOT must be an absolute path, got "
                f"{workspace_root!r}"
            )
        return workspace_root

    async def setup(self, environment: BaseEnvironment) -> None:
        binary = Path(self._setting("MORPHZ_HARBOR_BINARY")).expanduser().resolve()
        if not binary.is_file():
            raise FileNotFoundError(f"MORPHZ_HARBOR_BINARY does not exist: {binary}")
        watcher = Path(
            self._setting(
                "MORPHZ_HARBOR_WATCHER",
                str(binary.with_name("morphz-harbor-wait")),
            )
        ).expanduser().resolve()
        if not watcher.is_file():
            raise FileNotFoundError(f"MORPHZ_HARBOR_WATCHER does not exist: {watcher}")
        harness_mode = self._setting("MORPHZ_HARNESS_MODE", HARNESS_MODE_NONE)
        if harness_mode not in {HARNESS_MODE_BOUND, HARNESS_MODE_NONE}:
            raise ValueError(
                "MORPHZ_HARNESS_MODE must be `bound` or `none`, got "
                f"{harness_mode!r}"
            )
        harness: Path | None = None
        if harness_mode == HARNESS_MODE_BOUND:
            harness = Path(
                self._setting("MORPHZ_HARBOR_HARNESS")
            ).expanduser().resolve()
            if not harness.is_file():
                raise FileNotFoundError(
                    f"MORPHZ_HARBOR_HARNESS does not exist: {harness}"
                )
            expected_harness_sha256 = self._setting("MORPHZ_HARNESS_SOURCE_SHA256")
            actual_harness_sha256 = hashlib.sha256(harness.read_bytes()).hexdigest()
            if actual_harness_sha256 != expected_harness_sha256:
                raise ValueError(
                    "Terminal-Bench Harness source digest mismatch: "
                    f"expected {expected_harness_sha256}, got {actual_harness_sha256}"
                )
            harness_ref = self._setting("MORPHZ_HARNESS_REF")
            if "@" not in harness_ref:
                raise ValueError(
                    "MORPHZ_HARNESS_REF must identify an exact installed package "
                    "as id@version"
                )

        protocol = self._setting("MORPHZ_PROVIDER_PROTOCOL", "openai-responses")
        base_url = self._setting("MORPHZ_PROVIDER_BASE_URL")
        configured_model = self.extra_env.get("MORPHZ_PROVIDER_MODEL") or os.environ.get(
            "MORPHZ_PROVIDER_MODEL"
        )
        model = configured_model or (self.model_name or "").split("/", maxsplit=1)[-1]
        if not model:
            raise ValueError("Morphz Harbor adapter requires a model")
        credential_env = self._setting(
            "MORPHZ_PROVIDER_API_KEY_ENV", "MORPHZ_PROVIDER_API_KEY"
        )
        reasoning_effort = self._setting("MORPHZ_REASONING_EFFORT", "max")
        if reasoning_effort != "max":
            raise ValueError(
                "The frozen benchmark profile requires MORPHZ_REASONING_EFFORT=max"
            )
        prompt_cache_strategy = self._setting(
            "MORPHZ_PROMPT_CACHE_STRATEGY", "auto"
        )
        if prompt_cache_strategy not in PROMPT_CACHE_STRATEGIES:
            raise ValueError(
                "MORPHZ_PROMPT_CACHE_STRATEGY must be one of: "
                + ", ".join(sorted(PROMPT_CACHE_STRATEGIES))
            )
        context_store = self._setting("MORPHZ_CONTEXT_STORE", "legacy")
        if context_store not in CONTEXT_STORES:
            raise ValueError(
                "MORPHZ_CONTEXT_STORE must be one of: "
                + ", ".join(sorted(CONTEXT_STORES))
            )

        config = self.logs_dir / "morphz-harbor.toml"
        config_lines = [
                    '[llm]',
                    'provider = "harbor"',
                    f'model = {model!r}',
                    f'reasoning_effort = {reasoning_effort!r}',
                    '',
                    '[providers.harbor]',
                    f'protocol = {protocol!r}',
                    f'base_url = {base_url!r}',
                    'credential = "harbor"',
                    '',
                    f'[providers.harbor.models.{model!r}]',
                    f'prompt_cache_strategy = {prompt_cache_strategy!r}',
                    '',
                    '[credentials.harbor]',
                    'source = "env"',
                    f'name = {credential_env!r}',
                    '',
                    '[orchestrator]',
                    'model_provider_max_in_flight = 8',
                    'context_soft_token_limit = 196608',
                    'context_hard_token_limit = 262144',
                    'context_maintenance_reserve_tokens = 32768',
                    '',
                    '[orchestrator.activation_admission]',
                    'max_in_flight = 16',
                    '',
                    '[permissions]',
                    'mode = "full_access"',
                    'shell_environment_policy = "remove_sensitive"',
                    '',
                ]
        if context_store == "contextdb":
            config_lines.extend(
                [
                    '[experimental]',
                    'enabled = ["context-db"]',
                    '',
                ]
            )
        config.write_text("\n".join(config_lines))
        runner = Path(__file__).with_name("run_morphz_harbor.sh")
        await environment.upload_file(binary, "/tmp/morphz")
        await environment.upload_file(watcher, "/tmp/morphz-harbor-wait")
        if harness is not None:
            await environment.upload_file(harness, "/tmp/morphz-harness.hns")
        await environment.upload_file(config, "/tmp/morphz-harbor.toml")
        await environment.upload_file(runner, "/tmp/run-morphz-harbor.sh")
        result = await environment.exec(
            command="chmod 0755 /tmp/morphz /tmp/morphz-harbor-wait /tmp/run-morphz-harbor.sh"
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or "failed to install Morphz")
        if context_store == "contextdb":
            result = await environment.exec(
                command=(
                    "/tmp/morphz --config-file /tmp/morphz-harbor.toml "
                    "experiment check context-db --format=json"
                )
            )
            if result.return_code != 0:
                raise RuntimeError(
                    "ContextDB benchmark binary/config preflight failed: "
                    + (result.stderr or result.stdout or f"exit {result.return_code}")
                )

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction = append_integrity_policy(instruction)
        instruction_path = self.logs_dir / "instruction.md"
        instruction_path.write_text(instruction)
        await environment.upload_file(instruction_path, "/tmp/morphz-instruction.md")

        session_id = str(self.session_id or "harbor-session")
        context_id = str(self.context_id or "harbor-context")
        credential_env = self._setting(
            "MORPHZ_PROVIDER_API_KEY_ENV", "MORPHZ_PROVIDER_API_KEY"
        )
        credential = self._setting(credential_env)
        workspace_root = await self._resolve_workspace_root(environment)
        env = {
            credential_env: credential,
            "MORPHZ_SESSION_ID": session_id,
            "MORPHZ_CONTEXT_ID": context_id,
            "MORPHZ_WORKSPACE_ROOT": workspace_root,
            "MORPHZ_ARTIFACT_DIR": "/logs/artifacts",
            "MORPHZ_STORAGE_SQLITE_PATH": "/logs/agent/morphz.db",
            "MORPHZ_CODING_EVAL_MODE": "true",
            "MORPHZ_PERMISSION_MODE": "full_access",
            "MORPHZ_HARNESS_MODE": self._setting(
                "MORPHZ_HARNESS_MODE", HARNESS_MODE_NONE
            ),
            "MORPHZ_HARBOR_TIMEOUT_SECS": self._setting(
                "MORPHZ_HARBOR_TIMEOUT_SECS", "21600"
            ),
        }
        if env["MORPHZ_HARNESS_MODE"] == HARNESS_MODE_BOUND:
            env["MORPHZ_HARNESS_REF"] = self._setting("MORPHZ_HARNESS_REF")
        try:
            result = await environment.exec(
                command="/tmp/run-morphz-harbor.sh",
                env=env,
            )
        except asyncio.CancelledError:
            # Harbor enforces the task deadline outside the custom Agent. A
            # cancelled `docker compose exec` does not reliably stop the shell
            # already running inside the task container. Quiesce Morphz before
            # Harbor starts the shared-environment verifier: preserve services
            # explicitly declared with keep_running, but terminate unfinished
            # transient commands so they cannot mutate the answer concurrently
            # with verification.
            try:
                await asyncio.shield(
                    environment.exec(
                        command="/tmp/run-morphz-harbor.sh --cancel",
                        env=env,
                        timeout_sec=15,
                    )
                )
            except BaseException as cleanup_error:
                self.logger.error(
                    "Failed to quiesce Morphz after Harbor cancellation: %s",
                    cleanup_error,
                )
            raise
        if result.return_code != 0:
            raise RuntimeError(
                "Morphz Harbor run failed: "
                + (result.stderr or result.stdout or f"exit {result.return_code}")[-4000:]
            )
        self._audit_context_store()

    def _audit_context_store(self) -> dict[str, object]:
        context_store = self._setting("MORPHZ_CONTEXT_STORE", "legacy")
        if context_store not in CONTEXT_STORES:
            raise ValueError(f"unsupported Context store arm: {context_store}")
        context_id = str(self.context_id or "harbor-context")
        authority_count = 0
        if context_store == "contextdb":
            db_path = self.logs_dir / "morphz.db"
            connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            try:
                row = connection.execute(
                    "SELECT COUNT(*) FROM experimental_contextdb_contexts "
                    "WHERE context_id = ?",
                    (context_id,),
                ).fetchone()
            except sqlite3.Error as error:
                raise RuntimeError(
                    "ContextDB benchmark arm did not expose its authoritative store"
                ) from error
            finally:
                connection.close()
            authority_count = int(row[0]) if row is not None else 0
            if authority_count != 1:
                raise RuntimeError(
                    "ContextDB benchmark arm did not persist exactly one authoritative "
                    f"row for Context {context_id!r}: {authority_count}"
                )
        audit = {
            "context_store": context_store,
            "context_id": context_id,
            "context_db_authority_count": authority_count,
        }
        (self.logs_dir / "context_store_audit.json").write_text(
            json.dumps(audit, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        return audit

    def populate_context_post_run(self, context: AgentContext) -> None:
        db_path = self.logs_dir / "morphz.db"
        instruction_path = self.logs_dir / "instruction.md"
        instruction = (
            instruction_path.read_text(encoding="utf-8")
            if instruction_path.is_file()
            else ""
        )
        configured_model = self.extra_env.get("MORPHZ_PROVIDER_MODEL") or os.environ.get(
            "MORPHZ_PROVIDER_MODEL"
        )
        configured_model = configured_model or (self.model_name or "").split("/", 1)[-1]
        trajectory = write_trajectory(
            db_path,
            self.logs_dir / "trajectory.json",
            instruction=instruction,
            session_id=str(self.session_id or "harbor-session"),
            context_id=str(self.context_id or "harbor-context"),
            agent_version=self.version() or "unknown",
            configured_model=configured_model or "unknown",
            reasoning_effort="max",
            permission_mode="full_access",
        )
        task_name = str(self.session_id or "harbor-task").split("__", maxsplit=1)[0]
        integrity = audit_trajectory(
            self.logs_dir / "trajectory.json",
            task_name=task_name,
            output_path=self.logs_dir / "benchmark_integrity.json",
        )
        context.metadata = {"benchmark_integrity": integrity}
        if trajectory.final_metrics is None:
            return
        metrics = trajectory.final_metrics
        context.n_input_tokens = metrics.total_prompt_tokens
        context.n_output_tokens = metrics.total_completion_tokens
        context.n_cache_tokens = metrics.total_cached_tokens
        context.cost_usd = metrics.total_cost_usd
