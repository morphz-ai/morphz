// Screenshot preparation waits for guest visibility/authorization updates as
// well as the renderer paint, rather than guessing with a timeout.
const layouts = new Set<() => Promise<void>>();

export function registerNativeBrowserLayout(layout: () => Promise<void>) {
  layouts.add(layout);
  return () => {
    layouts.delete(layout);
  };
}

export async function syncNativeBrowserLayout() {
  await Promise.all([...layouts].map((layout) => layout()));
}
