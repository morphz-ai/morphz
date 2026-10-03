/** Rearrange only the visible slots in the existing complete preference list.
 * Hidden/unauthorized/exact-version entries never become deletion candidates. */
export function placeDockApplication(
  saved: readonly string[],
  available: readonly string[],
  key: string,
  index: number,
) {
  const authorized = new Set(available);
  if (!authorized.has(key)) return [...saved];
  const visible = [...new Set(saved.filter((id) => authorized.has(id)))].filter(
    (id) => id !== key,
  );
  visible.splice(Math.max(0, Math.min(visible.length, index)), 0, key);
  let slot = 0;
  const result = saved.flatMap((id) =>
    authorized.has(id)
      ? slot < visible.length
        ? [visible[slot++]!]
        : []
      : [id],
  );
  return [...result, ...visible.slice(slot)];
}

export function removeDockApplication(saved: readonly string[], key: string) {
  return saved.filter((id) => id !== key);
}

export function sameDockOrder(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

export function dockMagnification(distance: number) {
  const proximity = Math.max(0, 1 - Math.abs(distance) / 52);
  return { scale: 1 + 0.38 * proximity * proximity, lift: 2 * proximity };
}
