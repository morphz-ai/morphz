import {
  CircleCheck,
  CircleHelp,
  CircleSlash,
  CircleX,
  Clock3,
  Pause,
} from "lucide-react";
import type { ActivityStatus } from "./execution-activity.js";
import { RunningActivityIcon } from "./RunningActivityIcon.js";

/** Shared Thread glyph only. Consumers retain authoritative state, labels and
 * their original outer span. Static list/detail sizes do not resize the running
 * waveform or turn message-delivery/Task/Job states into Thread state. */
export function ExecutionStatusIcon({
  kind,
  size,
}: Readonly<{
  kind: ActivityStatus["kind"] | undefined;
  size: 18 | 19;
}>) {
  if (kind === "running") return <RunningActivityIcon />;
  const Icon = {
    waiting: Clock3,
    paused: Pause,
    ended: CircleCheck,
    failed: CircleX,
    cancelled: CircleSlash,
    unknown: CircleHelp,
  }[kind ?? "unknown"];
  return <Icon size={size} aria-hidden="true" />;
}
