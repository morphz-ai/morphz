import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/components/SiteMotion.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});

function element(selectors, reading = false) {
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    style: { setProperty() {}, removeProperty() {} },
    parentElement: null,
    matches: (query) => query.split(",").some((selector) => selectors.includes(selector.trim())),
    closest: (query) => reading && /blog-article__layout|doc-prose/.test(query) ? {} : null,
  };
}

// Exercise the actual React effect with observer callbacks under test control.
// No callbacks fire automatically: reading must work even if none arrive.
function mount({ reduced = false, missingObserver } = {}) {
  const root = element([]);
  const heading = element([".blog-article__header > *"]);
  const layout = element([".blog-article__layout"], true);
  const paragraph = element([".doc-prose > *"], true);
  const table = element([".doc-prose > *"], true);
  const hero = element([".home-hero__preview"]);
  const elements = [heading, layout, paragraph, table, hero];
  const observed = new Set();
  const listeners = new Map();
  let effect;
  let notifyIntersection;
  let notifyMutation;
  let observerOptions;
  let disconnected = false;
  const scope = {
    exports: {},
    require: (name) => {
      assert.equal(name, "react");
      return { useEffect: (callback) => { effect = callback; } };
    },
    document: {
      documentElement: root,
      body: {},
      querySelectorAll: (selector) => elements.filter((candidate) => candidate.matches(selector)),
    },
    window: {
      matchMedia: () => ({ matches: reduced }),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
    },
    IntersectionObserver: class {
      constructor(callback, options) { notifyIntersection = callback; observerOptions = options; }
      observe(target) { observed.add(target); }
      unobserve(target) { observed.delete(target); }
      disconnect() { disconnected = true; observed.clear(); }
    },
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback; }
      observe() {}
      disconnect() { notifyMutation = undefined; }
    },
  };
  if (missingObserver) scope[missingObserver] = undefined;
  runInNewContext(outputText, scope);
  scope.exports.SiteMotion();
  const cleanup = effect();
  return {
    root, heading, layout, paragraph, table, hero, observed, observerOptions, listeners, cleanup,
    notify: (entries) => notifyIntersection(entries),
    disconnected: () => disconnected,
    observesMutations: () => typeof notifyMutation === "function",
  };
}

test("long articles and document bodies never wait for a reveal callback", () => {
  const motion = mount();
  assert.ok(motion.root.classList.contains("motion-ready"));
  for (const content of [motion.layout, motion.paragraph, motion.table]) {
    assert.equal(content.classList.contains("motion-reveal"), false);
    assert.equal(motion.observed.has(content), false);
  }
  // Keep the site's existing presentation animation for non-reading surfaces.
  assert.ok(motion.observed.has(motion.hero));
  assert.ok(motion.hero.classList.contains("motion-reveal"));
  motion.cleanup();
});

test("remaining reveals trigger on entry regardless of element height", () => {
  const motion = mount();
  assert.equal(motion.observerOptions.threshold, 0);
  motion.notify([{ target: motion.hero, isIntersecting: false, intersectionRatio: 0 }]);
  assert.equal(motion.hero.classList.contains("is-visible"), false);
  // A mobile viewport can expose much less than 8% of a tall section.
  motion.notify([{ target: motion.hero, isIntersecting: true, intersectionRatio: 0.001 }]);
  assert.ok(motion.hero.classList.contains("is-visible"));
  assert.equal(motion.observed.has(motion.hero), false);
  motion.cleanup();
  assert.ok(motion.disconnected());
  assert.equal(motion.observesMutations(), false);
  assert.equal(motion.listeners.size, 0);
  assert.equal(motion.root.classList.contains("motion-ready"), false);
});

for (const missingObserver of ["IntersectionObserver", "MutationObserver"]) {
  test(`keeps server-rendered content visible without ${missingObserver}`, () => {
    const motion = mount({ missingObserver });
    assert.equal(motion.root.classList.contains("motion-ready"), false);
    assert.equal(motion.heading.classList.contains("motion-reveal"), false);
    assert.equal(motion.observed.size, 0);
  });
}

test("reduced motion keeps content visible without registering observers", () => {
  const motion = mount({ reduced: true });
  assert.ok(motion.root.classList.contains("motion-reduced"));
  assert.equal(motion.root.classList.contains("motion-ready"), false);
  assert.equal(motion.observed.size, 0);
  motion.cleanup();
  assert.equal(motion.root.classList.contains("motion-reduced"), false);
});
