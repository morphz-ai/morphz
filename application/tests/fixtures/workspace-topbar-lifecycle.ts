// Test-only lifecycle accounting. DOM portal targets can exist before React's
// passive effects register; that state must not be reported as fixture-ready.
export const topbarPortalNames = ["application", "page", "detail"] as const;
export type TopbarPortalName = (typeof topbarPortalNames)[number];

const zeroCounts = (): Record<TopbarPortalName, number> => ({
  application: 0,
  page: 0,
  detail: 0,
});

export function createTopbarPortalLifecycle() {
  const mounts = zeroCounts();
  const cleanups = zeroCounts();
  const active = zeroCounts();
  return {
    mount(name: TopbarPortalName) {
      mounts[name] += 1;
      active[name] += 1;
      return () => {
        cleanups[name] += 1;
        active[name] -= 1;
      };
    },
    ready(portalCount: number) {
      return (
        portalCount === topbarPortalNames.length &&
        topbarPortalNames.every((name) => active[name] === 1)
      );
    },
    report() {
      return { mounts: { ...mounts }, cleanups: { ...cleanups } };
    },
  };
}
