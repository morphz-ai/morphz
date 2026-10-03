const failurePath = "/__desktop_startup_error";

function escapeHTML(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function errorSummary(error) {
  return String(error?.message ?? error)
    .replace(/https?:\/\/[^\s'"<>]+/g, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return "[URL]";
      }
    })
    .slice(0, 1000);
}

// No script, bridge, external resource or business operation. The one link
// navigates to the configured trusted root using the existing main-frame gate.
function failurePage(message, mainURL) {
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Morphz · 界面恢复</title><style>
:root{color-scheme:light dark;font:15px/1.6 system-ui,sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:560px;padding:32px}h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 20px}a{display:inline-block;padding:10px 18px;border-radius:10px;background:CanvasText;color:Canvas;text-decoration:none}
a:focus-visible{outline:3px solid Highlight;outline-offset:4px}
details{margin-top:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}
</style><main><h1>界面未能载入</h1>
<p>你的数据和设置没有被重置。可以重新加载界面，后台工作不会因此重新发起。</p>
<a href="${escapeHTML(mainURL)}">重新加载界面</a>
<details><summary>错误详情</summary><pre>${escapeHTML(message)}</pre></details>
</main></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "Cache-Control": "no-store",
      },
    },
  );
}

module.exports = { failurePath, failurePage, errorSummary };
