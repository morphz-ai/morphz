import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";
import {
  parseCognitiveAppViewRequest,
  type CognitiveAppViewRequestMap,
} from "../../../../packages/core/src/cognitive-app-view-api.js";

/** A local reading position, not an application grant or a business snapshot.
 * Restore always crosses the appropriate current-Human read owner. */
export type CognitiveNavigationLocation =
  | Readonly<{ kind: "original"; locator: CognitiveAppObjectLocator }>
  | Readonly<{
      kind: "view";
      slot: Readonly<CognitiveAppViewRequestMap["locate"]>;
    }>;

export function cognitiveNavigationLocation(
  raw: unknown,
): CognitiveNavigationLocation | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("原件阅读位置无效。");
  const keys = Reflect.ownKeys(raw);
  const kind = Object.getOwnPropertyDescriptor(raw, "kind");
  if (keys.length !== 2 || !kind?.enumerable || !("value" in kind))
    throw new Error("原件阅读位置无效。");
  const value = Object.getOwnPropertyDescriptor(
    raw,
    kind.value === "original" ? "locator" : "slot",
  );
  if (!value?.enumerable || !("value" in value))
    throw new Error("原件阅读位置无效。");
  if (kind.value === "original")
    return Object.freeze({
      kind: "original",
      locator: parseCognitiveAppObjectLocator(value.value),
    });
  if (kind.value === "view")
    return Object.freeze({
      kind: "view",
      slot: Object.freeze(parseCognitiveAppViewRequest("locate", value.value)),
    });
  throw new Error("原件阅读位置无效。");
}
