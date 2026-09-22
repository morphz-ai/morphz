import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
function pdfAssets() {
  const files = new Map<string, Buffer>();
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    const root = resolve("node_modules/pdfjs-dist", directory);
    for (const file of readdirSync(root))
      if (!file.startsWith("LICENSE"))
        files.set(
          `pdfjs/${directory}/${file}`,
          readFileSync(resolve(root, file)),
        );
  }
  // OCR is a separate, lazy Desktop process. Bundle its fixed runtime locally;
  // only the model archives require the user's explicit download confirmation.
  for (const file of [
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
  ])
    files.set(
      `ocr-runtime/${file}`,
      readFileSync(resolve("node_modules/onnxruntime-web/dist", file)),
    );
  return {
    name: "local-pdf-assets",
    generateBundle(this: {
      emitFile: (asset: {
        type: "asset";
        fileName: string;
        source: Buffer;
      }) => unknown;
    }) {
      for (const [fileName, source] of files)
        this.emitFile({ type: "asset", fileName, source });
    },
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const file = files.get(req.url?.slice(1) ?? "");
        if (!file) return next();
        res.setHeader(
          "Content-Type",
          req.url?.endsWith(".wasm")
            ? "application/wasm"
            : "application/octet-stream",
        );
        res.end(file);
      });
    },
  };
}
export default defineConfig({
  root: "apps/web",
  plugins: [react(), pdfAssets()],
  // A running bundled desktop can still request a lazy chunk from its loaded
  // build. Keep content-addressed assets across local rebuilds; deleting them
  // would blank that window when it first opens a PDF before a full reload.
  build: {
    outDir: "../../dist/web",
    emptyOutDir: false,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        app: resolve("apps/web/index.html"),
        ocr: resolve("apps/web/ocr.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 65419,
    strictPort: true,
    // Pin the local HMR endpoint; desktop development shares this Vite server.
    hmr: { host: "127.0.0.1", clientPort: 65419 },
    proxy: { "/api": { target: "http://127.0.0.1:65420" } },
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; font-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws://127.0.0.1:65419; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    },
  },
});
