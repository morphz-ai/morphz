import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sidebarPreference,
  sidebarLayout,
  resizeSidebar,
  stepSidebar,
} from "../apps/web/src/sidebar-layout.js";

test("sidebar preference validates numbers and stays independent of viewport pressure", () => {
  assert.deepEqual(sidebarPreference(NaN, "true"), {
    sidebarWidth: 280,
    sidebarCompact: false,
  });
  assert.equal(sidebarPreference(500).sidebarWidth, 360);
  assert.equal(sidebarPreference(-20).sidebarWidth, 200);
  const preference = sidebarPreference(360);
  assert.equal(sidebarLayout(640, preference).width, 80);
  assert.equal(sidebarLayout(800, preference).width, 320);
  assert.equal(sidebarLayout(1440, preference).width, 360);
  assert.equal(preference.sidebarWidth, 360);
  assert.equal(sidebarLayout(390, preference).mobile, true);
  assert.equal(sidebarLayout(390, preference).compact, false);
});

test("sidebar threshold snaps to icons while keeping the previous expanded width", () => {
  const preference = sidebarPreference(320);
  const rail = resizeSidebar(140, 360, preference);
  assert.deepEqual(rail, { sidebarWidth: 320, sidebarCompact: true });
  assert.equal(sidebarLayout(1440, rail).width, 80);
  assert.deepEqual(resizeSidebar(304, 360, rail), {
    sidebarWidth: 304,
    sidebarCompact: false,
  });
  assert.deepEqual(resizeSidebar(160, 360, rail), {
    sidebarWidth: 200,
    sidebarCompact: false,
  });
});

test("sidebar keyboard can enter and leave icon mode without getting stuck at minimum", () => {
  const preference = sidebarPreference(280);
  assert.deepEqual(
    stepSidebar(280, "ArrowLeft", false, 360, preference),
    sidebarPreference(264),
  );
  assert.deepEqual(
    stepSidebar(280, "ArrowRight", true, 360, preference),
    sidebarPreference(312),
  );
  assert.equal(
    stepSidebar(200, "ArrowLeft", false, 360, preference)?.sidebarCompact,
    true,
  );
  assert.deepEqual(
    stepSidebar(80, "ArrowRight", false, 360, preference),
    sidebarPreference(200),
  );
  assert.deepEqual(
    stepSidebar(280, "Home", false, 360, preference),
    sidebarPreference(280, true),
  );
  assert.deepEqual(
    stepSidebar(80, "End", false, 320, preference),
    sidebarPreference(320),
  );
  assert.equal(stepSidebar(280, "Escape", false, 360, preference), null);
});

test("compact rail leaves a conservative native-button and resize-hit margin", () => {
  const rail = sidebarLayout(1440, sidebarPreference(280, true));
  // These are design-envelope constraints, not measured OS button bounds.
  const conservativeNativeRight = 68;
  const resizeHitLeft = rail.width - 4;
  assert.equal(rail.width, 80);
  assert.equal(resizeHitLeft, 76);
  assert.ok(rail.width - conservativeNativeRight >= 12);
  assert.ok(resizeHitLeft - conservativeNativeRight >= 8);
});
