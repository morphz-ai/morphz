import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ScriptStudio } from "../../apps/web/src/ScriptStudio.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import { initialWorkspace } from "../../packages/core/src/model.js";
import {
  emptyScriptBrief,
  emptyScriptDraft,
  defaultScriptExportTemplate,
  type ScriptDraft,
} from "../../packages/core/src/script-studio.js";
import { scriptDirectoryItemSchema } from "../../packages/core/src/script-editor.js";
import type {
  ScriptEditorProduction,
  ScriptEditorVersion,
} from "../../apps/web/src/script-editor-reader.js";
import type { PlatformContent } from "../../apps/web/src/platform-client.js";
import { scriptLibraryEntryFromContent } from "../../apps/web/src/platform-workspace-view.js";
import type { ApplicationInstance } from "../../packages/core/src/applications.js";

// Complete production consumer; only Client/native request ports are controlled.
// This does not claim HTTP authorization, persisted SQL or OS picker validation.
const now = "2026-10-04T00:00:00.000Z";
const author = { principalId: "local-owner", actantId: "local-human" };
type Config = {
  active: boolean;
  online: boolean;
  client: string;
  center: string;
  principal: string;
  csrf: string;
  width: number;
  show: boolean;
  global: boolean;
  ready: boolean;
  catalogVersion: number;
  instanceRevision: number;
  navigationId?: string;
  scriptTarget?: null;
  locationRequest?: {
    productionId: string;
    itemId?: string;
    requestId: string;
    view?: "library" | "editor";
    revision?: number;
  };
  start: { productionId: string; itemId: string; view: "library" | "editor" };
};
type Pending = {
  id: number;
  kind: string;
  args: unknown[];
  client: string;
  held: boolean;
  settled: boolean;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  value: () => unknown;
};
export function mountScriptWorkspace(Component: typeof ScriptStudio) {
  const root = createRoot(document.getElementById("root")!);
  let config: Config,
    change: (value: Partial<Config>) => void,
    serial = 0;
  let requests: Pending[] = [],
    events: unknown[][] = [],
    holds: string[] = [];
  let books = new Map<string, ScriptEditorProduction>();
  let versions = new Map<string, ScriptEditorVersion>();
  let commands = 0,
    storageFailure = "",
    unmounted = false;
  let exports: {
    id: string;
    productionId: string;
    items: { itemId: string; revision: number }[];
  }[] = [];
  const observers = new Set<ResizeObserver | IntersectionObserver>();
  const NativeObserver = ResizeObserver;
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  };
  const NativeIntersectionObserver = IntersectionObserver;
  window.IntersectionObserver = class extends NativeIntersectionObserver {
    constructor(
      callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      super(callback, options);
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  };
  const storageSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage) {
      events.push(["storage", key, JSON.parse(value)]);
      if (storageFailure && key.includes(storageFailure))
        throw Error("TEST storage unavailable");
    }
    return storageSet.call(this, key, value);
  };
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const add = document.addEventListener.bind(document),
    remove = document.removeEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (["pointerdown", "keydown", "focusin"].includes(type)) {
      const key =
        type +
        ":" +
        (typeof options === "boolean" ? options : !!options?.capture);
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(listener);
    }
    add(type, listener, options);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    listeners
      .get(
        type +
          ":" +
          (typeof options === "boolean" ? options : !!options?.capture),
      )
      ?.delete(listener);
    remove(type, listener, options);
  }) as typeof document.removeEventListener;

  function putVersion(
    book: ScriptEditorProduction,
    id: string,
    revision: number,
    draft: ScriptDraft,
  ) {
    versions.set(`${book.id}:${id}:${revision}`, {
      productionId: book.id,
      itemId: id,
      kind: "episode",
      status: "draft",
      headRevision: revision,
      workflowRevision: 1,
      revision,
      candidateId: null,
      author,
      createdAt: now,
      approvalForRequestedVersion: null,
      draft: structuredClone(draft),
    });
  }
  function addBook(id: string, title: string, withItems = true) {
    const book: ScriptEditorProduction = {
      id,
      projectId: "first-project",
      title,
      revision: 1,
      activityRevision: 1,
      creativeEpoch: 1,
      brief: structuredClone(emptyScriptBrief),
      reviewerPrincipalIds: ["local-owner"],
      template: structuredClone(defaultScriptExportTemplate),
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      totals: {
        items: withItems ? 1 : 0,
        candidates: 0,
        pendingCandidates: 0,
        reviews: 0,
        pendingReviews: 0,
        exports: 0,
        metadataVersions: 1,
      },
      contentId: "catalog-" + id,
      catalogRevision: 1,
      providerRevision: 1,
      items: [],
    };
    books.set(id, book);
    if (withItems)
      addItem(book, "item-" + id, emptyScriptDraft(title + "第一集"));
    return book;
  }
  function addItem(
    book: ScriptEditorProduction,
    id: string,
    draft: ScriptDraft,
  ) {
    draft = { ...draft, text: draft.text || "TEST 原保存正文 " + id };
    book.items.push(
      scriptDirectoryItemSchema.parse({
        id,
        kind: "episode",
        revision: 1,
        workflowRevision: 1,
        status: "draft",
        title: draft.title,
        parentId: null,
        order: draft.order,
        basis: draft.basis,
        dependencies: [],
        characters: [],
        approval: null,
        textCharacters: draft.text.length,
        sourceCount: 0,
        pendingCandidateCount: 0,
        currentPendingReviewCount: 0,
        blockingReviewCount: 0,
        hasText: true,
        approvalCurrent: false,
      }),
    );
    book.totals.items = book.items.length;
    putVersion(book, id, 1, draft);
  }
  function entries(): PlatformContent[] {
    return [...books.values()].map((p) => ({
      id: p.contentId,
      appId: "morphz.script-studio",
      instanceId: "studio-provider",
      providerRevision: 1,
      appObjectId: p.id,
      projectId: p.projectId,
      kind: "script",
      title: p.title,
      observedVersionRef: String(p.activityRevision),
      availability: "available",
      revision: p.catalogRevision,
      createdAt: now,
      updatedAt: now,
    }));
  }
  function request(
    kind: string,
    args: unknown[],
    value: () => unknown,
    label: string,
    signal?: AbortSignal,
  ) {
    const id = requests.length,
      held = holds.some(
        (rule) => rule === kind || rule === kind + ":" + args[0],
      );
    events.push(["request", kind, id, label]);
    return new Promise<unknown>((resolve, reject) => {
      const pending: Pending = {
        id,
        kind,
        args: structuredClone(args),
        client: label,
        held,
        settled: false,
        signal,
        resolve,
        reject,
        value,
      };
      requests.push(pending);
      if (!held) {
        pending.settled = true;
        resolve(value());
      }
    });
  }
  function mutate(operation: Record<string, unknown>) {
    if (operation.type !== "script-command") return { entityId: "instance-A" };
    const command = operation.command as Record<string, unknown>,
      action = command.action;
    if (action === "create-production") {
      const id = "created-production-" + ++commands;
      addBook(id, String(command.title), false);
      change({ catalogVersion: config.catalogVersion + 1 });
      return { entityId: id };
    }
    const book = books.get(String(command.productionId))!;
    if (action === "create-item") {
      const id = "created-item-" + ++commands;
      addItem(book, id, command.draft as ScriptDraft);
      book.activityRevision++;
      change({ catalogVersion: config.catalogVersion + 1 });
      return { entityId: id };
    }
    if (action === "revise-item") {
      const item = book.items.find((i) => i.id === command.itemId)!;
      if (item.revision !== command.expectedRevision)
        throw Error("TEST CAS：原版本已变化");
      item.revision++;
      item.title = (command.draft as ScriptDraft).title;
      putVersion(book, item.id, item.revision, command.draft as ScriptDraft);
      book.activityRevision++;
      change({ catalogVersion: config.catalogVersion + 1 });
      return { entityId: item.id };
    }
    if (action === "record-export") {
      const id = "export-" + ++commands;
      exports.push({
        id,
        productionId: book.id,
        items: command.items as { itemId: string; revision: number }[],
      });
      book.totals.exports++;
      return { entityId: id };
    }
    if (action === "update-production") {
      book.title = String(command.title);
      book.revision++;
      book.activityRevision++;
      book.brief = command.brief as typeof book.brief;
      book.template = command.template as typeof book.template;
      book.reviewerPrincipalIds = command.reviewerPrincipalIds as string[];
      change({ catalogVersion: config.catalogVersion + 1 });
    }
    return { entityId: book.id };
  }
  const defaults: Config = {
    active: true,
    online: true,
    client: "A",
    center: "center-A",
    principal: "local-owner",
    csrf: "csrf-A",
    width: 1040,
    show: true,
    global: false,
    ready: true,
    catalogVersion: 1,
    instanceRevision: 7,
    start: {
      productionId: "production-A",
      itemId: "item-production-A",
      view: "editor",
    },
  };
  function Frame({ initial }: { initial: Partial<Config> }) {
    const [value, setValue] = useState({ ...defaults, ...initial });
    config = value;
    change = (patch) => setValue((previous) => ({ ...previous, ...patch }));
    const workspace = initialWorkspace(now),
      contents = entries(),
      label = value.client;
    const boot = {
      centerId: value.center,
      principalId: value.principal,
      csrfToken: value.csrf,
      actantId: "local-human",
      workspace,
      scriptLibrary: value.ready
        ? contents.map(scriptLibraryEntryFromContent)
        : [],
      runtime: { configured: false, connected: false, harnesses: [] },
    };
    const client = {
      boot,
      online: value.online,
      contentCatalog: contents,
      contentCatalogVersion: value.catalogVersion,
      getSnapshot: () => {
        events.push(["snapshot", label, config.center, config.principal]);
        return { centerId: config.center, principalId: config.principal };
      },
      execute: (operation: Record<string, unknown>) =>
        request("execute", [operation], () => mutate(operation), label),
      readScriptEditor: (id: string) =>
        request("editor", [id], () => structuredClone(books.get(id)), label),
      readScriptVersion: (
        p: ScriptEditorProduction,
        id: string,
        revision?: number,
      ) =>
        request(
          "version",
          [p.id, id, revision ?? null],
          () =>
            structuredClone(
              versions.get(
                `${p.id}:${id}:${revision ?? books.get(p.id)!.items.find((i) => i.id === id)!.revision}`,
              ),
            ),
          label,
        ),
      readScriptEditorPage: (
        p: ScriptEditorProduction,
        panel: string,
        itemId?: string,
      ) =>
        request(
          "page-" + panel,
          [p.id, itemId ?? null, p.activityRevision],
          () =>
            panel === "exports"
              ? {
                  exports: exports
                    .filter((e) => e.productionId === p.id)
                    .map((e) => ({
                      ...e,
                      createdAt: now,
                      contextRevision: 1,
                      workingCopy: true,
                    })),
                }
              : panel === "versions"
                ? {
                    versions: [...versions.values()]
                      .filter(
                        (v) => v.productionId === p.id && v.itemId === itemId,
                      )
                      .map((v) => ({
                        revision: v.revision,
                        createdAt: now,
                        author,
                      })),
                  }
                : { reviews: [], events: [] },
          label,
        ),
      readScriptExport: (p: ScriptEditorProduction, id: string) =>
        request(
          "export",
          [p.id, id],
          () => ({
            ...exports.find((e) => e.id === id),
            createdAt: now,
            contextRevision: 1,
            workingCopy: true,
          }),
          label,
        ),
      readScriptVersionTitle: (
        p: ScriptEditorProduction,
        id: string,
        revision: number,
      ) =>
        request(
          "title",
          [p.id, id, revision],
          () => versions.get(`${p.id}:${id}:${revision}`)!.draft.title,
          label,
        ),
      readScriptExportManifest: (p: ScriptEditorProduction, id: string) =>
        request(
          "manifest",
          [p.id, id],
          () => {
            throw Error("TEST web manifest controlled separately");
          },
          label,
        ),
      resolveCatalogContent: (id: string) =>
        request(
          "catalog",
          [id],
          () => entries().find((e) => e.id === id),
          label,
        ),
      listContentPage: (options: { query?: string }, signal: AbortSignal) =>
        request(
          "directory",
          [options],
          () => ({
            items: contents.filter(
              (e) => !options.query || e.title.includes(options.query),
            ),
          }),
          label,
          signal,
        ),
      countContent: (options: { query?: string }, signal: AbortSignal) =>
        request(
          "count",
          [options],
          () => [
            {
              count: contents.filter(
                (e) => !options.query || e.title.includes(options.query),
              ).length,
            },
          ],
          label,
          signal,
        ),
      readScriptOverview: (entry: { id: string }) =>
        request(
          "overview",
          [entry.id],
          () => ({
            brief: books.get(entry.id)!.brief,
            progress: {
              episodes: books.get(entry.id)!.items.length,
              scenes: 0,
              pendingCandidates: 0,
            },
          }),
          label,
        ),
    } as unknown as WorkspaceClient;
    const instance = {
      id: "instance-A",
      workspaceId: "first-project",
      revision: value.instanceRevision,
      state: {
        ...value.start,
        ...(value.navigationId
          ? {
              navigationId: value.navigationId,
              scriptTarget: value.scriptTarget,
              view: "library",
            }
          : {}),
      },
    } as ApplicationInstance;
    return (
      <div
        className="app without-collaboration"
        data-appearance="light"
        data-accent="cyan"
      >
        <div className="workspace" style={{ width: value.width }}>
          <div className="workspace-body">
            <main className="primary-panel">
              {value.show && (
                <Component
                  client={client}
                  instance={instance}
                  activeView={value.active}
                  globalLibrary={value.global}
                  locationRequest={value.locationRequest}
                  onNavigate={(...args) =>
                    events.push(["navigate", label, ...args])
                  }
                  onOpenScript={(id, itemId) => {
                    events.push(["open", label, id, itemId ?? null]);
                    change({
                      locationRequest: {
                        productionId: id,
                        itemId,
                        requestId: "open-" + ++commands,
                      },
                    });
                  }}
                  onLibrary={() => events.push(["global-library", label])}
                  onNotice={(text) => events.push(["notice", label, text])}
                  onCompose={(...args) => {
                    events.push(["compose", label, ...args]);
                    return { ok: true };
                  }}
                  onConceive={() => events.push(["conceive", label])}
                  onNativeDialog={(open) =>
                    events.push([
                      "native-dialog",
                      label,
                      open,
                      !!document.querySelector("dialog[open]"),
                      !!document.querySelector<HTMLButtonElement>(
                        ".script-toolbar button:disabled",
                      ),
                    ])
                  }
                />
              )}
            </main>
          </div>
        </div>
      </div>
    );
  }
  Reflect.set(window, "morphzDesktop", {
    application: {},
    scriptExports: {
      save: (input: Record<string, unknown>) => {
        events.push([
          "native-start",
          input,
          document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.textContent?.trim(),
        ]);
        return request(
          "native",
          [input],
          () => ({ status: "cancelled", exportId: input.exportId }),
          config.client,
        );
      },
    },
  });
  function reset(initial: Partial<Config> = {}, keepStorage = false) {
    flushSync(() => root.render(null));
    for (const r of requests)
      if (!r.settled) {
        r.settled = true;
        r.resolve(undefined);
      }
    requests = [];
    events = [];
    holds = [];
    commands = 0;
    storageFailure = "";
    unmounted = false;
    exports = [];
    books = new Map();
    versions = new Map();
    addBook("production-A", "TEST 雨夜");
    addBook("production-B", "TEST 回信");
    if (!keepStorage) localStorage.clear();
    flushSync(() =>
      root.render(
        <StrictMode>
          <Frame key={++serial} initial={initial} />
        </StrictMode>,
      ),
    );
  }
  async function settle() {
    await Promise.resolve();
    await new Promise<void>((done) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        done();
      };
      channel.port2.postMessage(null);
    });
    await Promise.resolve();
  }
  function report() {
    const active = document.activeElement,
      section = document.querySelector<HTMLElement>(".script-studio");
    return {
      dom: document.getElementById("root")!.innerHTML,
      active: active
        ? {
            tag: active.tagName,
            id: active.id,
            label: active.getAttribute("aria-label"),
            text: active.textContent?.trim(),
            class: active.className,
            ...(active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement
              ? { selection: [active.selectionStart, active.selectionEnd] }
              : {}),
          }
        : null,
      fields: [
        ...document.querySelectorAll<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >("input,textarea,select"),
      ].map((n) => ({
        label: n.getAttribute("aria-label"),
        value: n.value,
        disabled: n.disabled,
        checked: n instanceof HTMLInputElement ? n.checked : null,
      })),
      requests: requests.map(
        ({ id, kind, args, client, held, settled, signal }) => ({
          id,
          kind,
          args,
          client,
          held,
          settled,
          aborted: signal?.aborted ?? false,
        }),
      ),
      events: [...events],
      storage: Object.fromEntries(
        Object.keys(localStorage)
          .sort()
          .map((k) => [k, localStorage.getItem(k)]),
      ),
      config,
      width: section?.clientWidth ?? null,
      observers: observers.size,
      listeners: [...listeners]
        .map(([key, set]) => [key, set.size])
        .filter(([, size]) => size),
      unmounted,
    };
  }
  Reflect.set(window, "scriptWorkspaceFixture", {
    report,
    settle,
    reset,
    async run(name: string, value: unknown) {
      if (name === "set") flushSync(() => change(value as Partial<Config>));
      else if (name === "hold") holds = value as string[];
      else if (name === "storageFailure") storageFailure = String(value);
      else if (name === "resolve") {
        const { id, error, reply } = value as {
            id: number;
            error?: string;
            reply?: unknown;
          },
          r = requests[id]!;
        if (!r || r.settled) throw Error("No held request " + id);
        r.settled = true;
        events.push(["resolved", r.kind, id]);
        if (error) r.reject(Error(error));
        else {
          try {
            r.resolve(reply ?? r.value());
          } catch (e) {
            r.reject(e as Error);
          }
        }
      } else if (name === "revise") {
        const book = books.get("production-A")!,
          item = book.items[0]!;
        item.revision++;
        book.activityRevision++;
        putVersion(book, item.id, item.revision, {
          ...emptyScriptDraft(item.title),
          text: "TEST 中心新稿",
        });
        flushSync(() => change({ catalogVersion: config.catalogVersion + 1 }));
      } else if (name === "seedExports") {
        exports = [
          {
            id: "historical-export-1",
            productionId: "production-A",
            items: [{ itemId: "item-production-A", revision: 1 }],
          },
          {
            id: "historical-export-2",
            productionId: "production-A",
            items: [{ itemId: "item-production-A", revision: 1 }],
          },
        ];
        books.get("production-A")!.totals.exports = 2;
      } else if (name === "unmount") {
        flushSync(() => root.render(null));
        unmounted = true;
      } else throw Error("Unknown operation " + name);
      await settle();
      return report();
    },
    async cleanup() {
      flushSync(() => root.unmount());
      unmounted = true;
      for (const r of requests)
        if (!r.settled) {
          r.settled = true;
          r.resolve(undefined);
        }
      await settle();
      Storage.prototype.setItem = storageSet;
      window.ResizeObserver = NativeObserver;
      window.IntersectionObserver = NativeIntersectionObserver;
      return report();
    },
  });
  // The driver makes the first real mount explicitly. Avoid an unobserved warm
  // mount before independent historical/current roots start their same ledger.
}
