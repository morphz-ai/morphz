// Native pages live above the renderer. Screenshot preparation must wait for
// their layout IPC as well as the renderer paint, not guess with a timeout.
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
