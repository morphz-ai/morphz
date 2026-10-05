import {
  parseCognitiveAppObjectLocator,
  type CognitiveAppObjectLocator,
} from "../../../../packages/core/src/cognitive-app-object-locator.js";

/** A local reading position, not an application grant or a business snapshot.
 * Reading it always goes through the current Human original owner. */
export type CognitiveNavigationLocation = Readonly<{
  kind: "original";
  locator: CognitiveAppObjectLocator;
}>;

export function cognitiveNavigationLocation(
  raw: unknown,
): CognitiveNavigationLocation | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("原件阅读位置无效。");
  const keys = Reflect.ownKeys(raw);
  const kind = Object.getOwnPropertyDescriptor(raw, "kind");
  const locator = Object.getOwnPropertyDescriptor(raw, "locator");
  if (
    keys.length !== 2 ||
    !kind ||
    !locator ||
    !kind.enumerable ||
    !locator.enumerable ||
    !("value" in kind) ||
    !("value" in locator) ||
    kind.value !== "original"
  )
    throw new Error("原件阅读位置无效。");
  return Object.freeze({
    kind: "original",
    locator: parseCognitiveAppObjectLocator(locator.value),
  });
}
