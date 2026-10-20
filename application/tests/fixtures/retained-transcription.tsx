import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SpeechDialog } from "../../apps/web/src/SpeechDialog.js";
import { useWorkspace, type SpeechScope } from "../../apps/web/src/client.js";
import "virtual:application-styles";

// The standalone product entry was withdrawn. This explicitly isolated
// component fixture keeps its recorder/error/save coverage without inventing
// an entry in the production App. Client, speech capture and HTTP are real.
function Fixture() {
  const client = useWorkspace();
  const [scene, setScene] = useState<{ scope: SpeechScope; title: string } | null>(null);
  const [inserted, setInserted] = useState("");
  Reflect.set(window, "retainedTranscription", {
    open: (value: NonNullable<typeof scene>) => setScene(value),
  });
  return (
    <div className="app" data-appearance="light">
      <main>
        <p role="status">{client.online ? "测试组件已连接" : "测试组件连接中"}</p>
        <textarea aria-label="测试组件插入结果" value={inserted} readOnly />
        {scene && client.online && (
          <SpeechDialog
            client={client}
            scope={scene.scope}
            title={scene.title}
            onClose={() => setScene(null)}
            onInsert={(text) => {
              // Controlled consumer port, not a claim that the removed
              // standalone App entry still owns the current composer.
              if (text.length > 30000)
                throw new Error("测试接收方容量已满；文字不会被截断。");
              setInserted(text);
              setScene(null);
            }}
          />
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
