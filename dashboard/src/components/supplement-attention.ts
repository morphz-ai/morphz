/** Presentation only: no timer, transport, task state or draft mutation.
 * A React 19 callback ref owns its exact node and disposes both observers. */
export function observeSupplementAttention(node: HTMLButtonElement) {
  const doc = node.ownerDocument;
  let visible = false;
  const sync = () => {
    node.dataset.attentionMotion =
      visible && doc.visibilityState !== "hidden" ? "on" : "off";
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    sync();
  });
  observer.observe(node);
  doc.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    observer.disconnect();
    doc.removeEventListener("visibilitychange", sync);
    delete node.dataset.attentionMotion;
  };
}
