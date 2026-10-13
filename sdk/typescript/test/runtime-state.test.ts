import assert from "node:assert/strict";
import test from "node:test";
import { objectiveIsTerminal } from "../src/runtime-state.ts";

test("Dashboard and Desktop share explicit Goal terminal states, preserving unknown work", () => {
  for (const status of ["completed", "cancelled", "failed"])
    assert.equal(objectiveIsTerminal(status), true, status);
  for (const status of ["active", "paused", "blocked", "", "future-status"])
    assert.equal(objectiveIsTerminal(status), false, status);
});
