"""LongMemEval-V2 backend for a Morphz-style structured Context projection.

The adapter does not call an answer or retrieval model. Official trajectory
states become stable, source-linked Frames in one content-addressed SQLite/FTS
store. Each question receives an isolated logical Context that contains only
its official haystack trajectories. Query-time projection is deterministic;
the benchmark's fixed reader remains responsible for answering.

Production Runtime transactions are evaluated in ME-06. This adapter isolates
the external memory-representation and projection question.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from typing import Any

from memory_modules.memory import (
    Memory,
    MemoryConfig,
    MemoryContextItem,
    register_memory,
    require,
)


TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_./:@-]*", re.IGNORECASE)
STOPWORDS = frozenset(
    "a an and are as at be by can did do does for from had has have how i if in "
    "into is it its of on or our should that the their then there these they this "
    "to was what when where which who why will with you your".split()
)
GLOBAL_PREPARED_CACHE: dict[str, tuple["Frame", ...]] = {}
GLOBAL_CACHE_LOCK = threading.Lock()
GLOBAL_SQLITE_LOCK = threading.Lock()


def _tokens(text: str) -> list[str]:
    return [
        token.lower()
        for token in TOKEN_RE.findall(text)
        if token.lower() not in STOPWORDS
    ]


def _text(value: Any, limit: int | None = None) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        result = value
    else:
        result = json.dumps(value, ensure_ascii=False, sort_keys=True)
    return result if limit is None else result[:limit]


@dataclass(frozen=True)
class Frame:
    frame_id: str
    trajectory_id: str
    state_index: int
    goal: str
    outcome: str
    environment: str
    url: str
    action: str
    thought: str
    accessibility_tree: str
    source_ref: str


def _prepare_trajectory(trajectory: dict[str, object]) -> tuple[Frame, ...]:
    trajectory_id = str(trajectory.get("id", "")).strip()
    require(trajectory_id, "trajectory id must be non-empty")
    with GLOBAL_CACHE_LOCK:
        cached = GLOBAL_PREPARED_CACHE.get(trajectory_id)
    if cached is not None:
        return cached

    goal = _text(trajectory.get("goal"), 4_000)
    outcome = _text(trajectory.get("outcome"), 4_000)
    environment = _text(trajectory.get("environment"), 1_000)
    states_obj = trajectory.get("states", [])
    require(
        isinstance(states_obj, list),
        f"trajectory states must be a list: {trajectory_id}",
    )
    frames: list[Frame] = []
    for fallback_index, state_obj in enumerate(states_obj):
        if not isinstance(state_obj, dict):
            continue
        state_index_obj = state_obj.get("state_index", fallback_index)
        state_index = (
            state_index_obj if isinstance(state_index_obj, int) else fallback_index
        )
        digest = hashlib.sha256(
            f"{trajectory_id}:{state_index}".encode()
        ).hexdigest()[:20]
        frames.append(
            Frame(
                frame_id=f"lme-frame-{digest}",
                trajectory_id=trajectory_id,
                state_index=state_index,
                goal=goal,
                outcome=outcome,
                environment=environment,
                url=_text(state_obj.get("url"), 2_000),
                action=_text(state_obj.get("action"), 8_000),
                thought=_text(state_obj.get("thought"), 8_000),
                accessibility_tree=_text(state_obj.get("accessibility_tree")),
                source_ref=f"trajectory:{trajectory_id}:state:{state_index}",
            )
        )
    prepared = tuple(frames)
    with GLOBAL_CACHE_LOCK:
        GLOBAL_PREPARED_CACHE[trajectory_id] = prepared
    return prepared


@register_memory
class MorphzStructuredProjectionMemory(Memory):
    memory_type = "morphz_structured_projection"

    def __init__(self, memory_params: dict[str, object]) -> None:
        super().__init__(memory_params)
        workspace_dir = memory_params.get("workspace_dir")
        self.workspace_dir = (
            Path(workspace_dir).resolve() if isinstance(workspace_dir, str) else None
        )
        context_id = memory_params.get("context_id")
        self.context_id = context_id if isinstance(context_id, str) else None
        self.top_state_count = int(memory_params.get("top_state_count", 20))
        self.max_states_per_trajectory = int(
            memory_params.get("max_states_per_trajectory", 3)
        )
        self.snippet_token_count = int(memory_params.get("snippet_token_count", 192))
        require(self.top_state_count > 0, "top_state_count must be positive")
        require(
            self.max_states_per_trajectory > 0,
            "max_states_per_trajectory must be positive",
        )
        require(self.snippet_token_count > 0, "snippet_token_count must be positive")
        self.trajectory_frames: dict[str, tuple[Frame, ...]] = {}
        self.context_version = 0
        self.last_query_metadata: dict[str, object] = {}
        self._connection: sqlite3.Connection | None = None

    @property
    def memory_config(self) -> MemoryConfig:
        return {
            "memory_type": self.memory_type,
            "memory_params": {
                "top_state_count": self.top_state_count,
                "max_states_per_trajectory": self.max_states_per_trajectory,
                "snippet_token_count": self.snippet_token_count,
            },
        }

    def configure_runtime(self, **kwargs: object) -> None:
        if self.workspace_dir is None:
            workspace_dir = kwargs.get("workspace_dir")
            if isinstance(workspace_dir, (str, Path)):
                self.workspace_dir = Path(workspace_dir).resolve()

    def _ensure_store(self) -> None:
        query_id = self.get_query_context().get(
            "query_invocation_id", "unscoped-query"
        )
        if self.context_id is None:
            self.context_id = hashlib.sha256(query_id.encode()).hexdigest()[:24]
        if self.workspace_dir is None:
            configured_root = os.environ.get("MORPHZ_LME_WORKSPACE_ROOT")
            self.workspace_dir = (
                Path(configured_root).resolve()
                if configured_root
                else Path(tempfile.gettempdir()) / "morphz-lme-v2-contexts"
            )
        if self._connection is None:
            self.workspace_dir.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(
                self.workspace_dir / "morphz_context.sqlite", timeout=120
            )
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS frames (
                  frame_id TEXT PRIMARY KEY,
                  trajectory_id TEXT NOT NULL,
                  state_index INTEGER NOT NULL,
                  source_ref TEXT NOT NULL,
                  content_sha256 TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS frames_fts USING fts5(
                  frame_id UNINDEXED,
                  trajectory_id UNINDEXED,
                  goal,
                  outcome,
                  environment,
                  url,
                  action,
                  thought,
                  accessibility_tree,
                  tokenize='unicode61'
                );
                CREATE TABLE IF NOT EXISTS relations (
                  relation_id TEXT PRIMARY KEY,
                  from_frame TEXT NOT NULL,
                  to_frame TEXT NOT NULL,
                  relation_type TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS indexed_trajectories (
                  trajectory_id TEXT PRIMARY KEY,
                  frame_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS contexts (
                  context_id TEXT PRIMARY KEY,
                  context_version INTEGER NOT NULL,
                  query_invocation_sha256 TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS context_trajectories (
                  context_id TEXT NOT NULL,
                  trajectory_id TEXT NOT NULL,
                  context_version INTEGER NOT NULL,
                  PRIMARY KEY (context_id, trajectory_id)
                );
                """
            )
            self._connection.commit()
        self._persist_context(query_id)

    def _persist_context(self, query_id: str) -> None:
        require(self._connection is not None, "SQLite Context is not open")
        require(self.context_id is not None, "context_id is not initialized")
        query_hash = hashlib.sha256(query_id.encode()).hexdigest()
        with GLOBAL_SQLITE_LOCK, self._connection:
            self._connection.execute(
                "INSERT OR REPLACE INTO contexts VALUES (?, ?, ?)",
                (self.context_id, self.context_version, query_hash),
            )
            for trajectory_id, frames in self.trajectory_frames.items():
                self._connection.execute(
                    "INSERT OR REPLACE INTO context_trajectories VALUES (?, ?, ?)",
                    (self.context_id, trajectory_id, self.context_version),
                )
                already_indexed = self._connection.execute(
                    "SELECT 1 FROM indexed_trajectories WHERE trajectory_id = ?",
                    (trajectory_id,),
                ).fetchone()
                if already_indexed is None:
                    for frame in frames:
                        content_hash = hashlib.sha256(
                            (
                                frame.goal
                                + frame.outcome
                                + frame.environment
                                + frame.url
                                + frame.action
                                + frame.thought
                                + frame.accessibility_tree
                            ).encode()
                        ).hexdigest()
                        cursor = self._connection.execute(
                            "INSERT OR IGNORE INTO frames VALUES (?, ?, ?, ?, ?)",
                            (
                                frame.frame_id,
                                frame.trajectory_id,
                                frame.state_index,
                                frame.source_ref,
                                content_hash,
                            ),
                        )
                        if cursor.rowcount:
                            rowid = self._connection.execute(
                                "SELECT rowid FROM frames WHERE frame_id = ?",
                                (frame.frame_id,),
                            ).fetchone()[0]
                            self._connection.execute(
                                "INSERT INTO frames_fts(rowid, frame_id, trajectory_id, goal, "
                                "outcome, environment, url, action, thought, accessibility_tree) "
                                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                (
                                    rowid,
                                    frame.frame_id,
                                    frame.trajectory_id,
                                    frame.goal,
                                    frame.outcome,
                                    frame.environment,
                                    frame.url,
                                    frame.action,
                                    frame.thought,
                                    frame.accessibility_tree,
                                ),
                            )
                    for left, right in zip(frames, frames[1:]):
                        relation_id = hashlib.sha256(
                            f"{left.frame_id}:next:{right.frame_id}".encode()
                        ).hexdigest()[:24]
                        self._connection.execute(
                            "INSERT OR IGNORE INTO relations VALUES (?, ?, ?, 'next-state')",
                            (relation_id, left.frame_id, right.frame_id),
                        )
                    self._connection.execute(
                        "INSERT INTO indexed_trajectories VALUES (?, ?)",
                        (trajectory_id, len(frames)),
                    )

    def insert(self, trajectory: dict[str, object]) -> None:
        trajectory_id = str(trajectory.get("id", "")).strip()
        require(trajectory_id, "trajectory id must be non-empty")
        if trajectory_id in self.trajectory_frames:
            return None
        self.trajectory_frames[trajectory_id] = _prepare_trajectory(trajectory)
        self.context_version += 1
        return None

    def query(
        self, query: str, query_image: str | None = None
    ) -> list[MemoryContextItem]:
        require(isinstance(query, str) and query.strip(), "query must be non-empty")
        started = time.perf_counter()
        self._ensure_store()
        require(self._connection is not None, "SQLite Context is not open")
        require(self.context_id is not None, "context_id is not initialized")
        query_terms = list(dict.fromkeys(_tokens(query)))
        selected: list[sqlite3.Row] = []
        if query_terms and self.trajectory_frames:
            expression = " OR ".join(f'"{term}"' for term in query_terms)
            self._connection.row_factory = sqlite3.Row
            candidates = self._connection.execute(
                """
                SELECT f.frame_id, f.trajectory_id, f.state_index, f.source_ref,
                       frames_fts.goal AS goal,
                       frames_fts.outcome AS outcome,
                       frames_fts.action AS action,
                       frames_fts.thought AS thought,
                       bm25(frames_fts) AS rank,
                       snippet(frames_fts, 8, '', '', ' ... ', ?) AS tree_evidence
                FROM frames_fts
                JOIN frames f ON f.rowid = frames_fts.rowid
                JOIN context_trajectories c ON c.trajectory_id = f.trajectory_id
                WHERE frames_fts MATCH ? AND c.context_id = ?
                ORDER BY rank ASC, f.trajectory_id ASC, f.state_index ASC
                LIMIT ?
                """,
                (
                    self.snippet_token_count,
                    expression,
                    self.context_id,
                    self.top_state_count * 25,
                ),
            ).fetchall()
            per_trajectory: dict[str, int] = {}
            for row in candidates:
                trajectory_id = str(row["trajectory_id"])
                count = per_trajectory.get(trajectory_id, 0)
                if count >= self.max_states_per_trajectory:
                    continue
                selected.append(row)
                per_trajectory[trajectory_id] = count + 1
                if len(selected) >= self.top_state_count:
                    break

        context_frame_count = self._connection.execute(
            "SELECT COUNT(*) FROM frames f JOIN context_trajectories c "
            "ON c.trajectory_id = f.trajectory_id WHERE c.context_id = ?",
            (self.context_id,),
        ).fetchone()[0]
        relation_count = self._connection.execute(
            "SELECT COUNT(*) FROM relations r JOIN frames f ON f.frame_id = r.from_frame "
            "JOIN context_trajectories c ON c.trajectory_id = f.trajectory_id "
            "WHERE c.context_id = ?",
            (self.context_id,),
        ).fetchone()[0]
        items: list[MemoryContextItem] = []
        if selected:
            items.append(
                {
                    "type": "text",
                    "value": (
                        "## Morphz Structured Context Projection\n"
                        f"Context version: {self.context_version}; addressable frames: "
                        f"{context_frame_count}; projected frames: {len(selected)}. "
                        "Evidence remains source-linked and ordered.\n"
                    ),
                }
            )
        for index, row in enumerate(selected, start=1):
            items.append(
                {
                    "type": "text",
                    "value": (
                        f"### Frame {index}: {row['frame_id']}\n"
                        f"- source_ref: {row['source_ref']}\n"
                        f"- trajectory_id: {row['trajectory_id']}\n"
                        f"- state_index: {row['state_index']}\n"
                        f"- projection_rank: {float(row['rank']):.6f}\n"
                        f"- goal: {row['goal']}\n"
                        f"- outcome: {row['outcome']}\n"
                        f"- action: {row['action']}\n"
                        f"- thought: {row['thought']}\n"
                        f"- state_evidence:\n{row['tree_evidence']}\n"
                    ),
                }
            )
        self.last_query_metadata = {
            "context_id": self.context_id,
            "context_version": self.context_version,
            "trajectory_count": len(self.trajectory_frames),
            "frame_count": context_frame_count,
            "relation_count": relation_count,
            "selected_frame_count": len(selected),
            "selected_source_refs": [str(row["source_ref"]) for row in selected],
            "query_image_present": query_image is not None,
            "query_seconds": time.perf_counter() - started,
            "adapter_boundary": (
                "deterministic SQLite/FTS structured Frame projection; production "
                "Runtime transactions are measured in ME-06"
            ),
        }
        return items

    def post_query_hook(
        self,
        *,
        query: str,
        query_image: str | None,
        memory_context: list[MemoryContextItem],
    ) -> dict[str, object] | None:
        return dict(self.last_query_metadata)

    def _save_backend(self, output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        if self._connection is not None:
            target = sqlite3.connect(output_dir / "morphz_context.sqlite")
            with target:
                self._connection.backup(target)
            target.close()
        (output_dir / "structured_context_manifest.json").write_text(
            json.dumps(
                {
                    "context_id": self.context_id,
                    "context_version": self.context_version,
                    "frame_count": sum(
                        len(frames) for frames in self.trajectory_frames.values()
                    ),
                    "trajectory_ids": sorted(self.trajectory_frames),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
