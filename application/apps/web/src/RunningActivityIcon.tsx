/** Same execution waveform in the activity list and each real Thread group.
 * Only the running state mounts its travelling signal; reduced motion keeps
 * the static base through the shared execution-activity stylesheet. */
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
