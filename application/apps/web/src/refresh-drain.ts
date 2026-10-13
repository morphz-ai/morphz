/** Coalesce a burst, but never lose an invalidation arriving during a read.
 * All requesters await the final read, not an older in-flight snapshot. */
export function createRefreshDrain(read: () => Promise<boolean>) {
  let requested = 0,
    settled = 0,
    retries = 0,
    pending: Promise<boolean> | null = null;
  return {
    /** Only the reader can requeue a changed snapshot. Bound retries per drain
     * so a continuously changing directory cannot strand the caller forever. */
    retry(): boolean {
      if (!pending || retries >= 2) return false;
      retries++;
      requested++;
      return true;
    },
    request(): Promise<boolean> {
      requested++;
      if (!pending) {
        pending = Promise.resolve().then(async () => {
          try {
            let result = false;
            do {
              const target = requested;
              result = await read();
              settled = target;
            } while (settled !== requested);
            return result;
          } finally {
            // Clear in this continuation, not a later .finally microtask:
            // a hint after the loop ends must create its own fresh drain.
            pending = null;
            retries = 0;
          }
        });
      }
      return pending;
    },
  };
}
