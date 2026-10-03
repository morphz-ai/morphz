import test from "node:test";
import assert from "node:assert/strict";
import {
  dockMagnification,
  placeDockApplication,
  removeDockApplication,
  sameDockOrder,
} from "../apps/web/src/application-dock-interaction.js";

const available = ["first@1", "second@1", "third@2"];

test("Dock reorder preserves unavailable exact-version preferences and their slots", () => {
  const saved = ["first@1", "private@7", "second@1", "first@9", "third@2"];
  assert.deepEqual(placeDockApplication(saved, available, "third@2", 0), [
    "third@2",
    "private@7",
    "first@1",
    "first@9",
    "second@1",
  ]);
  assert.deepEqual(placeDockApplication(saved, available, "first@1", 2), [
    "second@1",
    "private@7",
    "third@2",
    "first@9",
    "first@1",
  ]);
  assert.deepEqual(saved, [
    "first@1",
    "private@7",
    "second@1",
    "first@9",
    "third@2",
  ]);
});
test("Launcher insertion is authorized, ordered and duplicate-free without losing hidden pins", () => {
  const saved = ["first@1", "private@7", "second@1"];
  assert.deepEqual(placeDockApplication(saved, available, "third@2", 1), [
    "first@1",
    "private@7",
    "third@2",
    "second@1",
  ]);
  assert.deepEqual(
    placeDockApplication(saved, available, "private@7", 0),
    saved,
  );
  assert.deepEqual(placeDockApplication([], available, "second@1", 20), [
    "second@1",
  ]);
  assert.deepEqual(
    placeDockApplication(
      ["first@1", "first@1", "private@7"],
      available,
      "first@1",
      0,
    ),
    ["first@1", "private@7"],
  );
});
test("Remove only the exact shortcut, never its hidden version or other preference", () => {
  assert.deepEqual(
    removeDockApplication(
      ["first@1", "private@7", "first@9", "second@1"],
      "first@1",
    ),
    ["private@7", "first@9", "second@1"],
  );
  assert.equal(sameDockOrder(["a", "b"], ["a", "b"]), true);
  assert.equal(sameDockOrder(["a", "b"], ["b", "a"]), false);
  assert.equal(sameDockOrder(["a"], ["a", "b"]), false);
});
test("Hover paint is bounded inside the unchanged 32px hit box and symmetric", () => {
  assert.deepEqual(dockMagnification(0), { scale: 1.38, lift: 2 });
  assert.deepEqual(dockMagnification(60), { scale: 1, lift: 0 });
  for (let distance = 0; distance <= 100; distance++) {
    const paint = dockMagnification(distance);
    assert.deepEqual(paint, dockMagnification(-distance));
    assert.ok(paint.scale >= 1 && paint.scale <= 1.38);
    assert.ok(16 - paint.lift - (14 * paint.scale) / 2 > 0);
  }
});
