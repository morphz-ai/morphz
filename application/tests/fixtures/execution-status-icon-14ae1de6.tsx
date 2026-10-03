// Fixed 14ae1de6 originals: ExecutionSidebar's row and ExecutionDialog's group
// map/ternary, plus RunningActivityIcon's body. Only the surrounding status
// binding is adapted. No new production icon is used as an oracle.
/** @jsxRuntime classic */
import React from "react";
import {
  Activity,
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock3,
  Pause,
} from "lucide-react";

export type FixedKind =
  | "running"
  | "waiting"
  | "paused"
  | "ended"
  | "failed"
  | "cancelled"
  | "unknown";

export function FixedSidebarGlyph({ kind }: { kind: FixedKind }) {
  const status = { kind };
  const Icon = {
    running: Activity,
    waiting: Clock3,
    paused: Pause,
    ended: CircleCheck,
    failed: CircleX,
    cancelled: CircleSlash,
    unknown: CircleHelp,
  }[status.kind];
  return status.kind === "running" ? (
    <RunningActivityIcon />
  ) : (
    <Icon size={19} aria-hidden="true" />
  );
}

export function FixedDialogGlyph({ kind }: { kind: FixedKind | undefined }) {
  const status = kind === undefined ? undefined : { kind };
  const Icon = status
    ? {
        running: Activity,
        waiting: Clock3,
        paused: Pause,
        ended: CircleCheck,
        failed: CircleX,
        cancelled: CircleSlash,
        unknown: CircleHelp,
      }[status.kind]
    : CircleHelp;
  return status?.kind === "running" ? (
    <RunningActivityIcon />
  ) : (
    <Icon size={18} aria-hidden="true" />
  );
}

export function RunningActivityIcon() {
  const path =
    "M2 12h2.49a2 2 0 0 0 1.92-1.46l2.35-8.36a.25.25 0 0 1 .48 0l5.52 19.64a.25.25 0 0 0 .48 0l2.35-8.36A2 2 0 0 1 19.52 12H22";
  return (
    <svg
      className="execution-running-signal"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path className="execution-signal-base" d={path} />
      <path className="execution-signal-flow" d={path} pathLength="100" />
    </svg>
  );
}
