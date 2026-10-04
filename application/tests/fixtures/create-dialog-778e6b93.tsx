// Actual Git 778e6b9384e67612801999aa76a17b70a4551efd; full old function, not a candidate-derived oracle.
// Only export/name are adapted. Normal tests need neither Git nor shell.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  scopedStorage,
  draftKey,
} from "../../apps/web/src/local-preferences.js";
import type { useWorkspace } from "../../apps/web/src/client.js";
import { useModal } from "../../apps/web/src/useModal.js";

export const fixedCreationRevision = "778e6b9384e67612801999aa76a17b70a4551efd";
export const fixedCreationAppSha =
  "85b1520ab5271c4f4a7d86d59daf727b15b9824dc0219369e186f3acf6095265";
export const fixedCreationFunctionSha =
  "f52985b727e085f0263fb27e9a26898466f58f47720951946d85e67d8832b60c";
export const fixedCreationConsumers = {
  document:
    '<CreateDialog\n                  key={project.id}\n                  kind="document"\n                  toolbarTarget={detailToolbarTarget}\n                  projectId={project.id}\n                  client={client}\n                  onClose={() => setCreating(null)}\n                  onCreated={(id) => {\n                    setCreating(null);\n                    void openObject(project.id, id);\n                  }}\n                />',
  project:
    '<CreateDialog\n          kind={creating}\n          projectId={project.id}\n          client={client}\n          onClose={() => setCreating(null)}\n          prepareCreated={\n            creating === "project" ? prepareCreatedProject : undefined\n          }\n          onCreated={(id, kind) => {\n            setCreating(null);\n            if (kind !== "project") void openObject(project.id, id);\n          }}\n        />',
} as const;
export const fixedCreationConsumerSha = {
  document: "d8d75c79fe415327c413a620bd55fccdcb637ae1178d7fdc115b847a228fc2b5",
  project: "62fcd7f0f270cd250cff576a95bdfd57d48a3fa9d632fcaee5b2bace48965d27",
} as const;
export const fixedCreationDependencySha = {
  useModal: "f9f45b71766ac08a3ae47ff3a5b4300a61193f2fef17e76f99ab63924781cac4",
  storage: "505dff560588587948f1b0f067af97c2c41967c4dec414250a3a335e2d13963f",
  topbar: "dbbbc54997a508feebefeff532ab3f2953ec859ba5f4ed881c0ce247f5e750e7",
} as const;

export function FixedCreateDialog({
  kind,
  projectId,
  client,
  onClose,
  onCreated,
  prepareCreated,
  toolbarTarget,
}: {
  kind: "document" | "project";
  projectId: string;
  client: ReturnType<typeof useWorkspace>;
  onClose: () => void;
  onCreated: (id: string, kind: string) => void;
  prepareCreated?: () => (id: string, kind: string) => void;
  toolbarTarget?: HTMLElement | null;
}) {
  const [storage] = useState(() => scopedStorage());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const draftId = draftKey("create-document:" + projectId);
  const cached =
    kind === "document"
      ? storage.readLocal<{ title: string; markdown: string }>(draftId, {
          title: "",
          markdown: "",
        })
      : { title: "", markdown: "" };
  const dialog = useRef<HTMLDialogElement>(null),
    [title, setTitle] = useState(cached.title),
    [markdown, setMarkdown] = useState(cached.markdown),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useModal(dialog);
  useEffect(() => {
    if (kind === "document") {
      try {
        storage.writeLocal(draftId, { title, markdown });
      } catch {
        setError("草稿未能保存，请保留当前页面。\n");
      }
    }
  }, [title, markdown, kind, draftId, storage]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError("");
    const created = prepareCreated?.();
    try {
      const result = await client.execute(
        kind === "project"
          ? { type: "create-project", title }
          : {
              type: "create-artifact",
              projectId,
              title,
              content: { kind: "document", markdown },
            },
      );
      if (kind === "document") {
        try {
          storage.writeLocal(draftId, { title: "", markdown: "" });
        } catch {
          /* Creation already succeeded; never repeat it on a local storage failure. */
        }
      }
      created?.(result.entityId, kind);
      if (alive.current) onCreated(result.entityId, kind);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "创建失败。");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const heading = (
    <header className={kind === "document" ? "draft-toolbar" : undefined}>
      <h2 id="create-title">{kind === "project" ? "新建项目" : "新建文档"}</h2>
      <button
        type="button"
        aria-label="关闭新建窗口"
        disabled={busy}
        onClick={onClose}
      >
        <X />
      </button>
    </header>
  );
  const form = (
    <form onSubmit={(e) => void submit(e)}>
      {kind === "document"
        ? toolbarTarget && createPortal(heading, toolbarTarget)
        : heading}
      {kind === "document" ? (
        <div>
          <label className="field">
            标题
            <input
              autoFocus
              aria-label="新对象标题"
              maxLength={180}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
        </div>
      ) : (
        <div className="dialog-input-row">
          <input
            aria-label="项目名称"
            placeholder="项目名称"
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </div>
      )}
      {kind === "document" && (
        <label className="field">
          正文 · Markdown
          <textarea
            aria-label="新文档正文"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={8}
            placeholder="开始写作…"
          />
        </label>
      )}
      {error && (
        <div role="alert" className="form-error">
          {error}
        </div>
      )}
      {kind === "document" && (
        <footer>
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy || !title.trim()}>
            {busy ? "保存中…" : "创建"}
          </button>
        </footer>
      )}
    </form>
  );
  if (kind === "document")
    return (
      <section className="document-draft" aria-label="新建文档编辑区">
        {form}
      </section>
    );
  return (
    <dialog
      ref={dialog}
      className="create-dialog project-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="create-title"
    >
      {form}
    </dialog>
  );
}
