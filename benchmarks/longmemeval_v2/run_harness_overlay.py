#!/usr/bin/env python3
"""Register the Morphz overlay, then execute the pinned official harness."""

from typing import Any

import morphz_structured_projection  # noqa: F401
from evaluation import harness


_official_inject_runtime_memory_params = harness.inject_runtime_memory_params


def _inject_runtime_memory_params(
    memory_config: dict[str, Any], **kwargs: Any
) -> dict[str, Any]:
    runtime_config = _official_inject_runtime_memory_params(memory_config, **kwargs)
    if runtime_config["memory_type"] == "morphz_structured_projection":
        question_workspace = kwargs["workspace_dir"].resolve()
        runtime_config["memory_params"]["workspace_dir"] = str(
            question_workspace.parent
        )
        runtime_config["memory_params"]["context_id"] = question_workspace.name
    return runtime_config


harness.inject_runtime_memory_params = _inject_runtime_memory_params


if __name__ == "__main__":
    harness.main()
