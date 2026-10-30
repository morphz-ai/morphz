// Use the pinned framework's own Node prerender boundary for the built Worker.
// vinext 1.0 imports optional Cloudflare tracing at module evaluation. Its
// official loader leaves tracing absent and throws on every Worker binding;
// HTML assertions still execute the real bundle, with no permissive API mocks.
const loaderUrl = new URL(
  "./prerender-cloudflare-loader.js",
  import.meta.resolve("vinext/internal/build/run-prerender"),
);
const { registerPrerenderCloudflareLoader } = await import(loaderUrl.href);
registerPrerenderCloudflareLoader();
