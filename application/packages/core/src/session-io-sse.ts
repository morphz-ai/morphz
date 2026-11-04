/** Shared framing for the existing Session IO stream. A frame and its cursor
 * remain bounded; clients decide which typed public events they can present. */
export async function* sessionIoFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ data: unknown; id?: string }> {
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true }),
    encoder = new TextEncoder();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  let buffer = "";
  try {
    for (;;) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) return;
      buffer = (
        buffer + decoder.decode(result.value, { stream: true })
      ).replaceAll("\r\n", "\n");
      if (encoder.encode(buffer).length > 4 * 1024 * 1024)
        throw new Error("IO frame exceeds bounds");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split("\n");
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const id = lines
          .findLast((line) => line.startsWith("id:"))
          ?.slice(3)
          .trimStart();
        if (id && id.length > 2048) throw new Error("IO cursor exceeds bounds");
        yield { data: JSON.parse(data), ...(id ? { id } : {}) };
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
