import { SpeechService } from "../apps/service/src/speech.js";
import { loadServiceEnvironment } from "../apps/service/src/environment.js";
import { readSpeechWav } from "../packages/core/src/audio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
loadServiceEnvironment();
const speech = new SpeechService(process.env.DOUBAO_API_KEY);
if (!speech.configured()) throw new Error("DOUBAO_API_KEY 未配置。");
const directory = mkdtempSync(join(tmpdir(), "morphz-speech-test-"));
try {
  const text = "你好，这是一段合成语音，用于测试语音输入。";
  const wav = await speech.synthesize(
    "synthetic-test",
    text,
    AbortSignal.timeout(60000),
  );
  const pcm = readSpeechWav(wav);
  writeFileSync(join(directory, "synthetic.wav"), wav, { mode: 0o600 });
  console.log(
    `PASS: Doubao TTS returned ${pcm.length / 32000} seconds of synthetic PCM speech.`,
  );
  const transcript = await speech.transcribe(
    "synthetic-test",
    wav,
    AbortSignal.timeout(60000),
  );
  if (!transcript.includes("语音"))
    throw new Error("识别结果未包含合成短句的预期词语。");
  console.log("PASS: Doubao ASR transcribed the synthetic audio:", transcript);
  console.log("Synthetic fixture:", join(directory, "synthetic.wav"));
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({
      status: "passed",
      transcript,
      seconds: pcm.length / 32000,
    }),
    { mode: 0o600 },
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "语音测试失败。";
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: "failed", message }),
    { mode: 0o600 },
  );
  console.error(message);
  process.exitCode = 1;
}
