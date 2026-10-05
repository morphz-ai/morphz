import { cognitiveBrowserLimits } from "../../../../packages/cognitive-app-sdk/src/browser-wire.js";
import {
  parseCognitiveAppViewResponse,
  type CognitiveAppViewUi,
} from "../../../../packages/core/src/cognitive-app-view-api.js";
import { cognitiveAppDocumentResourcePath } from "../../../../packages/core/src/cognitive-app-document-resource.js";
import { cognitiveDocumentBootstrapProtocol } from "../../../../packages/application/src/cognitive-document-bootstrap.js";
import {
  createCognitiveBrowserChannel,
  type CognitiveBrowserPresentation,
} from "./cognitive-browser-channel.js";
import {
  createCognitiveBrowserRouter,
  type CognitiveBrowserRouterPorts,
} from "./cognitive-browser-router.js";
import { createCognitiveDocumentPort } from "./cognitive-document-port.js";

export type CognitiveDocumentPresentation = CognitiveBrowserPresentation;

/** Trusted mount leaf, not an authority or a React/application owner. The caller
 * must capture the real owner generation in current and retire its signal on
 * permission/identity/owner changes. Neither view props nor ready grant access.
 * No arbitrary URL, credentials, business Window RPC, retry or polling. */
export function createCognitiveDocumentConsumer(options: {
  source: CognitiveAppViewUi;
  container: HTMLElement;
  routerPorts: CognitiveBrowserRouterPorts;
  current(): boolean;
  signal: AbortSignal;
  presentation: CognitiveDocumentPresentation;
  onRetire?(): void;
}) {
  const source = parseCognitiveAppViewResponse("readUi", options.source);
  if (source.manifest.ui.type !== "sandbox")
    throw new Error("Cognitive document has no executable view.");
  const container = options.container;
  const document = container.ownerDocument;
  const appWindow = document.defaultView;
  if (!appWindow || appWindow.location.origin === "null")
    throw new Error("Cognitive document requires a real App origin.");
  const window = appWindow;
  const origin = window.location.origin;
  const proof = window.crypto.randomUUID();
  const iframe = document.createElement("iframe");
  iframe.title = source.manifest.title;
  iframe.referrerPolicy = "no-referrer";
  const resourceUrl = new URL(
    cognitiveAppDocumentResourcePath({
      viewId: source.view.id,
      expectedViewRevision: source.view.revision,
      expectedBindingRevision: source.binding.revision,
      documentProof: proof,
    }),
    window.location.href,
  ).href;
  iframe.src = resourceUrl;
  let live = true,
    mounted = false,
    initialized = false,
    consumed = false,
    loads = 0;
  let channel: ReturnType<typeof createCognitiveBrowserChannel> | undefined;
  let port: ReturnType<typeof createCognitiveDocumentPort> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outerWindow: Window | null = null;
  let settleReady!: (value: boolean) => void;
  const ready = new Promise<boolean>((resolve) => (settleReady = resolve));
  const deadline = window.performance.now() + cognitiveBrowserLimits.deadlineMs;

  function retire() {
    if (!live) return;
    live = false;
    window.removeEventListener("message", peer);
    iframe.removeEventListener("load", loaded);
    options.signal.removeEventListener("abort", retire);
    clearTimeout(timer);
    // Mark the mount dead before channel cancellation. Its outgoing private
    // replies cannot escape through frame.postMessage during cleanup.
    channel?.retire();
    port?.dispose();
    iframe.remove();
    settleReady(false);
    try {
      options.onRetire?.();
    } catch {
      /* A trusted owner callback cannot disclose or interrupt cleanup. */
    }
  }
  function current() {
    if (!live) return false;
    const sameMount = () =>
      document.defaultView === window &&
      window.document === document &&
      window.location.origin === origin &&
      container.ownerDocument === document &&
      container.isConnected &&
      (!mounted ||
        (iframe.parentNode === container &&
          iframe.isConnected &&
          iframe.src === resourceUrl &&
          !iframe.hasAttribute("srcdoc") &&
          outerWindow !== null &&
          iframe.contentWindow === outerWindow));
    const withinStart = () =>
      initialized || window.performance.now() < deadline;
    let valid = false;
    try {
      valid =
        !options.signal.aborted &&
        sameMount() &&
        withinStart() &&
        options.current() &&
        // A trusted guard may synchronously trigger owner cleanup and return
        // a stale true. Never mount, send or dispatch after that retirement.
        live &&
        !options.signal.aborted &&
        sameMount() &&
        withinStart();
    } catch {
      /* The real owner may have retired while evaluating its generation. */
    }
    if (!valid) retire();
    return valid;
  }
  function check(signal?: AbortSignal) {
    if (!current() || signal?.aborted) throw { code: "unavailable" };
  }
  async function guarded<T>(work: () => Promise<T>, signal?: AbortSignal) {
    check(signal);
    const value = await work();
    check(signal);
    return value;
  }
  const router = createCognitiveBrowserRouter(source, {
    call: (method, parameters, callOptions) =>
      guarded(
        () => options.routerPorts.call(method, parameters, callOptions),
        callOptions.signal,
      ),
    openObject: (request, signal) =>
      guarded(() => options.routerPorts.openObject(request, signal), signal),
    compose: (request, signal) =>
      guarded(() => options.routerPorts.compose(request, signal), signal),
  });
  const frame = {
    postMessage(message: unknown, _targetOrigin: string) {
      check();
      if (!port) throw { code: "unavailable" };
      port.send(JSON.stringify(message));
      check();
      if (
        !initialized &&
        message &&
        typeof message === "object" &&
        Object.getOwnPropertyDescriptor(message, "type")?.value ===
          "morphz-cognitive-ui/v1:init"
      ) {
        initialized = true;
        clearTimeout(timer);
        settleReady(true);
      }
    },
  };
  channel = createCognitiveBrowserChannel(
    router.context(options.presentation),
    {
      frame,
      current,
      authorize: (context, signal) =>
        guarded(() => router.authorize(context, signal), signal).then(
          () => undefined,
        ),
      request: (request, context, signal) =>
        guarded(() => router.request(request, context, signal), signal),
      onRetire: retire,
    },
  );
  function loaded() {
    // The first actual load is not a parser/SDK handshake. A subsequent load
    // retires this exact endpoint; it never installs a replacement bridge.
    if (!current()) return;
    if (++loads > 1) retire();
  }
  function peer(event: MessageEvent<unknown>) {
    let descriptors: PropertyDescriptorMap | undefined;
    try {
      if (event.data && typeof event.data === "object")
        descriptors = Object.getOwnPropertyDescriptors(event.data);
    } catch {
      /* Scope below still rejects messages from our own outer window. */
    }
    const sameSource = outerWindow !== null && event.source === outerWindow;
    const copiedProof = descriptors?.proof?.value === proof;
    // Multiple consumers share this listener target. An unrelated mount owns
    // its transferred ports: never close another application's valid endpoint.
    if (!sameSource && !copiedProof) return;
    function rejectPorts() {
      for (const transferred of event.ports) transferred.close();
    }
    if (!current()) return rejectPorts();
    const keys = descriptors && Reflect.ownKeys(descriptors);
    if (
      !sameSource ||
      event.origin !== origin ||
      consumed ||
      !descriptors ||
      keys?.length !== 2 ||
      !("value" in (descriptors.protocol ?? {})) ||
      !("value" in (descriptors.proof ?? {})) ||
      descriptors.protocol?.value !== cognitiveDocumentBootstrapProtocol ||
      descriptors.proof?.value !== proof ||
      event.ports.length !== 1
    )
      return rejectPorts();
    consumed = true;
    port = createCognitiveDocumentPort(event.ports[0]!, {
      onWire(text) {
        check();
        void channel!.receive({
          source: frame,
          origin: "null",
          data: JSON.parse(text),
        });
      },
      onReady() {
        check();
        void channel!.loaded();
      },
      onRetire: retire,
    });
    if (!current()) port.dispose();
  }
  window.addEventListener("message", peer);
  iframe.addEventListener("load", loaded);
  options.signal.addEventListener("abort", retire, { once: true });
  if (current()) {
    timer = setTimeout(
      retire,
      Math.max(0, Math.ceil(deadline - window.performance.now())),
    );
    container.append(iframe);
    outerWindow = iframe.contentWindow;
    mounted = true;
    current();
  }
  return Object.freeze({
    ready,
    retire,
    async updatePresentation(presentation: CognitiveDocumentPresentation) {
      if (!current()) return;
      await channel!.updatePresentation(presentation);
      current();
    },
  });
}
