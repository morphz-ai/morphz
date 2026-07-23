import assert from 'node:assert/strict'
import test from 'node:test'

import { copyTextToClipboard, type ClipboardEnvironment } from '../src/utils/clipboard.ts'

test('uses Clipboard API in a secure context', async () => {
  const calls: string[] = []
  const environment: ClipboardEnvironment = {
    secureContext: true,
    writeText: async text => { calls.push(`modern:${text}`) },
    legacyCopy: text => { calls.push(`legacy:${text}`); return true },
  }

  await copyTextToClipboard('hello', environment)
  assert.deepEqual(calls, ['modern:hello'])
})

test('uses the synchronous fallback on an insecure HTTP origin', async () => {
  const calls: string[] = []
  const environment: ClipboardEnvironment = {
    secureContext: false,
    writeText: async text => { calls.push(`modern:${text}`) },
    legacyCopy: text => { calls.push(`legacy:${text}`); return true },
  }

  await copyTextToClipboard('局域网消息', environment)
  assert.deepEqual(calls, ['legacy:局域网消息'])
})

test('falls back when the secure Clipboard API rejects the request', async () => {
  const calls: string[] = []
  const environment: ClipboardEnvironment = {
    secureContext: true,
    writeText: async text => {
      calls.push(`modern:${text}`)
      throw new Error('permission denied')
    },
    legacyCopy: text => { calls.push(`legacy:${text}`); return true },
  }

  await copyTextToClipboard('fallback', environment)
  assert.deepEqual(calls, ['modern:fallback', 'legacy:fallback'])
})

test('reports failure when neither clipboard mechanism succeeds', async () => {
  const environment: ClipboardEnvironment = {
    secureContext: false,
    legacyCopy: () => false,
  }

  await assert.rejects(copyTextToClipboard('unavailable', environment), /Clipboard access is unavailable/)
})
