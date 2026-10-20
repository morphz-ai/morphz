import assert from "node:assert/strict";

// Native TypeScript nodes expose a lazy, cyclic tree backed by binary views.
// Node's strictEqual failure formatter inspects getters and the entire graph,
// even when the caller supplies a message. A negative identity check must not
// materialize that graph just to describe a failure. Keep the same reference
// comparison, with a bounded Boolean diagnostic and an explicit seam name.
export function assertSyntaxIdentity(
  actual: object | undefined,
  expected: object | undefined,
  message: string,
) {
  assert.ok(actual === expected, message);
}
