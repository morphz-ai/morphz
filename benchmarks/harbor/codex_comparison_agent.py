"""Integrity-preserving wrapper around Harbor's official Codex CLI agent."""

from __future__ import annotations

from typing import override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmarks.harbor.benchmark_integrity import append_integrity_policy


class IntegrityCodex(Codex):
    """Run the unmodified official Codex CLI with the shared task policy.

    The wrapper changes no Codex prompt or execution behavior beyond appending
    the same anti-cheating and finite-execution policy used by the Morphz arms.
    Harbor's Codex implementation remains responsible for installation,
    full-access execution and ATIF trajectory projection.
    """

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(append_integrity_policy(instruction), environment, context)
