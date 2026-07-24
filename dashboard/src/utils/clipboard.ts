export interface ClipboardEnvironment {
  secureContext: boolean
  writeText?: (text: string) => Promise<void>
  legacyCopy: (text: string) => boolean
}

function legacyBrowserCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const selection = window.getSelection()
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []

  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute('aria-hidden', 'true')
  Object.assign(textarea.style, {
    position: 'fixed',
    inset: '0 auto auto 0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  })
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied: boolean
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
    if (selection) {
      selection.removeAllRanges()
      savedRanges.forEach(range => selection.addRange(range))
    }
    activeElement?.focus({ preventScroll: true })
  }
  return copied
}

function browserClipboardEnvironment(): ClipboardEnvironment {
  const clipboard = navigator.clipboard
  return {
    secureContext: window.isSecureContext,
    writeText: clipboard?.writeText
      ? clipboard.writeText.bind(clipboard)
      : undefined,
    legacyCopy: legacyBrowserCopy,
  }
}

export async function copyTextToClipboard(
  text: string,
  environment: ClipboardEnvironment = browserClipboardEnvironment(),
): Promise<void> {
  let clipboardError: unknown
  if (environment.secureContext && environment.writeText) {
    try {
      await environment.writeText(text)
      return
    } catch (error) {
      clipboardError = error
    }
  }

  if (environment.legacyCopy(text)) return
  if (clipboardError instanceof Error) throw clipboardError
  throw new Error('Clipboard access is unavailable')
}
