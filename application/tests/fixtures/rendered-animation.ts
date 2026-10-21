import { expect } from "@playwright/test";

/** A periodic animation can revisit the same pixels at different times. Sample
 * its freely advancing rendered output, not just one arbitrary frame pair.
 * A static or invisible animation still fails the bounded pixel assertion. */
export async function expectRenderedFrameChange(
  readFrame: () => Promise<Buffer>,
  options: { timeout: number; intervals?: number[] },
) {
  const first = await readFrame();
  await expect
    .poll(async () => !(await readFrame()).equals(first), {
      message: "The freely advancing animation must change actual rendered pixels",
      timeout: options.timeout,
      intervals: options.intervals ?? [100, 200, 350],
    })
    .toBe(true);
}
