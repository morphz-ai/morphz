/** A detached development window may outlive its launcher's output pipes. */
function protectStandardStreams(streams = [process.stdout, process.stderr]) {
  const onError = (error) => {
    // Do not log here: Electron also logs IPC errors and would recurse into
    // the same closed pipe. Other stream failures must remain observable.
    if (error.code !== "EPIPE") throw error;
  };
  for (const stream of streams) stream.on("error", onError);
  return () => {
    for (const stream of streams) stream.off("error", onError);
  };
}
module.exports = { protectStandardStreams };
