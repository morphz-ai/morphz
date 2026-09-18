export const speechSampleRate = 16000;
// Transport bounds apply to ONE segment, never to a recording or a book.
export const speechCaptureSegmentSeconds = 10;
export const maxSpeechSegmentSeconds = 30;
export const maxSpeechSegmentBytes =
  44 + speechSampleRate * 2 * maxSpeechSegmentSeconds;
export const maxTtsSegmentCharacters = 2000;
export function wavFromPCM(pcm: Uint8Array): Uint8Array {
  if (pcm.length % 2) throw new Error("PCM 数据不完整。");
  const wav = new Uint8Array(44 + pcm.length),
    view = new DataView(wav.buffer);
  function ascii(offset: number, s: string) {
    for (let i = 0; i < s.length; i++) wav[offset + i] = s.charCodeAt(i);
  }
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, speechSampleRate, true);
  view.setUint32(28, speechSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}
/** Bounded canonical upload format; arbitrary media never reaches a decoder. */
export function readSpeechWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 46 || bytes.length > maxSpeechSegmentBytes)
    throw new Error("语音分段格式或大小无效，请重新开始语音输入。");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    text = (a: number, b: number) =>
      new TextDecoder().decode(bytes.slice(a, b));
  if (
    text(0, 4) !== "RIFF" ||
    text(8, 12) !== "WAVE" ||
    text(12, 16) !== "fmt " ||
    text(36, 40) !== "data" ||
    view.getUint32(4, true) !== bytes.length - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== speechSampleRate ||
    view.getUint32(28, true) !== speechSampleRate * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes.length - 44 ||
    (bytes.length - 44) % 2
  )
    throw new Error("录音格式需要为单声道 16kHz、16 位 PCM WAV。");
  return bytes.slice(44);
}
