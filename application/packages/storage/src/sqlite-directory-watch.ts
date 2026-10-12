import { EventEmitter } from "node:events";
import {
  watch,
  watchFile,
  unwatchFile,
  type FSWatcher,
  type Stats,
} from "node:fs";

export type SqlitePathWatch = (
  target: string,
  options: { persistent: boolean },
  listener: (event: string, entry: string | null) => void,
) => FSWatcher;

/** macOS directory FSEvents teardown can synchronously stall Node for seconds.
 * Only directory metadata uses libuv stat observation there; database/WAL file
 * events remain native. Unchanged directories do not trigger any SQL or scan. */
export const watchSqliteDirectory: SqlitePathWatch = (
  target,
  options,
  listener,
) => {
  if (process.platform !== "darwin") return watch(target, options, listener);
  let closed = false;
  const changed = (current: Stats, previous: Stats) => {
    if (
      closed ||
      (current.dev === previous.dev &&
        current.ino === previous.ino &&
        current.mtimeMs === previous.mtimeMs &&
        current.ctimeMs === previous.ctimeMs &&
        current.nlink === previous.nlink)
    )
      return;
    listener("rename", null);
  };
  const observer = watchFile(
    target,
    { persistent: options.persistent, interval: 250 },
    changed,
  );
  const events = new EventEmitter() as FSWatcher;
  const failed = (error: Error) => {
    if (!closed) events.emit("error", error);
  };
  observer.on("error", failed);
  events.close = () => {
    if (closed) return;
    closed = true;
    observer.removeListener("error", failed);
    unwatchFile(target, changed);
  };
  events.ref = () => {
    observer.ref();
    return events;
  };
  events.unref = () => {
    observer.unref();
    return events;
  };
  return events;
};
