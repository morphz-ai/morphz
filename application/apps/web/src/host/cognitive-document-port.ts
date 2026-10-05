import { parseWireJson } from "../../../../packages/cognitive-app-sdk/src/protocol.js";
import { cognitiveDocumentWireWindow } from "../../../../packages/application/src/cognitive-document-bootstrap.js";

export class CognitiveDocumentPortError extends Error {
  constructor(readonly code: "busy" | "retired" | "invalid") {
    super(`Cognitive document transport ${code}.`);
  }
}

function wire(text: unknown): string {
  if (
    typeof text !== "string" ||
    text.length > 524_288 ||
    new TextEncoder().encode(text).byteLength > 524_288
  )
    throw new CognitiveDocumentPortError("invalid");
  parseWireJson(JSON.parse(text));
  return text;
}

/** Trusted, private endpoint only; never expose its native port to author code.
 * A credit acknowledges synchronous transport consumption, not a business ACK.
 * No queued send, promise buffer, retry, authority, URL or window listener. */
export function createCognitiveDocumentPort(
  port: MessagePort,
  callbacks: {
    onWire(text: string): void;
    onReady(): void;
    onRetire(): void;
  },
) {
  let retired = false,
    ready = false,
    earlyConnect = false;
  let sentSequence = 0,
    creditedSequence = 0,
    receivedSequence = 0;
  const timer = setTimeout(retire, 30_000);
  function retire() {
    if (retired) return;
    retired = true;
    clearTimeout(timer);
    port.removeEventListener("message", receive);
    port.removeEventListener("messageerror", retire);
    port.close();
    try {
      callbacks.onRetire();
    } catch {
      /* No potentially private author/Host failure is logged or disclosed. */
    }
  }
  function active() {
    if (retired) throw new CognitiveDocumentPortError("retired");
  }
  function receive(event: MessageEvent<unknown>) {
    if (retired) return;
    try {
      // Native structured clone is data-only; still inspect own descriptors
      // before reading fields, including controlled malformed-ingress tests.
      const message = event.data;
      if (!message || typeof message !== "object" || Array.isArray(message))
        throw new CognitiveDocumentPortError("invalid");
      const descriptors = Object.getOwnPropertyDescriptors(message);
      const keys = Reflect.ownKeys(descriptors);
      const kind = descriptors.kind;
      if (!kind || !("value" in kind))
        throw new CognitiveDocumentPortError("invalid");
      if (kind.value === "parser-ready") {
        if (keys.length !== 1 || ready)
          throw new CognitiveDocumentPortError("invalid");
        ready = true;
        clearTimeout(timer);
        callbacks.onReady();
        active();
        return;
      }
      if (keys.length !== 2) throw new CognitiveDocumentPortError("invalid");
      if (kind.value === "credit") {
        const sequence = descriptors.sequence;
        if (
          !sequence ||
          !("value" in sequence) ||
          !Number.isSafeInteger(sequence.value) ||
          sequence.value !== creditedSequence + 1 ||
          sequence.value > sentSequence
        )
          throw new CognitiveDocumentPortError("invalid");
        creditedSequence = sequence.value;
        return;
      }
      const text = descriptors.text;
      if (kind.value !== "wire" || !text || !("value" in text))
        throw new CognitiveDocumentPortError("invalid");
      const detachedText = wire(text.value);
      if (!ready) {
        const connect = JSON.parse(detachedText);
        if (
          earlyConnect ||
          !connect ||
          typeof connect !== "object" ||
          Array.isArray(connect) ||
          Object.keys(connect).length !== 1 ||
          connect.type !== "morphz-cognitive-ui/v1:connect"
        )
          throw new CognitiveDocumentPortError("invalid");
        // The actual Browser channel can mark connected, but cannot authorize
        // or initialize until the original prefix's parser-ready also arrives.
        earlyConnect = true;
      }
      callbacks.onWire(detachedText);
      active();
      if (!Number.isSafeInteger(receivedSequence + 1))
        throw new CognitiveDocumentPortError("invalid");
      receivedSequence++;
      port.postMessage({ kind: "credit", sequence: receivedSequence });
    } catch {
      retire();
    }
  }
  port.addEventListener("message", receive);
  port.addEventListener("messageerror", retire);
  port.start();
  return Object.freeze({
    send(text: string) {
      active();
      if (!ready) throw new CognitiveDocumentPortError("busy");
      if (sentSequence - creditedSequence >= cognitiveDocumentWireWindow)
        throw new CognitiveDocumentPortError("busy");
      const detachedText = wire(text);
      active();
      if (!Number.isSafeInteger(sentSequence + 1)) {
        retire();
        throw new CognitiveDocumentPortError("retired");
      }
      sentSequence++;
      try {
        port.postMessage({ kind: "wire", text: detachedText });
      } catch {
        retire();
        throw new CognitiveDocumentPortError("retired");
      }
    },
    check: active,
    dispose: retire,
  });
}
