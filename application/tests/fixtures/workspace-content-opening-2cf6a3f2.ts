import type { WorkspaceClient } from "../../apps/web/src/client.js";
import type {
  createWorkspaceNavigationCommands,
  NavigationOwner,
  NavigationPreferences,
} from "../../apps/web/src/host/use-workspace-navigation.js";
import type { Workspace } from "../../packages/core/src/model.js";
import type { ReadingLocation } from "../../packages/core/src/reader.js";

type Commands = ReturnType<
  typeof createWorkspaceNavigationCommands<NavigationPreferences>
>;
export type FixedContentOpeningBindings = {
  origin: { isActive(): boolean };
  navigation: Pick<NavigationOwner, "beginIntent" | "isCurrent">;
  state: Pick<Workspace, "artifacts"> | undefined;
  client: Pick<
    WorkspaceClient,
    "boot" | "contentCatalog" | "resolveCatalogContent" | "resolveArtifact"
  >;
  setWebsiteIntent(value: string | null): void;
  setNotice(message: string): void;
  openScriptLocation: Commands["openScriptLocation"];
  openObject: Commands["openObject"];
};

// Complete original declarations from actual Git 2cf6a3f2 App, independently
// captured before production edits. No candidate-derived algorithm or baseline.
export const fixedContentOpeningHashes = {
  openUser: "6ca8996a8a25f548554da5f945ffa6ed51f3c862a4ab66cbc101856210caf827",
  openReading:
    "95361cffed26a0c69c59ef524de590b3ce7f4331655123e3b4e6648a90fe826b",
} as const;

export function createFixedWorkspaceContentOpening(
  bindings: FixedContentOpeningBindings,
) {
  const {
    origin,
    navigation,
    state,
    client,
    setWebsiteIntent,
    setNotice,
    openScriptLocation,
    openObject,
  } = bindings;
  async function openUser(
    id: string,
    revision?: number,
    page?: number,
    reading?: ReadingLocation,
  ) {
    if (!origin.isActive()) return;
    try {
      const script = client.boot?.scriptLibrary.find(
        (item) => item.id === id || item.contentId === id,
      );
      if (script) return openScriptLocation({ productionId: script.id });
      const generation = navigation.beginIntent();
      const loadedArtifact = state?.artifacts.find((item) => item.id === id);
      const catalogEntry =
        client.contentCatalog.find((entry) => entry.id === id) ??
        (!loadedArtifact ? await client.resolveCatalogContent(id) : null);
      if (!origin.isActive() || !navigation.isCurrent(generation)) return;
      if (
        catalogEntry?.appId === "morphz.script-studio" &&
        catalogEntry.kind === "script"
      )
        return openScriptLocation({ productionId: catalogEntry.appObjectId });
      const a = loadedArtifact ?? (await client.resolveArtifact(id));
      if (!origin.isActive() || !navigation.isCurrent(generation)) return;
      if (!a) {
        setNotice("对象暂时无法读取，请检查连接或访问权限后重试。");
        return;
      }
      setWebsiteIntent(a?.content.kind === "website" ? a.id : null);
      void openObject(a.projectId, id, revision, page, !!reading, reading);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "内容暂时无法打开，请重试。",
      );
    }
  }
  async function openReading(id: string) {
    if (!origin.isActive()) return;
    const generation = navigation.beginIntent();
    const a =
      state?.artifacts.find((a) => a.id === id) ??
      (await client.resolveArtifact(id));
    if (!origin.isActive() || !navigation.isCurrent(generation)) return;
    if (a) await openObject(a.projectId, id, undefined, undefined, true);
  }
  return { openUser, openReading };
}
