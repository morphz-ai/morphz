import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mathScope = { exports: {} };
runInNewContext(await compile("../lib/butterfly-motion.ts"), mathScope);
const { arrivalFrame, butterflyWingPath, cyanStop, ARRIVAL_DELAY, ARRIVAL_DURATION } = mathScope.exports;
const component = await compile("../app/components/ButterflyArrival.tsx");
const geometry = { x: 54, y: 36, size: 28, hoverX: 232, hoverY: 134, hoverSize: 88, travel: 235 };

test("the butterfly morph ends at the exact M outline, with a continuous wing", () => {
  assert.match(butterflyWingPath(0), /^M26\.000 26\.000/);
  const end = butterflyWingPath(1);
  const numbers = end.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const endpoints = [[numbers[0], numbers[1]]];
  for (let i = 2; i < numbers.length; i += 6) endpoints.push([numbers[i + 4], numbers[i + 5]]);
  const expected = [[8, 4], [8, 92], [38, 70], [38, 40], [48, 40], [30, 23.8], [8, 4]];
  expected.forEach((point, i) => point.forEach((value, j) => assert.ok(Math.abs(endpoints[i][j] - value * 8 / 3) < .001)));
  for (let t = 0; t <= 1; t += .01) {
    const path = butterflyWingPath(t);
    assert.equal((path.match(/C/g) || []).length, 6);
    assert.doesNotMatch(path, /NaN|Infinity/);
  }
  assert.equal(butterflyWingPath(-1), butterflyWingPath(0));
  assert.equal(butterflyWingPath(2), end);
});

test("arrival stages join continuously and land at the real header dimensions", () => {
  for (const boundary of [900, 1550, 2200, 3050]) {
    const a = arrivalFrame(boundary - .001, geometry), b = arrivalFrame(boundary, geometry);
    for (const key of ["x", "y", "size", "morph", "flutter", "angle"]) assert.ok(Math.abs(a[key] - b[key]) < .001, key);
  }
  const final = arrivalFrame(ARRIVAL_DURATION, geometry);
  assert.equal(final.x, geometry.x);
  assert.equal(final.y, geometry.y);
  assert.equal(final.size, 28);
  assert.equal(final.morph, 1);
  assert.equal(final.flutter, 1);
  assert.equal(final.detailOpacity, 0);
  assert.equal(cyanStop([181, 247, 244], 1), "rgb(86,208,222)");
});

function harness({ reduced = false, hidden = false, scrollY = 0, missingTarget = false } = {}) {
  let effect, nextId = 0;
  const frames = new Map(), timers = new Map();
  const events = { window: new Map(), document: new Map(), media: new Map() };
  const eventTarget = (name) => ({
    addEventListener: (type, callback) => events[name].set(type, callback),
    removeEventListener: (type) => events[name].delete(type),
  });
  const svg = () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const pieces = {
    "[data-arrival-wing]": [svg(), svg()],
    "[data-arrival-upper]": [svg(), svg()],
    "[data-arrival-detail]": [svg(), svg(), svg(), svg(), svg()],
    "[data-arrival-lower]": [svg(), svg()],
    "[data-arrival-stop]": [svg(), svg(), svg()],
  };
  const root = { style: {}, dataset: {}, querySelectorAll: (selector) => pieces[selector] };
  const target = { style: {}, getBoundingClientRect: () => ({ left: 40, top: 22, width: 28, bottom: 50 }), parentElement: { getBoundingClientRect: () => ({ right: 146 }) } };
  const media = { ...eventTarget("media"), matches: reduced };
  const scope = {
    exports: {},
    require: (name) => {
      if (name === "react") return { useEffect: (fn) => { effect = fn; }, useRef: () => ({ current: root }) };
      if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
      if (name === "@/lib/butterfly-motion") return mathScope.exports;
      throw new Error(`Unexpected import ${name}`);
    },
    document: {
      ...eventTarget("document"), hidden,
      querySelector: (selector) => selector === ".site-header .brand__icon" ? (missingTarget ? null : target) : { getBoundingClientRect: () => ({ bottom: 72 }) },
    },
    window: {
      ...eventTarget("window"), scrollY, innerWidth: 1280,
      matchMedia: () => media,
      requestAnimationFrame: (fn) => { frames.set(++nextId, fn); return nextId; },
      cancelAnimationFrame: (id) => frames.delete(id),
      setTimeout: (fn) => { timers.set(++nextId, fn); return nextId; },
      clearTimeout: (id) => timers.delete(id),
    },
  };
  runInNewContext(component, scope);
  const mount = () => { scope.exports.ButterflyArrival({ locale: "zh" }); return effect(); };
  return {
    root, target, pieces, frames, timers, events, mount,
    tick: (time) => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(time)); },
    emit: (type, where = "window") => events[where].get(type)?.({ type }),
  };
}

test("the real arrival effect plays once and cleans up after settling", () => {
  const h = harness();
  h.mount();
  h.tick(0);
  for (const [time, phase] of [[500, "flight"], [1000, "hover"], [1800, "morph"], [2500, "landing"]]) {
    h.tick(time + ARRIVAL_DELAY);
    assert.equal(h.root.dataset.arrivalState, phase);
  }
  h.tick(ARRIVAL_DELAY + ARRIVAL_DURATION);
  assert.equal(h.root.style.opacity, "0");
  assert.equal(h.root.dataset.arrivalState, "done");
  assert.equal(h.frames.size + h.timers.size, 0);
  assert.equal(Object.values(h.events).reduce((sum, e) => sum + e.size, 0), 0);
  assert.deepEqual(h.target.style, {}, "the real mark is never hidden or changed");
  assert.equal(h.mount(), undefined, "client navigation must not replay it");
});

for (const event of ["pointerdown", "wheel", "touchstart", "keydown", "scroll", "resize", "visibilitychange", "change"]) {
  test(`arrival immediately releases resources on ${event}`, () => {
    const h = harness(); h.mount(); h.tick(0); h.tick(950);
    h.emit(event, event === "visibilitychange" ? "document" : event === "change" ? "media" : "window");
    assert.equal(h.root.style.opacity, "0");
    assert.equal(h.root.dataset.arrivalEnd, event);
    assert.equal(h.frames.size + h.timers.size, 0);
    assert.equal(Object.values(h.events).reduce((sum, e) => sum + e.size, 0), 0);
  });
}

for (const options of [{ reduced: true }, { hidden: true }, { scrollY: 200 }, { missingTarget: true }]) {
  test(`arrival leaves the static page alone: ${JSON.stringify(options)}`, () => {
    const h = harness(options);
    assert.equal(h.mount(), undefined);
    assert.equal(h.frames.size + h.timers.size, 0);
    assert.deepEqual(h.target.style, {});
  });
}

test("Strict Mode trial cleanup does not consume the welcome", () => {
  const h = harness();
  const cleanup = h.mount(); cleanup();
  assert.equal(h.frames.size, 0);
  h.mount(); h.tick(0); h.tick(950);
  assert.equal(h.root.dataset.arrivalState, "flight");
});

test("a fail-safe hides decoration even if rendering stops delivering frames", () => {
  const h = harness(); h.mount(); h.tick(0); h.tick(950);
  [...h.timers.values()].forEach((fn) => fn());
  assert.equal(h.root.style.opacity, "0");
  assert.equal(h.frames.size + h.timers.size, 0);
});

test("arrival styles cannot capture input and reduced motion remains static", async () => {
  const css = await readFile(new URL("../app/brand-motion.css", import.meta.url), "utf8");
  assert.match(css, /\.butterfly-arrival\s*\{[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.butterfly-arrival \{ display: none; \}/);
});
