import type { ReactNode } from "react";
import type { ScriptGeneration } from "../../../../packages/core/src/script-studio.js";
import type { ScriptLocation } from "../../../../packages/core/src/script-delivery.js";
import type { InputIntent } from "../../../../packages/core/src/input-intent.js";
import type { ReaderTarget } from "../../../../packages/core/src/reader.js";
import type { WorkspaceClient } from "../client.js";
import type { BuiltinApplicationSurface } from "../ApplicationHost.js";
import { ScriptStudio, type ScriptComposeResult } from "../ScriptStudio.js";
import { BrowserHost } from "../BrowserHost.js";
import { Reader, type ReadingCompose } from "../Reader.js";
import type { ReadingContextChange } from "../ReadingContext.js";
import type { BrowserView } from "../desktop.js";
import {
  listingKind,
  type CatalogContentEntry,
} from "../catalog-content-entries.js";

export type BuiltinApplicationOptions = {
  client: WorkspaceClient;
  scriptLocation?: ScriptLocation & {
    requestId: string;
    view?: "library" | "editor";
  };
  onScriptNavigate?: (
    productionId: string,
    itemId: string,
    view: "library" | "editor",
  ) => void;
  globalLibrary?: boolean;
  onOpenScript: (id: string, itemId?: string) => void;
  onScriptLibrary: () => void;
  onBrowserPage?: (page: BrowserView | null) => void;
  onInput?: () => void;
  onNativeDialog?: (open: boolean) => void;
  readingTarget?: ReaderTarget | null;
  readingRevision?: number | null;
  onReadingOpen: (id: string) => void;
  onReadingCompose: ReadingCompose;
  onReadingContext: ReadingContextChange;
  onReadingLibrary: () => void;
  onReadingJump: (target: ReaderTarget) => void;
  onReadingTargetConsumed: (requestId: string) => void;
  onCompose: (
    text: string,
    artifactId?: string,
    scriptGeneration?: ScriptGeneration,
  ) => ScriptComposeResult;
  onComposeIntent: (intent: InputIntent) => void;
  onOpen: (id: string) => void;
  onNotice: (message: string) => void;
};

/** Trusted, render-captured builtin UI integration; not a sandbox capability.
 * Construction borrows ports only. Child components own their lifecycles. */
export function createBuiltinApplicationAdapters({
  client,
  scriptLocation,
  onScriptNavigate,
  onOpenScript,
  onScriptLibrary,
  globalLibrary = false,
  onBrowserPage,
  onInput,
  onNativeDialog,
  readingTarget,
  readingRevision,
  onReadingOpen,
  onReadingCompose,
  onReadingContext,
  onReadingLibrary,
  onReadingJump,
  onReadingTargetConsumed,
  onCompose,
  onComposeIntent,
  onOpen,
  onNotice,
}: BuiltinApplicationOptions) {
  function renderBuiltin({
    view,
    instance,
    workspaceId,
    selected,
    activeView,
    onReturn,
    returnLabel,
    fallback,
  }: BuiltinApplicationSurface): ReactNode {
    return view === "browser" ? (
      <BrowserHost
        client={client}
        activeView={activeView}
        onReturn={onReturn}
        returnLabel={returnLabel}
        onInput={onInput}
        projectId={workspaceId}
        initialURL={
          typeof instance.state.url === "string" ? instance.state.url : ""
        }
        onPage={(page) => {
          onBrowserPage?.(page);
          if (page && page.url !== instance.state.url)
            void client
              .execute({
                type: "set-application-state",
                instanceId: instance.id,
                expectedRevision: instance.revision,
                state: { ...instance.state, url: page.url },
              })
              .catch((e) => onNotice(e.message));
        }}
      />
    ) : view === "reader" ? (
      <Reader
        client={client}
        projectId={workspaceId}
        artifactId={
          typeof instance.state.artifactId === "string"
            ? instance.state.artifactId
            : undefined
        }
        revision={readingRevision}
        target={readingTarget}
        active={activeView}
        globalLibrary={globalLibrary}
        onOpen={onReadingOpen}
        onLibrary={onReadingLibrary}
        onJump={onReadingJump}
        onTargetConsumed={onReadingTargetConsumed}
        onCompose={onReadingCompose}
        onContext={selected ? onReadingContext : undefined}
        onNotice={onNotice}
        onNativeDialog={onNativeDialog}
      />
    ) : view === "script-studio" ? (
      <ScriptStudio
        onNativeDialog={onNativeDialog}
        client={client}
        instance={instance}
        locationRequest={scriptLocation}
        onNavigate={onScriptNavigate}
        activeView={activeView}
        onCompose={(text, generation) => onCompose(text, undefined, generation)}
        onConceive={() => onComposeIntent("script")}
        globalLibrary={globalLibrary}
        onOpenScript={onOpenScript}
        onLibrary={onScriptLibrary}
        onNotice={onNotice}
      />
    ) : (
      fallback
    );
  }
  const openRecentContent = (entry: CatalogContentEntry) =>
    listingKind(entry) === "script"
      ? onOpenScript(
          entry.kind === "catalog" ? entry.value.appObjectId : entry.value.id,
        )
      : onOpen(entry.value.id);
  return { renderBuiltin, openRecentContent };
}
