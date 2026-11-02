/** A bounded test-only readiness signal; no rendering-frame or I/O polling. */
export async function waitForFixtureReadySignal(
  ready: Promise<void>,
  milliseconds: number,
  label: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label}: ${milliseconds}ms deadline exceeded`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
