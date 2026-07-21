"""Harbor custom-agent adapter for a persistent Morphz Runtime.

Harbor's ordinary installed-agent contract ends when the agent CLI returns.
Morphz may reply while persistent Objectives continue, so this adapter keeps the
line-mode Runtime alive and watches its authoritative SQLite control state before
returning control to Harbor's verifier.
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class MorphzAgent(BaseAgent):
    SUPPORTS_ATIF = False
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

    async def setup(self, environment: BaseEnvironment) -> None:
        binary = Path(self._setting("MORPHZ_HARBOR_BINARY")).expanduser().resolve()
        if not binary.is_file():
            raise FileNotFoundError(f"MORPHZ_HARBOR_BINARY does not exist: {binary}")

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

        config = self.logs_dir / "morphz-harbor.toml"
        config.write_text(
            "\n".join(
                [
                    '[llm]',
                    'provider = "harbor"',
                    f'model = {model!r}',
                    '',
                    '[providers.harbor]',
                    f'protocol = {protocol!r}',
                    f'base_url = {base_url!r}',
                    'credential = "harbor"',
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
                ]
            )
        )
        runner = Path(__file__).with_name("run_morphz_harbor.sh")
        await environment.upload_file(binary, "/tmp/morphz")
        await environment.upload_file(config, "/tmp/morphz-harbor.toml")
        await environment.upload_file(runner, "/tmp/run-morphz-harbor.sh")
        result = await environment.exec(
            command="chmod 0755 /tmp/morphz /tmp/run-morphz-harbor.sh"
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or "failed to install Morphz")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        instruction_path = self.logs_dir / "instruction.md"
        instruction_path.write_text(instruction)
        await environment.upload_file(instruction_path, "/tmp/morphz-instruction.md")

        session_id = str(self.session_id or "harbor-session")
        context_id = str(self.context_id or "harbor-context")
        credential_env = self._setting(
            "MORPHZ_PROVIDER_API_KEY_ENV", "MORPHZ_PROVIDER_API_KEY"
        )
        credential = self._setting(credential_env)
        env = {
            credential_env: credential,
            "MORPHZ_SESSION_ID": session_id,
            "MORPHZ_CONTEXT_ID": context_id,
            "MORPHZ_WORKSPACE_ROOT": "/app",
            "MORPHZ_ARTIFACT_DIR": "/logs/artifacts",
            "MORPHZ_STORAGE_SQLITE_PATH": "/logs/agent/morphz.db",
            "MORPHZ_CODING_EVAL_MODE": "true",
            "MORPHZ_PERMISSION_MODE": "auto_review",
            "MORPHZ_EXEC_NETWORK": "false",
            "MORPHZ_HARBOR_TIMEOUT_SECS": self._setting(
                "MORPHZ_HARBOR_TIMEOUT_SECS", "21600"
            ),
        }
        result = await environment.exec(
            command="/tmp/run-morphz-harbor.sh",
            env=env,
        )
        if result.return_code != 0:
            raise RuntimeError(
                "Morphz Harbor run failed: "
                + (result.stderr or result.stdout or f"exit {result.return_code}")[-4000:]
            )
