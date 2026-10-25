import assert from "node:assert/strict";
import test from "node:test";
import { observeSupplementAttention as desktop } from "../apps/web/src/supplement-attention.js";
import { observeSupplementAttention as dashboard } from "../../dashboard/src/components/supplement-attention.js";

for (const [name, observe] of [
  ["Desktop", desktop],
  ["Dashboard", dashboard],
] as const) {
  test(`${name} attention follows visibility events and releases its exact node without polling`, () => {
    const previous = globalThis.IntersectionObserver;
    let callback: IntersectionObserverCallback;
    let target: Element | undefined;
    let disconnected = false;
    class Observer {
      constructor(value: IntersectionObserverCallback) {
        callback = value;
      }
      observe(node: Element) {
        target = node;
      }
      disconnect() {
        disconnected = true;
      }
    }
    globalThis.IntersectionObserver =
      Observer as unknown as typeof IntersectionObserver;
    try {
      const doc = new EventTarget() as Document;
      Object.defineProperty(doc, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      const node = { ownerDocument: doc, dataset: {} } as HTMLButtonElement;
      const dispose = observe(node);
      assert.equal(target, node);
      assert.equal(node.dataset.attentionMotion, "off");
      callback!(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
      assert.equal(node.dataset.attentionMotion, "on");
      Object.defineProperty(doc, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      doc.dispatchEvent(new Event("visibilitychange"));
      assert.equal(node.dataset.attentionMotion, "off");
      Object.defineProperty(doc, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      doc.dispatchEvent(new Event("visibilitychange"));
      assert.equal(node.dataset.attentionMotion, "on");
      callback!(
        [{ isIntersecting: false }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
      assert.equal(node.dataset.attentionMotion, "off");
      dispose();
      assert.equal(disconnected, true);
      assert.equal(node.dataset.attentionMotion, undefined);
      doc.dispatchEvent(new Event("visibilitychange"));
      assert.equal(
        node.dataset.attentionMotion,
        undefined,
        "disposed listeners never touch a retired node",
      );
    } finally {
      globalThis.IntersectionObserver = previous;
    }
  });
}
