export const maxMessageAttachmentBytes = 20 * 1024 * 1024;
export const maxMessageImageBytes = 6 * 1024 * 1024;
export const maxMessageTextBytes = 8 * 1024 * 1024;

/** Validate size before reading a local file and again at the upload boundary. */
export function messageAttachmentSizeIssue(file: {
  name: string;
  size: number;
}): string | null {
  if (file.size === 0) return "不能添加空文件。";
  if (file.size > maxMessageAttachmentBytes) return "附件不能超过 20 MB。";
  if (
    /\.(png|jpe?g|webp)$/i.test(file.name) &&
    file.size > maxMessageImageBytes
  )
    return "图片不能超过 6 MB。";
  if (
    /\.(txt|md|markdown)$/i.test(file.name) &&
    file.size > maxMessageTextBytes
  )
    return "文本文件不能超过 8 MB。";
  return null;
}
