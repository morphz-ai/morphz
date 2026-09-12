import { SpeechService } from "../apps/service/src/speech.js";
import { loadServiceEnvironment } from "../apps/service/src/environment.js";
import { wavFromPCM } from "../packages/core/src/audio.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
loadServiceEnvironment();
const speech = new SpeechService(process.env.DOUBAO_API_KEY);
if (!speech.configured()) throw new Error("DOUBAO_API_KEY 未配置。");
const directory = mkdtempSync(join(tmpdir(), "morphz-asr-test-"));
try {
  execFileSync(
    "/usr/bin/say",
    [
      "-v",
      "Tingting",
      "-o",
      join(directory, "synthetic.aiff"),
      "你好，这是一段合成语音，用于测试语音输入。",
    ],
    { timeout: 15000, stdio: "ignore" },
  );
  const pcm = execFileSync(
    "/opt/homebrew/bin/ffmpeg",
    [
      "-v",
      "error",
      "-i",
      join(directory, "synthetic.aiff"),
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      "pipe:1",
    ],
    { timeout: 15000, maxBuffer: 2000000 },
  );
  const wav = wavFromPCM(pcm);
  writeFileSync(join(directory, "synthetic.wav"), wav, { mode: 0o600 });
  const transcript = await speech.transcribe(
    "synthetic-test",
    wav,
    AbortSignal.timeout(60000),
  );
  if (!transcript.includes("语音"))
    throw new Error("识别结果未包含合成短句的预期词语。");
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: "passed", transcript }),
    { mode: 0o600 },
  );
  console.log(
    "PASS: Doubao ASR transcribed locally synthesized audio:",
    transcript,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "语音识别测试失败。";
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: "failed", message }),
    { mode: 0o600 },
  );
  console.error(message);
  process.exitCode = 1;
}
console.log("Synthetic test directory:", directory);
