import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isFunctionDeclaration } from "typescript/unstable/ast";
import {
  createWorkspaceNavigationCommands,
  type NavigationOwner,
  type NavigationPreferences,
} from "../apps/web/src/host/use-workspace-navigation.js";
import {
  initialWorkspace,
  type Artifact,
  type Content,
} from "../packages/core/src/model.js";
import type { Boot } from "../apps/web/src/client.js";
import { parseReference } from "./fixtures/exchange-reference-contract.js";
import {
  createFixedWorkspaceContentOpening,
  fixedContentOpeningHashes,
} from "./fixtures/workspace-content-opening-2cf6a3f2.js";

// Actual production factory vs independent old upper entry algorithms, both
// using the same unchanged production lower commands. Controlled ports are not
// real HTTP/ACL, mounted React, or user-window acceptance.
type Options = Parameters<
  typeof createWorkspaceNavigationCommands<NavigationPreferences>
>[0];
type Catalog = Options["client"]["contentCatalog"][number];
type Script = NonNullable<
  Awaited<ReturnType<Options["client"]["resolveScriptLocation"]>>
>;
type ArtifactRead = Awaited<ReturnType<Options["client"]["resolveArtifact"]>>;
type Lane = "fixed" | "production";
const now = "2026-10-04T00:00:00.000Z";
function document(
  content: Content = { kind: "document", markdown: "原文" },
): Artifact {
  return {
    id: "object-A",
    projectId: "first-project",
    title: "Original",
    revision: 3,
    content,
    versions: [
      {
        revision: 3,
        content,
        createdAt: now,
        author: { principalId: "human-A", actantId: "human" },
      },
      {
        revision: 2,
        content,
        createdAt: now,
        author: { principalId: "human-A", actantId: "human" },
      },
    ],
  } as Artifact;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = async () => {
  for (let index = 0; index < 6; index++) await Promise.resolve();
};
function fixture(
  lane: Lane,
  configuration: {
    loaded?: boolean;
    script?: boolean;
    catalogScript?: boolean;
    content?: Content;
    nullBoot?: boolean;
  } = {},
) {
  const events: unknown[][] = [],
    notices: string[] = [];
  const workspace = initialWorkspace(now);
  const artifact = document(configuration.content);
  workspace.artifacts = configuration.loaded === false ? [] : [artifact];
  const authorized = structuredClone(workspace);
  authorized.artifacts = [artifact];
  const production = {
    id: "production-A",
    contentId: "script-content-A",
    projectId: "first-project",
    catalogRevision: 4,
    activityRevision: 7,
  } as Script["production"];
  const projection = {
    centerId: "center-A",
    principalId: "human-A",
    csrfToken: "csrf-A",
    workspace: authorized,
    scriptLibrary: [production],
  } as unknown as Boot;
  // Distinct ordinary render values deliberately remain captured while the
  // current authorization projection can change. No fabricated latest Client.
  const renderBoot = configuration.nullBoot
    ? null
    : {
        ...projection,
        workspace,
        scriptLibrary: configuration.script ? [production] : [],
      };
  const catalog: Catalog[] = configuration.catalogScript
    ? [
        {
          id: "object-A",
          appId: "morphz.script-studio",
          kind: "script",
          appObjectId: "production-A",
        } as Catalog,
      ]
    : [];
  let active = true;
  let readArtifact: Options["client"]["resolveArtifact"] = async () => artifact;
  let readCatalog: Options["client"]["resolveCatalogContent"] = async () =>
    null;
  let readScript: Options["client"]["resolveScriptLocation"] = async () => ({
    production,
    item: undefined,
  });
  let noticeFailure: unknown;
  const owner: NavigationOwner = {
    navigationGeneration: { current: 0 },
    openingObject: false,
    restoredPlace: null,
    trail: { current: { places: [], index: -1 } },
    trailVersion: 0,
    websiteIntent: null,
    beginIntent() {
      events.push(["begin"]);
      return ++owner.navigationGeneration.current;
    },
    beginOpen() {
      const value = owner.beginIntent();
      events.push(["opening", true]);
      return value;
    },
    isCurrent(value) {
      const result = value === owner.navigationGeneration.current;
      events.push(["current", value, result]);
      return result;
    },
    finishOpen(value) {
      events.push(["finish", value]);
      if (owner.isCurrent(value)) events.push(["opening", false]);
    },
    resetPreferenceNavigation() {},
    recordPlace() {},
    restorePlace() {},
    setExplicitWebsiteIntent(value) {
      owner.websiteIntent =
        typeof value === "function" ? value(owner.websiteIntent) : value;
      events.push(["website", owner.websiteIntent]);
    },
  };
  const origin = {
    isActive() {
      events.push(["active", active]);
      return active;
    },
  };
  const client: Options["client"] = {
    get boot() {
      events.push(["render-boot"]);
      return renderBoot;
    },
    get contentCatalog() {
      events.push(["render-catalog"]);
      return catalog;
    },
    resolveCatalogContent(id) {
      events.push(["catalog", id]);
      return readCatalog(id);
    },
    resolveArtifact(id, revision) {
      events.push(["artifact", id, revision]);
      return readArtifact(id, revision);
    },
    resolveScriptLocation(location) {
      events.push(["script", location]);
      return readScript(location);
    },
    async execute(operation) {
      events.push(["execute", operation]);
      if (operation.type === "launch-application")
        authorized.applicationInstances = [
          {
            id: "instance-A",
            workspaceId: operation.workspaceId,
            applicationId: operation.applicationId,
            applicationVersion: operation.applicationVersion,
            revision: 1,
            state: {},
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ];
      return {
        commandId: "command-A",
        entityId: "instance-A",
        workspaceRevision: 1,
      };
    },
  };
  const onNotice = (message: string) => {
    events.push(["notice", message]);
    notices.push(message);
    if (noticeFailure !== undefined) throw noticeFailure;
  };
  const options: Options = {
    owner,
    client,
    workspace,
    surface: {
      project: workspace.projects[0],
      applicationWorkspaceOpen: false,
      exchangeKey: "exchange-A",
      activeInstance: undefined,
    },
    preferences: {
      view: "projects",
      projectId: "first-project",
      projectOpen: true,
      artifactId: null,
      artifactRevision: null,
      collaboration: false,
      subjectOpen: true,
    },
    prefer() {
      throw new Error("ordinary private preference port must not be called");
    },
    shell: {
      finishCreation() {
        events.push(["finish-creation"]);
      },
      dismissExecutionInspector() {
        events.push(["dismiss-inspector"]);
      },
    },
    onNotice,
    application: {
      historyVisible: false,
      personalDesk() {
        return undefined;
      },
      readCapturedInstance() {
        return undefined;
      },
      selectAllContent() {},
    },
    continuation: {
      isActive: origin.isActive,
      currentProjection() {
        events.push(["projection"]);
        return projection;
      },
      captureCommit() {
        events.push(["capture"]);
        return () => true;
      },
      prefer(change, intent, destination) {
        assert.ok(destination(projection));
        events.push(["publish", change]);
        intent.generation = ++owner.navigationGeneration.current;
      },
      writePreferences() {
        throw new Error("not an entry operation");
      },
      recordContentVisit(id, destination) {
        assert.ok(destination(projection));
        events.push(["visit", id]);
      },
    },
  };
  const commands = createWorkspaceNavigationCommands(options);
  const entries =
    lane === "production"
      ? commands
      : createFixedWorkspaceContentOpening({
          origin,
          navigation: owner,
          state: workspace,
          client,
          setWebsiteIntent: owner.setExplicitWebsiteIntent,
          setNotice: onNotice,
          openObject: commands.openObject,
          openScriptLocation: commands.openScriptLocation,
        });
  assert.equal(
    events.length,
    0,
    "both constructors perform zero reads/transitions/writes",
  );
  return {
    commands,
    entries,
    owner,
    artifact,
    workspace,
    renderBoot,
    catalog,
    projection,
    production,
    events,
    notices,
    recordCompletion(value: number | undefined) {
      events.push(["entry-resolved", value]);
    },
    deactivate() {
      active = false;
    },
    readArtifact(value: typeof readArtifact) {
      readArtifact = value;
    },
    readCatalog(value: typeof readCatalog) {
      readCatalog = value;
    },
    readScript(value: typeof readScript) {
      readScript = value;
    },
    failNotice(value: unknown) {
      noticeFailure = value;
    },
  };
}
const pair = (configuration?: Parameters<typeof fixture>[1]) =>
  [
    fixture("fixed", configuration),
    fixture("production", configuration),
  ] as const;
function parity(lanes: ReturnType<typeof pair>) {
  assert.deepEqual(
    lanes[1].events,
    lanes[0].events,
    "complete ordered port ledger",
  );
  assert.deepEqual(lanes[1].notices, lanes[0].notices);
  assert.equal(
    lanes[1].owner.navigationGeneration.current,
    lanes[0].owner.navigationGeneration.current,
  );
  assert.equal(lanes[1].owner.websiteIntent, lanes[0].owner.websiteIntent);
}

test("fixed complete entry declarations retain independent original raw hashes", () => {
  const source = readFileSync(
    new URL(
      "./fixtures/workspace-content-opening-2cf6a3f2.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const parsed = parseReference(source);
  for (const name of ["openUser", "openReading"] as const) {
    const declarations = parsed.nodes
      .filter(isFunctionDeclaration)
      .filter((node) => node.name?.text === name);
    assert.equal(declarations.length, 1);
    assert.equal(
      createHash("sha256").update(declarations[0]!.getText()).digest("hex"),
      fixedContentOpeningHashes[name],
    );
  }
});

test("actual public entry commands are inert and a retired ordinary entry performs no read or intent", async () => {
  const lanes = pair();
  for (const lane of lanes) {
    assert.equal(typeof lane.commands.openUser, "function");
    assert.equal(typeof lane.commands.openReading, "function");
    lane.deactivate();
    await lane.entries.openUser("object-A");
    await lane.entries.openReading("object-A");
    assert.deepEqual(lane.events, [
      ["active", false],
      ["active", false],
    ]);
  }
  parity(lanes);
});

test("script id/content id fast paths return the raw lower Promise without the outer intent", async () => {
  for (const id of ["production-A", "script-content-A"]) {
    const lanes = pair({ script: true });
    const pending = lanes.map(() =>
      deferred<
        Awaited<ReturnType<Options["client"]["resolveScriptLocation"]>>
      >(),
    );
    let settled = 0;
    const promises = lanes.map((lane, index) => {
      lane.readScript(() => pending[index]!.promise);
      return lane.entries.openUser(id).then((value) => {
        settled++;
        lane.recordCompletion(value);
        return value;
      });
    });
    await turn();
    assert.equal(settled, 0);
    for (const lane of lanes) {
      assert.equal(
        lane.events.filter((event) => event[0] === "begin").length,
        1,
      );
      assert.equal(
        lane.events.some(
          (event) =>
            event[0] === "catalog" ||
            event[0] === "artifact" ||
            event[0] === "website",
        ),
        false,
      );
    }
    parity(lanes);
    pending.forEach((value, index) =>
      value.resolve({ production: lanes[index]!.production, item: undefined }),
    );
    assert.deepEqual(await Promise.all(promises), [2, 2]);
    for (const lane of lanes) {
      assert.equal(lane.owner.navigationGeneration.current, 2);
      assert.ok(
        lane.events.findIndex((event) => event[0] === "publish") <
          lane.events.findIndex((event) => event[0] === "entry-resolved"),
      );
    }
    parity(lanes);
  }
});

test("script lower rejection propagates through return rather than being caught again upstream", async () => {
  const lanes = pair({ script: true });
  for (const lane of lanes) {
    const sentinel = new Error("notice writer failed");
    lane.failNotice(sentinel);
    lane.readScript(async () => {
      throw new Error("script read failed");
    });
    await assert.rejects(
      lane.entries.openUser("production-A"),
      (error) => error === sentinel,
    );
    assert.deepEqual(
      lane.notices,
      ["script read failed"],
      "return await would incorrectly call notice a second time",
    );
  }
  parity(lanes);
});

test("loaded artifact still searches captured catalog first, skips resolveCatalog, and catalog scripts take precedence", async () => {
  const lanes = pair({ catalogScript: true });
  for (const lane of lanes) {
    // The current projection has a script but the render library did not.
    assert.equal(lane.renderBoot!.scriptLibrary.length, 0);
    assert.equal(await lane.entries.openUser("object-A"), 3);
    assert.equal(lane.owner.navigationGeneration.current, 3);
    assert.equal(
      lane.events.some(
        (event) =>
          event[0] === "catalog" ||
          event[0] === "artifact" ||
          event[0] === "website",
      ),
      false,
    );
    assert.deepEqual(
      lane.events.find((event) => event[0] === "script"),
      ["script", { productionId: "production-A" }],
    );
    assert.equal(lane.events.filter((event) => event[0] === "begin").length, 2);
  }
  parity(lanes);
});

test("entry reads the original render object's boot/catalog values at invocation rather than constructor time", async () => {
  for (const source of ["boot", "catalog"] as const) {
    const lanes = pair();
    for (const lane of lanes) {
      if (source === "boot") lane.renderBoot!.scriptLibrary = [lane.production];
      else
        lane.catalog.push({
          id: "object-A",
          appId: "morphz.script-studio",
          kind: "script",
          appObjectId: "production-A",
        } as Catalog);
      assert.deepEqual(lane.events, []);
      assert.equal(
        await lane.entries.openUser(
          source === "boot" ? "script-content-A" : "object-A",
        ),
        source === "boot" ? 2 : 3,
      );
      assert.equal(
        lane.events.filter((event) => event[0] === "script").length,
        1,
      );
      assert.equal(
        lane.events.some((event) => event[0] === "artifact"),
        false,
      );
    }
    parity(lanes);
  }
});

test("a resolved catalog script waits for lookup, then returns the lower published generation", async () => {
  const lanes = pair({ loaded: false });
  const held = lanes.map(() => deferred<Catalog | null>());
  let settled = 0;
  const promises = lanes.map((lane, index) => {
    lane.readCatalog(() => held[index]!.promise);
    return lane.entries.openUser("object-A").then((value) => {
      settled++;
      lane.recordCompletion(value);
      return value;
    });
  });
  await turn();
  assert.equal(settled, 0);
  for (const lane of lanes) {
    assert.equal(lane.events.filter((event) => event[0] === "begin").length, 1);
    assert.equal(
      lane.events.some((event) => event[0] === "script"),
      false,
    );
  }
  parity(lanes);
  held.forEach((pending) =>
    pending.resolve({
      id: "object-A",
      appId: "morphz.script-studio",
      kind: "script",
      appObjectId: "production-A",
    } as Catalog),
  );
  assert.deepEqual(await Promise.all(promises), [3, 3]);
  for (const lane of lanes) {
    assert.equal(lane.owner.navigationGeneration.current, 3);
    assert.equal(lane.events.filter((event) => event[0] === "begin").length, 2);
    assert.equal(
      lane.events.some((event) => event[0] === "artifact"),
      false,
    );
    assert.ok(
      lane.events.findIndex((event) => event[0] === "publish") <
        lane.events.findIndex((event) => event[0] === "entry-resolved"),
    );
  }
  parity(lanes);
});

test("User uses the captured render projection, not a later authorized script snapshot", async () => {
  const lanes = pair();
  for (const lane of lanes) {
    lane.projection.scriptLibrary = [
      { ...lane.production, contentId: "object-A" },
    ];
    await lane.entries.openUser("object-A", 2, 7);
    await turn();
    assert.equal(
      lane.events.some((event) => event[0] === "script"),
      false,
    );
    assert.equal(
      lane.events.some((event) => event[0] === "catalog"),
      false,
    );
    assert.deepEqual(
      lane.events.filter((event) => event[0] === "artifact"),
      [["artifact", "object-A", 2]],
    );
  }
  parity(lanes);
});

test("User preserves upstream no-revision read and downstream exact revision/page/reading, while void settles first", async () => {
  const lanes = pair({ loaded: false, content: { kind: "pdf" } as Content });
  const held = lanes.map(() => deferred<ArtifactRead>());
  const reading = {
    sourceId: "object-A",
    sectionId: "section-A",
    start: 4,
    end: 8,
  };
  const promises = lanes.map((lane, index) => {
    let reads = 0;
    lane.readArtifact(async () =>
      ++reads === 1 ? lane.artifact : held[index]!.promise,
    );
    return lane.entries.openUser("object-A", 2, 7, reading);
  });
  assert.deepEqual(await Promise.all(promises), [undefined, undefined]);
  for (const lane of lanes) {
    assert.deepEqual(
      lane.events.filter((event) => event[0] === "artifact"),
      [
        ["artifact", "object-A", undefined],
        ["artifact", "object-A", 2],
      ],
    );
    assert.equal(
      lane.events.some((event) => event[0] === "publish"),
      false,
      "User must not await lower object opening",
    );
  }
  parity(lanes);
  held.forEach((pending, index) => pending.resolve(lanes[index]!.artifact));
  await turn();
  for (const lane of lanes) {
    const published = lane.events.find(
      (event) => event[0] === "publish",
    )![1] as Partial<NavigationPreferences>;
    assert.equal(published.artifactRevision, 2);
    assert.equal(published.artifactPage, 7);
    assert.equal(published.readerMode, true);
    assert.equal(published.readingTarget!.location, reading);
    assert.equal(typeof published.readingTarget!.requestId, "string");
    assert.match(published.readingTarget!.requestId!, /^[\da-f-]{36}$/i);
    // Request UUID values differ across independent lanes; no other ledger
    // field is filtered or discarded for parity.
    published.readingTarget!.requestId = "independent-request-id";
  }
  parity(lanes);
});

test("Reading has no catalog/script/website mutation, waits for lower opening and preserves explicit reader mode", async () => {
  const lanes = pair({ script: true });
  const held = lanes.map(() => deferred<ArtifactRead>());
  let settled = 0;
  const promises = lanes.map((lane, index) => {
    lane.owner.websiteIntent = "keep-existing-intent";
    lane.readArtifact(() => held[index]!.promise);
    return lane.entries.openReading("object-A").then((value) => {
      settled++;
      return value;
    });
  });
  await turn();
  assert.equal(settled, 0);
  for (const lane of lanes) {
    assert.equal(lane.owner.websiteIntent, "keep-existing-intent");
    assert.equal(
      lane.events.some((event) =>
        [
          "render-boot",
          "render-catalog",
          "catalog",
          "script",
          "website",
        ].includes(event[0] as string),
      ),
      false,
    );
  }
  parity(lanes);
  held.forEach((pending, index) => pending.resolve(lanes[index]!.artifact));
  assert.deepEqual(await Promise.all(promises), [undefined, undefined]);
  assert.equal(settled, 2);
  for (const lane of lanes) {
    const published = lane.events.find(
      (event) => event[0] === "publish",
    )![1] as Partial<NavigationPreferences>;
    assert.equal(published.readerMode, true);
    assert.equal(published.readingTarget, null);
  }
  parity(lanes);
});

test("each User await retains generation and private-origin success guards", async () => {
  for (const boundary of ["catalog", "artifact"] as const)
    for (const retire of ["generation", "private"] as const) {
      const lanes = pair({ loaded: false });
      const held = lanes.map(() => deferred<ArtifactRead | Catalog | null>());
      const promises = lanes.map((lane, index) => {
        if (boundary === "catalog")
          lane.readCatalog(
            () => held[index]!.promise as Promise<Catalog | null>,
          );
        else
          lane.readArtifact(
            () => held[index]!.promise as Promise<ArtifactRead>,
          );
        return lane.entries.openUser("object-A");
      });
      await turn();
      for (const lane of lanes) {
        if (retire === "generation") lane.owner.beginIntent();
        else lane.deactivate();
      }
      held.forEach((pending, index) =>
        pending.resolve(
          boundary === "artifact" ? lanes[index]!.artifact : null,
        ),
      );
      await Promise.all(promises);
      for (const lane of lanes) {
        assert.equal(
          lane.events.some(
            (event) => event[0] === "website" || event[0] === "publish",
          ),
          false,
        );
        assert.deepEqual(lane.notices, []);
        if (boundary === "catalog")
          assert.equal(
            lane.events.some((event) => event[0] === "artifact"),
            false,
          );
      }
      parity(lanes);
    }
});

test("Reading's single upstream await rejects later intent or retired origin success without touching website intent", async () => {
  for (const retire of ["generation", "private"] as const) {
    const lanes = pair({ loaded: false });
    const held = lanes.map(() => deferred<ArtifactRead>());
    const promises = lanes.map((lane, index) => {
      lane.readArtifact(() => held[index]!.promise);
      return lane.entries.openReading("object-A");
    });
    for (const lane of lanes) {
      if (retire === "generation") lane.owner.beginIntent();
      else lane.deactivate();
    }
    held.forEach((pending, index) => pending.resolve(lanes[index]!.artifact));
    await Promise.all(promises);
    for (const lane of lanes)
      assert.equal(
        lane.events.filter((event) => event[0] === "artifact").length,
        1,
      );
    parity(lanes);
  }
});

test("User late rejection still calls raw notice, preserves Error/fallback text, while Reading propagates", async () => {
  for (const boundary of ["catalog", "artifact"] as const)
    for (const error of [new Error("exact failure"), { reason: "non Error" }]) {
      const lanes = pair({ loaded: false });
      const held = lanes.map(() => deferred<never>());
      const promises = lanes.map((lane, index) => {
        if (boundary === "catalog")
          lane.readCatalog(() => held[index]!.promise);
        else lane.readArtifact(() => held[index]!.promise);
        return lane.entries.openUser("object-A");
      });
      await turn();
      for (const lane of lanes) {
        lane.deactivate();
        lane.owner.beginIntent();
      }
      held.forEach((pending) => pending.reject(error));
      await Promise.all(promises);
      for (const lane of lanes)
        assert.deepEqual(lane.notices, [
          error instanceof Error ? error.message : "内容暂时无法打开，请重试。",
        ]);
      parity(lanes);
    }
  const lanes = pair({ loaded: false });
  for (const lane of lanes) {
    const failure = new Error("reading rejection");
    lane.readArtifact(async () => {
      lane.deactivate();
      throw failure;
    });
    await assert.rejects(
      lane.entries.openReading("object-A"),
      (error) => error === failure,
    );
    assert.deepEqual(lane.notices, []);
  }
  parity(lanes);
});

test("User absent artifact has its original notice; Reading absence is silent; null Boot does not become an eager requirement", async () => {
  for (const method of ["openUser", "openReading"] as const) {
    const lanes = pair({ loaded: false, nullBoot: true });
    for (const lane of lanes) {
      lane.readArtifact(async () => undefined);
      await lane.entries[method]("object-A");
      assert.deepEqual(
        lane.notices,
        method === "openUser"
          ? ["对象暂时无法读取，请检查连接或访问权限后重试。"]
          : [],
      );
      assert.equal(
        lane.events.some(
          (event) => event[0] === "website" || event[0] === "publish",
        ),
        false,
      );
    }
    parity(lanes);
  }
});

test("website intent uses resolved artifact id, while the lower object query keeps the original requested id", async () => {
  const lanes = pair({
    loaded: false,
    content: { kind: "website", url: "https://example.invalid" } as Content,
  });
  const held = lanes.map(() => deferred<ArtifactRead>());
  await Promise.all(
    lanes.map((lane, index) => {
      let reads = 0;
      lane.readArtifact(async () =>
        ++reads === 1
          ? { ...lane.artifact, id: "resolved-original" }
          : held[index]!.promise,
      );
      return lane.entries.openUser("object-A", 2, 7);
    }),
  );
  for (const lane of lanes) {
    assert.equal(lane.owner.websiteIntent, "resolved-original");
    assert.deepEqual(
      lane.events.filter((event) => event[0] === "artifact"),
      [
        ["artifact", "object-A", undefined],
        ["artifact", "object-A", 2],
      ],
    );
  }
  parity(lanes);
  held.forEach((pending) => pending.resolve(undefined));
  await turn();
  parity(lanes);
});
