import assert from "node:assert/strict";
import test from "node:test";
import { assertSyntaxIdentity } from "./fixtures/assert-syntax-identity.js";

test("syntax identity rejects distinct lazy graphs without evaluating diagnostic getters", () => {
  let inspected = 0;
  const lazyNode = () => ({
    kind: 1,
    get children() {
      inspected++;
      throw new Error("An identity failure must not traverse the syntax tree");
    },
  });
  const actual = lazyNode();
  assertSyntaxIdentity(actual, actual, "same syntax node");
  for (const expected of [lazyNode(), undefined]) {
    assert.throws(
      () => assertSyntaxIdentity(actual, expected, "direct initializer seam"),
      (error) =>
        error instanceof assert.AssertionError &&
        error.message === "direct initializer seam" &&
        error.actual === false &&
        error.expected === true,
    );
  }
  assert.throws(
    () => assertSyntaxIdentity(undefined, actual, "missing syntax node"),
    assert.AssertionError,
  );
  assertSyntaxIdentity(undefined, undefined, "both optional nodes absent");
  assert.equal(inspected, 0);
});
