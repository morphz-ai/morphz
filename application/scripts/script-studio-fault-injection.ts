/** Test-only transport gates. Never load this module in the application or Runtime. */
import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export const scriptFaultPoints = [
  "model-discussion",
  "model-intent",
  "model-create",
  "model-review-1",
  "model-revise-1",
  "model-review-2",
  "model-revise-2",
  "model-delivery",
  "model-relay",
  "host-read-1",
  "host-read-2",
  "host-read-3",
  "host-read-4",
  "host-read-5",
  "host-submit-before",
  "host-submit-after",
] as const;
export type ScriptFaultPoint = (typeof scriptFaultPoints)[number];

export class ScriptFaultGate {
  hit: { point: string; metadata: unknown } | null = null;
  private resume?: () => void;
  constructor(readonly point: ScriptFaultPoint) {}
  async pause(point: string, metadata: unknown) {
    if (this.hit || this.point !== point) return;
    this.hit = { point, metadata };
    await new Promise<void>((resolve) => {
      this.resume = resolve;
    });
  }
  release() {
    this.resume?.();
  }
}

export async function scriptFaultProxy(
  upstreamPath: string,
  gate: ScriptFaultGate,
) {
  const directory = realpathSync(mkdtempSync("/tmp/morphz-hns-fault-"));
  const path = join(directory, "host.sock");
  const sockets = new Set<Socket>();
  const readJobs = new Map<string, number>();
  const calls: {
    action: string;
    jobId: string;
    toolCallId: string;
    completed: boolean;
    response?: unknown;
  }[] = [];
  let error: Error | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((socket) => {
    track(socket);
    let buffer = Buffer.alloc(0),
      dispatched = false;
    socket.on("data", (chunk) => {
      if (dispatched) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE();
      if (length > 4 * 1024 * 1024 || buffer.length > length + 4) {
        socket.destroy();
        return;
      }
      if (buffer.length !== length + 4) return;
      dispatched = true;
      void (async () => {
        const frame = buffer;
        const envelope = JSON.parse(frame.subarray(4).toString());
        const request = envelope.request;
        assert.equal(request.arguments.action, "script");
        const action = String(request.arguments.script.action);
        const jobId = String(request.invocation.job_id);
        const toolCallId = String(request.invocation.tool_call_id);
        const call: (typeof calls)[number] = {
          action,
          jobId,
          toolCallId,
          completed: false,
        };
        calls.push(call);
        const key = jobId + ":" + toolCallId;
        if (action === "read-workflow") {
          if (!readJobs.has(key)) readJobs.set(key, readJobs.size + 1);
          await gate.pause("host-read-" + readJobs.get(key), call);
        } else if (action === "submit-workflow")
          await gate.pause("host-submit-before", call);
        else throw new Error("Unexpected Host operation: " + action);
        if (socket.destroyed) return;
        const remote = track(createConnection(upstreamPath));
        socket.once("close", () => remote.destroy());
        const response = await new Promise<Buffer>((resolve, reject) => {
          let bytes = Buffer.alloc(0),
            done = false;
          remote.once("connect", () => remote.write(frame));
          remote.on("data", (data) => {
            bytes = Buffer.concat([bytes, data]);
            if (
              bytes.length >= 4 &&
              bytes.length === bytes.readUInt32BE() + 4
            ) {
              done = true;
              resolve(bytes);
            }
          });
          remote.once("error", reject);
          remote.once("close", () => {
            if (!done)
              reject(new Error("Upstream closed before a full receipt"));
          });
        });
        call.completed = true;
        const reply = JSON.parse(response.subarray(4).toString());
        call.response = reply;
        assert.equal(
          reply.ok,
          true,
          "Real Host transport must succeed: " + JSON.stringify(reply),
        );
        assert.equal(
          reply.value.ok,
          true,
          "Real Host domain operation must succeed",
        );
        if (action === "submit-workflow") {
          await gate.pause("host-submit-after", call);
        }
        if (!socket.destroyed) socket.end(response);
      })().catch((cause: unknown) => {
        // Losing a deliberately killed peer is expected; a domain/protocol failure is not.
        if (!socket.destroyed) {
          error = cause instanceof Error ? cause : new Error(String(cause));
          socket.destroy();
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    path,
    calls,
    get error() {
      return error;
    },
    async close() {
      gate.release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmdirSync(directory);
    },
  };
}
