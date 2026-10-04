import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixedObjectInteractions as fixed } from "./fixtures/object-interactions-original.js";
import {
  readObjectInteractionOwner,
  verifyObjectInteractionConsumption as verify,
} from "./fixtures/object-interactions-consumption.js";
const client = readFileSync(
    new URL("../apps/web/src/client.ts", import.meta.url),
    "utf8",
  ),
  owner = readObjectInteractionOwner();
const change = (text: string, before: string, after: string) => {
  assert.equal(text.split(before).length, 2, "one precise counterfactual seam");
  return text.replace(before, after);
};
const rejection = (clientText: string, ownerText: string, rule: RegExp) =>
  assert.throws(() => verify(clientText, ownerText), rule);

test("object current owner complete bounded algorithms and actual Client consumers; fixed raw source archive", () => {
  for (const span of Object.values(fixed.spans))
    assert.equal(
      createHash("sha256").update(span.raw).digest("hex"),
      span.sha256,
    );
  assert.equal(verify(client, owner), true);
});
test("object bounded reader schema/pagination/capture and write payload/receipt counterfactuals reject precisely", () => {
  for (const [before, after, rule] of [
    [
      "page < 100",
      "page < 101",
      /complete original authorized annotation Client reader identity pagination and bounds/,
    ],
    [
      "limit: 100",
      "limit: 50",
      /complete original authorized annotation Client reader identity pagination and bounds/,
    ],
    [
      "const source = platform.current;",
      "const source = { ...platform.current! };",
      /complete original authorized annotation Client reader identity pagination and bounds/,
    ],
    [
      "ordinal: z.number().int().nonnegative()",
      "ordinal: z.number()",
      /complete original authorized annotation Client reader identity pagination and bounds/,
    ],
    [
      "return source.allWorkRelations(objectId, signal);",
      "return source.allWorkRelations(objectId);",
      /object-complete-relations-read/,
    ],
    [
      "revision: op.artifactRevision",
      "revision: 1",
      /object-complete-write annotateObjectOperation/,
    ],
    [
      'entry.availability !== "available"',
      'entry.availability === "available"',
      /object-complete-write annotateObjectOperation/,
    ],
    [
      "op.page === undefined",
      "!op.page",
      /object-complete-write annotateObjectOperation/,
    ],
    [
      "return done(relationId);",
      "return done(commandId);",
      /object-complete-write linkWorkOperation/,
    ],
  ] as const) {
    // First source capture occurs in both reads; target the complete first recipe.
    const candidate =
      before === "const source = platform.current;"
        ? change(
            owner,
            fixed.spans.listObjectAnnotations.raw,
            change(fixed.spans.listObjectAnnotations.raw, before, after),
          )
        : change(owner, before, after);
    rejection(client, candidate, rule);
  }
});
test("object construction is inert and closed; genuine runtime schema/factory/leaf binding cannot be nominal", () => {
  rejection(
    client,
    change(
      owner,
      "const { current, platform } = options;",
      "const { current, platform } = options;\n  void current.current;",
    ),
    /object-inert-factory/,
  );
  rejection(
    client,
    change(
      owner,
      "return { listObjectAnnotations, workRelationsFor };",
      "return { listObjectAnnotations, workRelationsFor, current };",
    ),
    /object-closed-read-methods/,
  );
  rejection(
    change(
      client,
      "  createObjectInteractions,",
      "  type createObjectInteractions,",
    ),
    owner,
    /object-real-runtime-import createObjectInteractions/,
  );
  rejection(
    change(
      client,
      "createObjectInteractions({ current, platform })",
      "foreignFactory({ current, platform })",
    ) + "\nfunction foreignFactory(value: unknown){return value;}\n",
    owner,
    /object-real-factory-callee/,
  );
  rejection(
    change(
      client,
      "return linkWorkOperation(source, op, commandId, done);",
      "return foreignLink(source, op, commandId, done);",
    ) + "\nfunction foreignLink(...values:unknown[]){return values;}\n",
    owner,
    /object-real-dispatch-leaf link-artifacts/,
  );
});
test("object original React refs, retirement, ports, direct methods and dispatch capture are actual", () => {
  for (const [before, after, rule] of [
    [
      "createObjectInteractions({ current, platform })",
      "createObjectInteractions({ current: {...current}, platform })",
      /object-borrow-original-current-ref/,
    ],
    [
      "current = useRef<Boot | null>(null)",
      "current = foreignRef<Boot | null>(null)",
      /object-original-react-refs/,
    ],
    [
      "    protectedReadGeneration.current++;\n    current.current = null;",
      "    protectedReadGeneration.current++;\n    if (Date.now()) current.current = null;",
      /object-original-ref-retirement/,
    ],
    [
      "    current.current = null;\n    platform.current = null;",
      "    current.current = null;\n    platform.current = platform.current;",
      /object-original-ref-retirement/,
    ],
    [
      "  function clearProtectedProjection() {\n    protectedReadGeneration.current++;",
      "  function clearProtectedProjection() {\n    return;\n    protectedReadGeneration.current++;",
      /object-original-ref-retirement/,
    ],
    [
      "    listObjectAnnotations: objectInteractions.listObjectAnnotations,",
      "    listObjectAnnotations: (...args:Parameters<typeof objectInteractions.listObjectAnnotations>) => objectInteractions.listObjectAnnotations(...args),",
      /object-direct-public-method listObjectAnnotations/,
    ],
    [
      "    workRelationsFor: objectInteractions.workRelationsFor,",
      "    workRelationsFor: objectInteractions.listObjectAnnotations,",
      /object-direct-public-method workRelationsFor/,
    ],
    [
      "return linkWorkOperation(source, op, commandId, done);",
      "return linkWorkOperation(platform.current!, op, commandId, done);",
      /object-original-dispatch-ports link-artifacts/,
    ],
    [
      "workspaceRevision: identity.workspace.revision + 1",
      "workspaceRevision: 1",
      /object-original-captured-receipt/,
    ],
    [
      'if (op.type === "annotate")',
      'if (op.type !== "annotate")',
      /object-original-dispatch-guard annotate/,
    ],
  ] as const) {
    const clears = /ref-retirement/.test(rule.source);
    const oldClear = clears
      ? client.match(
          /  function clearProtectedProjection\(\) \{[\s\S]*?\n  \}/,
        )![0]
      : undefined;
    const candidate = oldClear
      ? change(client, oldClear, change(oldClear, before, after))
      : change(client, before, after);
    rejection(candidate, owner, rule);
  }
});
test("object finite contract permits actual import/local aliases, static types and consumed independent Client/cache cleanup growth", () => {
  let aliased = change(
    client,
    "  createObjectInteractions,",
    "  createObjectInteractions as buildObjects,",
  );
  aliased = change(
    aliased,
    "createObjectInteractions({ current, platform })",
    "objectBuilder({ current, platform })",
  );
  aliased = change(
    aliased,
    "  const objectInteractions =",
    "  const objectBuilder: typeof buildObjects = buildObjects;\n  const objectInteractions =",
  );
  assert.equal(verify(aliased, owner), true);
  let schema = change(owner, "import { z }", "import { z as schema }");
  schema = change(schema, "const rows = z", "const rows = schema");
  assert.equal(verify(client, schema), true);
  const growth = change(
    change(
      change(
        client,
        "export function useWorkspace() {",
        "export function useWorkspace() {\n  const futureCache = useRef(new Map<string,string>());\n  const [future,updateFuture] = useState(0);\n  useEffect(()=>{futureCache.current.set('future',String(future));},[future]);\n  const futureAction = () => updateFuture(value=>value+1);",
      ),
      "    setContentCounts([]);",
      "    setContentCounts([]);\n    futureCache.current.clear();",
    ),
    "    workRelationsFor: objectInteractions.workRelationsFor,",
    "    workRelationsFor: objectInteractions.workRelationsFor,\n    future, futureAction,",
  );
  assert.equal(
    verify(
      growth,
      owner + "\nexport const futureObjectDomain = { version: 1 };\n",
    ),
    true,
  );
});
