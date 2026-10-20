import assert from "node:assert/strict";
import test from "node:test";
import { isIdentifier, isVariableStatement } from "typescript/unstable/ast";
import {
  virtualTypeScriptSnapshot,
  virtualTypeScriptResources,
} from "./fixtures/virtual-typescript.js";

function files(root: string, text: string) {
  return {
    [`${root}/tsconfig.json`]: JSON.stringify({
      compilerOptions: { noLib: true, noResolve: true },
      files: ["source.ts"],
    }),
    [`${root}/source.ts`]: text,
  };
}

test("hundreds of synchronous counterfactual snapshots use one real compiler without stale source or symbols", () => {
  const root = "/virtual-compiler-resource-regression";
  const config = `${root}/tsconfig.json`;
  const before = virtualTypeScriptResources();
  let previous;
  for (let i = 0; i < 256; i++) {
    const text = `const value${i} = ${i}; const other${i} = value${i};`;
    const snapshot = virtualTypeScriptSnapshot(root, files(root, text), config);
    try {
      const project = snapshot.getProject(config)!;
      assert.deepEqual(project.program.getSyntacticDiagnostics(), []);
      const source = project.program.getSourceFile(`${root}/source.ts`)!;
      assert.equal(source.text, text);
      assert.notEqual(source, previous);
      previous = source;
      const declarations = source.statements
        .filter(isVariableStatement)
        .map((s) => s.declarationList.declarations[0]!);
      const first = declarations[0]!.name;
      const use = declarations[1]!.initializer!;
      assert(isIdentifier(first) && isIdentifier(use));
      assert.equal(first.text, `value${i}`);
      const [declared, referenced] = project.checker.getSymbolAtLocation([
        first,
        use,
      ]);
      assert.ok(declared);
      assert.equal(declared.id, referenced?.id);
    } finally {
      snapshot.dispose();
    }
  }
  const after = virtualTypeScriptResources();
  assert.equal(after.starts - before.starts, 1);
  assert.equal(after.owned - before.owned, 1);
});

test("changed configs and removed or newly added virtual files invalidate the old project", () => {
  const root = "/virtual-compiler-config-regression";
  const config = `${root}/tsconfig.json`;
  const first = virtualTypeScriptSnapshot(
    root,
    files(root, "const oldSource = 1;"),
    config,
  );
  assert.ok(
    first.getProject(config)!.program.getSourceFile(`${root}/source.ts`),
  );
  first.dispose();
  const second = virtualTypeScriptSnapshot(
    root,
    {
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
        files: ["added.tsx"],
      }),
      [`${root}/added.tsx`]: "const added = <div/>;",
    },
    config,
  );
  try {
    const program = second.getProject(config)!.program;
    assert.equal(program.getSourceFile(`${root}/source.ts`), undefined);
    assert.equal(
      program.getSourceFile(`${root}/added.tsx`)!.text,
      "const added = <div/>;",
    );
    assert.deepEqual(program.getSyntacticDiagnostics(), []);
  } finally {
    second.dispose();
  }
});

test("case-only source-layout changes remain distinct and both layouts see every new mutation", () => {
  const root = "/virtual-compiler-case-regression",
    config = `${root}/tsconfig.json`;
  const before = virtualTypeScriptResources();
  for (let i = 0; i < 32; i++) {
    const name = i % 2 ? "App.tsx" : "app.tsx";
    const text = `export const value = ${i};`;
    const snapshot = virtualTypeScriptSnapshot(
      root,
      {
        [config]: JSON.stringify({
          compilerOptions: { noLib: true, noResolve: true, jsx: "preserve" },
          files: [name],
        }),
        [`${root}/${name}`]: text,
      },
      config,
    );
    try {
      const program = snapshot.getProject(config)!.program;
      assert.deepEqual(program.getSyntacticDiagnostics(), []);
      assert.equal(program.getSourceFile(`${root}/${name}`)!.text, text);
    } finally {
      snapshot.dispose();
    }
  }
  assert.equal(virtualTypeScriptResources().starts - before.starts, 2);
});

test("independent roots stay isolated and an active snapshot cannot be overwritten", () => {
  const a = "/virtual-compiler-root-a",
    b = "/virtual-compiler-root-b";
  const first = virtualTypeScriptSnapshot(
    a,
    files(a, "const original = 1;"),
    `${a}/tsconfig.json`,
  );
  try {
    assert.throws(
      () =>
        virtualTypeScriptSnapshot(
          a,
          files(a, "const poison = 2;"),
          `${a}/tsconfig.json`,
        ),
      /Dispose the previous/,
    );
    const other = virtualTypeScriptSnapshot(
      b,
      files(b, "const separate = 3;"),
      `${b}/tsconfig.json`,
    );
    try {
      assert.equal(
        first
          .getProject(`${a}/tsconfig.json`)!
          .program.getSourceFile(`${a}/source.ts`)!.text,
        "const original = 1;",
      );
      assert.equal(
        other
          .getProject(`${b}/tsconfig.json`)!
          .program.getSourceFile(`${b}/source.ts`)!.text,
        "const separate = 3;",
      );
    } finally {
      other.dispose();
    }
  } finally {
    first.dispose();
  }
  const next = virtualTypeScriptSnapshot(
    a,
    files(a, "const replacement = 4;"),
    `${a}/tsconfig.json`,
  );
  try {
    assert.equal(
      next
        .getProject(`${a}/tsconfig.json`)!
        .program.getSourceFile(`${a}/source.ts`)!.text,
      "const replacement = 4;",
    );
  } finally {
    next.dispose();
  }
});

test("syntax errors remain errors and do not poison a later valid source or project", () => {
  const root = "/virtual-compiler-error-regression",
    config = `${root}/tsconfig.json`;
  const invalid = virtualTypeScriptSnapshot(
    root,
    files(root, "const broken = ;"),
    config,
  );
  try {
    assert(
      invalid.getProject(config)!.program.getSyntacticDiagnostics().length > 0,
    );
  } finally {
    invalid.dispose();
  }
  const otherConfig = `${root}/other.json`;
  const validFiles = files(root, "const recovered = 1;");
  const valid = virtualTypeScriptSnapshot(
    root,
    { ...validFiles, [otherConfig]: validFiles[config]! },
    otherConfig,
  );
  try {
    assert.equal(valid.getProject(config), undefined);
    assert.deepEqual(
      valid.getProject(otherConfig)!.program.getSyntacticDiagnostics(),
      [],
    );
  } finally {
    valid.dispose();
  }
});
