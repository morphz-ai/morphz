// Independently captured actual Git 4b78347258effed9d90e270576e4ab094b59d0a4.
// Only four finite original JSX/action recipes; no whole App/Host archive.
// Historical finite migration provenance; current CI does not lock whole neighbors.
export const originalBuiltinIntegrationMetadata = {
  git: "4b78347258effed9d90e270576e4ab094b59d0a4",
  source: "application/apps/web/src/ApplicationHost.tsx",
  recipes: {
    BrowserHost: {
      sha256:
        "7982789cec0aa70f08d0e0c87f7243d3cef75f72838a041619d4c561697d156f",
      firstLine: 414,
      lineCount: 25,
      bytes: 1063,
    },
    Reader: {
      sha256:
        "39077398a30096658495640a892105852122630325d355a69a324132d4e3bfd2",
      firstLine: 440,
      lineCount: 23,
      bytes: 928,
    },
    ScriptStudio: {
      sha256:
        "3e0e03eeaa911cb1339e024e37a03c80114ff3b7ca2bd588ef6eb70a12a117b5",
      firstLine: 464,
      lineCount: 16,
      bytes: 680,
    },
    recent: {
      sha256:
        "0f1b6b5db7ef9cdbb009e9facc48aad682bbb6bf3121af8ad7a53820cadda775",
      firstLine: 320,
      lineCount: 9,
      bytes: 402,
    },
  },
} as const;

export const originalBuiltinIntegrationRecipes = {
  BrowserHost:
    '              <BrowserHost\n                client={client}\n                activeView={foreground && active?.id === instance.id}\n                onReturn={() => onActivate(null)}\n                returnLabel={spaceKind(space) === "desk" ? "工作台" : "项目"}\n                onInput={onInput}\n                projectId={workspaceId}\n                initialURL={\n                  typeof instance.state.url === "string"\n                    ? instance.state.url\n                    : ""\n                }\n                onPage={(page) => {\n                  onBrowserPage?.(page);\n                  if (page && page.url !== instance.state.url)\n                    void client\n                      .execute({\n                        type: "set-application-state",\n                        instanceId: instance.id,\n                        expectedRevision: instance.revision,\n                        state: { ...instance.state, url: page.url },\n                      })\n                      .catch((e) => onNotice(e.message));\n                }}\n              />',
  Reader:
    '              <Reader\n                client={client}\n                projectId={workspaceId}\n                artifactId={\n                  typeof instance.state.artifactId === "string"\n                    ? instance.state.artifactId\n                    : undefined\n                }\n                revision={readingRevision}\n                target={readingTarget}\n                active={foreground && active?.id === instance.id}\n                globalLibrary={globalLibrary}\n                onOpen={onReadingOpen}\n                onLibrary={onReadingLibrary}\n                onJump={onReadingJump}\n                onTargetConsumed={onReadingTargetConsumed}\n                onCompose={onReadingCompose}\n                onContext={\n                  active?.id === instance.id ? onReadingContext : undefined\n                }\n                onNotice={onNotice}\n                onNativeDialog={onNativeDialog}\n              />',
  ScriptStudio:
    '              <ScriptStudio\n                onNativeDialog={onNativeDialog}\n                client={client}\n                instance={instance}\n                locationRequest={scriptLocation}\n                onNavigate={onScriptNavigate}\n                activeView={foreground && active?.id === instance.id}\n                onCompose={(text, generation) =>\n                  onCompose(text, undefined, generation)\n                }\n                onConceive={() => onComposeIntent("script")}\n                globalLibrary={globalLibrary}\n                onOpenScript={onOpenScript}\n                onLibrary={onScriptLibrary}\n                onNotice={onNotice}\n              />',
  recent:
    '                      onClick={() =>\n                        listingKind(entry) === "script"\n                          ? onOpenScript(\n                              entry.kind === "catalog"\n                                ? entry.value.appObjectId\n                                : entry.value.id,\n                            )\n                          : onOpen(entry.value.id)\n                      }',
} as const;

// Compile the complete fixed JSX/action recipes against the actual components.
// Only five explicit generic-context substitutions are permitted; no candidate
// function body is used as an oracle. The whole historical Host stays in /tmp.
export function fixedBuiltinModuleSource() {
  const mapped = (raw: string) =>
    raw
      .replaceAll("foreground && active?.id === instance.id", "activeView")
      .replace("onReturn={() => onActivate(null)}", "onReturn={onReturn}")
      .replace('spaceKind(space) === "desk" ? "工作台" : "项目"', "returnLabel")
      .replace(
        "active?.id === instance.id ? onReadingContext : undefined",
        "selected ? onReadingContext : undefined",
      );
  const recent = originalBuiltinIntegrationRecipes.recent;
  const expression = recent.slice(
    recent.indexOf("listingKind(entry)"),
    recent.lastIndexOf("\n                      }"),
  );
  return `import {ScriptStudio} from '/src/ScriptStudio.tsx';
import {BrowserHost} from '/src/BrowserHost.tsx';
import {Reader} from '/src/Reader.tsx';
import {listingKind} from '/src/catalog-content-entries.ts';
export function createFixedBuiltinAdapters({client,scriptLocation,onScriptNavigate,onOpenScript,onScriptLibrary,globalLibrary=false,onBrowserPage,onInput,onNativeDialog,readingTarget,readingRevision,onReadingOpen,onReadingCompose,onReadingContext,onReadingLibrary,onReadingJump,onReadingTargetConsumed,onCompose,onComposeIntent,onOpen,onNotice}) {
 function renderBuiltin({view,instance,workspaceId,selected,activeView,onReturn,returnLabel,fallback}) {
  return view==='browser'?(${mapped(originalBuiltinIntegrationRecipes.BrowserHost)}):view==='reader'?(${mapped(originalBuiltinIntegrationRecipes.Reader)}):view==='script-studio'?(${mapped(originalBuiltinIntegrationRecipes.ScriptStudio)}):fallback;
 }
 const openRecentContent=entry=>${expression};
 return {renderBuiltin,openRecentContent};
}`;
}
