import { expect, type Locator } from "@playwright/test";
import {
  reasoningLabels,
  type ReasoningEffort,
} from "../packages/core/src/inference.js";

/** Exercise the real ordinal range using keyboard input, not synthetic change
 * events. Non-menu task editors intentionally keep their existing select. */
export async function chooseReasoning(
  control: Locator,
  effort: ReasoningEffort,
) {
  const stops = (await control.getAttribute("data-efforts"))?.split(",") ?? [];
  const index = stops.indexOf(effort);
  expect(
    index,
    `Expected ${effort} in Runtime-provided stops`,
  ).toBeGreaterThanOrEqual(0);
  await expect(control).toBeEnabled();
  await control.focus();
  await control.press("Home");
  for (let point = 0; point < index; point++) await control.press("ArrowRight");
  await expect(control).toHaveValue(String(index));
  await expect(control).toHaveAttribute(
    "aria-valuetext",
    reasoningLabels[effort],
  );
}
