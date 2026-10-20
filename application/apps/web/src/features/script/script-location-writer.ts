type Location = {
  productionId: string;
  itemId: string;
  view: "library" | "editor";
};
type Witness = { owner: string; instanceId: string; revision: number };

/** Serialize only this mounted workspace's explicit location choices. Advance
 * CAS only across our own confirmed receipts, never across another writer's
 * revision or a failed/unknown commit. The Host still checks every command. */
export function createScriptLocationWriter(ports: {
  current(): Witness | null;
  save(instanceId: string, revision: number, state: Location): Promise<unknown>;
}) {
  type Confirmed = { owner: string; instanceId: string; base: number; next: number };
  let tail: { owner: string; instanceId: string; promise: Promise<Confirmed | null> } | null = null;
  return (state: Location): Promise<unknown> => {
    const captured = ports.current();
    if (!captured) return Promise.resolve();
    const previous = tail?.owner === captured.owner && tail.instanceId === captured.instanceId
      ? tail.promise : null;
    const pending = (async (): Promise<Confirmed | null> => {
      const confirmed = previous ? await previous : null;
      const current = ports.current();
      if (
        !current ||
        current.owner !== captured.owner ||
        current.instanceId !== captured.instanceId
      ) return null; // Unmount, identity change or navigation retires queued work.
      const own = confirmed?.owner === captured.owner &&
        confirmed.instanceId === captured.instanceId ? confirmed : null;
      const expected = own?.next ?? captured.revision;
      const base = own?.base ?? captured.revision;
      if (
        captured.revision < base || captured.revision > expected ||
        current.revision < base || current.revision > expected
      ) throw new Error("应用窗口已变化，请刷新后重试。");
      await ports.save(captured.instanceId, expected, state);
      return { owner: captured.owner, instanceId: captured.instanceId, base, next: expected + 1 };
    })();
    tail = { owner: captured.owner, instanceId: captured.instanceId, promise: pending };
    const release = () => { if (tail?.promise === pending) tail = null; };
    void pending.then(release, release);
    return pending;
  };
}
