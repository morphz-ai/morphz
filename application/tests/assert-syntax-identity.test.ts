import assert from "node:assert/strict";
import test from "node:test";
import { isFunctionDeclaration } from "typescript/unstable/ast";
import { assertSyntaxIdentity } from "./fixtures/assert-syntax-identity.js";
import { virtualTypeScriptSnapshot } from "./fixtures/virtual-typescript.js";

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

test("real native syntax nodes retain strict identity with bounded negative diagnostics", () => {
  const root = "/syntax-identity-native-regression";
  const config = `${root}/tsconfig.json`;
  const snapshot = virtualTypeScriptSnapshot(
    root,
    {
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true },
        files: ["source.ts"],
      }),
      [`${root}/source.ts`]:
        "function first() { return 1; } function second() { return 1; }",
    },
    config,
  );
  try {
    const program = snapshot.getProject(config)!.program;
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
    const source = program.getSourceFile(`${root}/source.ts`)!;
    const bodies = source.statements
      .filter(isFunctionDeclaration)
      .map((node) => node.body!);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0]!.getText(), bodies[1]!.getText());
    assertSyntaxIdentity(bodies[0], bodies[0], "same native syntax node");
    for (const expected of [bodies[1], source, undefined]) {
      const message = "native syntax reference must remain the exact owner";
      assert.throws(
        () => assertSyntaxIdentity(bodies[0], expected, message),
        (error) =>
          error instanceof assert.AssertionError &&
          error.message === message &&
          error.actual === false &&
          error.expected === true,
      );
    }
  } finally {
    snapshot.dispose();
  }
});
