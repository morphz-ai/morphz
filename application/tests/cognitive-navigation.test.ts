import test from "node:test";
import assert from "node:assert/strict";
import {
  appendNavigationPlace,
  isNavigationPreferenceChange,
  mergeNavigationPreferences,
  type NavigationPlace,
  type NavigationPreferences,
} from "../apps/web/src/host/use-workspace-navigation.js";
import { cognitiveNavigationLocation } from "../apps/web/src/host/cognitive-navigation-location.js";

const original = cognitiveNavigationLocation({
  kind: "original",
  locator: {
    projectId: "project_A",
    contentId: "content_A",
    connectionId: "connection_A",
    authority: {
      appId: "example.notes",
      version: "1.0.0",
      definitionHash: "a".repeat(64),
      instanceId: "instance_A",
      serviceId: "service/notes",
      dataAuthorityId: "database:notes",
    },
    object: { objectId: "笔记/001", versionRef: "0009007199254740993\n版本😀" },
  },
})!;
function preferences(): NavigationPreferences {
  return {
    view: "projects",
    projectId: "project_A",
    projectOpen: true,
    artifactId: "builtin_A",
    artifactRevision: 7,
    artifactPage: 3,
    readerMode: true,
    collaboration: false,
    subjectOpen: true,
    applications: { project_A: "window_A", project_B: "window_B" },
    selectedConversations: { project_A: "conversation_A" },
    interactions: { project_A: "history", project_B: "hidden" },
    pinnedInputs: { project_A: true },
    exchangeHeights: { project_A: 240 },
  };
}

test("committed cognitive original clears builtin reading slots without replacing unrelated local scope maps", () => {
  const previous = preferences();
  const next = mergeNavigationPreferences(previous, {
    cognitiveLocation: original,
  });
  assert.equal(next.cognitiveLocation, original);
  assert.equal(next.artifactId, null);
  assert.equal(next.artifactRevision, null);
  assert.equal(next.artifactPage, null);
  assert.equal(next.readerMode, false);
  assert.equal(next.readingTarget, null);
  assert.equal(next.scriptLocation, null);
  assert.equal(next.localFile, undefined);
  for (const field of [
    "applications",
    "selectedConversations",
    "interactions",
    "pinnedInputs",
    "exchangeHeights",
  ] as const)
    assert.equal(next[field], previous[field]);
  assert.equal(previous.artifactId, "builtin_A");
  assert(isNavigationPreferenceChange({ cognitiveLocation: original }));
  assert(isNavigationPreferenceChange({ cognitiveLocation: null }));
  assert(!isNavigationPreferenceChange({ pinnedInputs: { project_A: false } }));
});

test("ordinary destination changes retire cognitive location while settings preserve its exact opaque version", () => {
  const previous = { ...preferences(), cognitiveLocation: original };
  for (const change of [
    { view: "desk" as const },
    { projectId: "project_B" },
    { artifactId: "builtin_B" },
    { applications: { project_A: "window_B" } },
    { scriptLocation: null },
    { selectedConversations: { project_A: "conversation_B" } },
  ])
    assert.equal(
      mergeNavigationPreferences(previous, change).cognitiveLocation,
      null,
    );
  const next = mergeNavigationPreferences(previous, {
    interactions: { project_A: "recent" },
    pinnedInputs: { project_B: true },
    exchangeHeights: { project_B: 160 },
    subjectOpen: false,
  });
  assert.equal(next.cognitiveLocation, original);
  assert.equal(
    next.cognitiveLocation?.locator.object.versionRef,
    original.locator.object.versionRef,
  );
  assert.deepEqual(next.interactions, {
    project_A: "recent",
    project_B: "hidden",
  });
  assert.deepEqual(next.pinnedInputs, { project_A: true, project_B: true });
  assert.deepEqual(next.exchangeHeights, { project_A: 240, project_B: 160 });
  const old = preferences();
  const oldNext = mergeNavigationPreferences(old, { projectId: "project_B" });
  assert(
    !Object.hasOwn(oldNext, "cognitiveLocation"),
    "old preferences do not gain an implicit original field",
  );
  assert.equal(oldNext.applications, old.applications);
});

test("existing bounded navigation trail keeps exact original locators, deduplicates and drops only its forward branch", () => {
  const trail = { places: [] as NavigationPlace[], index: -1 };
  const first: NavigationPlace = {
    ...preferences(),
    cognitiveLocation: original,
  };
  assert(appendNavigationPlace(trail, first, JSON.stringify(first)));
  assert(!appendNavigationPlace(trail, first, JSON.stringify(first)));
  assert.equal(trail.places[0]?.cognitiveLocation, original);
  const changed: NavigationPlace = {
    ...first,
    cognitiveLocation: {
      ...original,
      locator: {
        ...original.locator,
        object: { ...original.locator.object, versionRef: "head/not-number" },
      },
    },
  };
  assert(appendNavigationPlace(trail, changed, JSON.stringify(changed)));
  trail.index = 0;
  const branch: NavigationPlace = {
    ...first,
    cognitiveLocation: null,
    artifactId: "builtin_B",
  };
  assert(appendNavigationPlace(trail, branch, JSON.stringify(branch)));
  assert.deepEqual(trail.places, [first, branch]);
  for (let index = 0; index < 110; index++) {
    const next = { ...branch, artifactId: "builtin_" + index };
    appendNavigationPlace(trail, next, JSON.stringify(next));
  }
  assert.equal(trail.places.length, 100);
  assert.equal(trail.index, 99);
  assert.equal(trail.places.at(-1)?.artifactId, "builtin_109");
});
