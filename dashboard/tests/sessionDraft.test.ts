import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearSessionDraft,
  createDraftClientMessageId,
  readSessionDraft,
  sessionDraftStorageKey,
  writeSessionDraft,
  type PersistedSessionDraft,
} from '../src/app/sessionDraft.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

test('Session drafts are isolated by Principal and Session and retain staging ids', () => {
  const storage = memoryStorage()
  const draft: PersistedSessionDraft = {
    version: 1,
    principalId: 'principal/a',
    sessionId: 'session:a',
    clientMessageId: 'dashboard-message-1',
    text: 'unsent text',
    attachments: [{
      id: 'stage-1',
      stageId: 'stage-1',
      name: 'manual.pdf',
      mediaType: 'application/pdf',
      size: 42,
      offset: 42,
      status: 'ready',
      sha256: 'a'.repeat(64),
    }],
    references: [{ sessionId: 'session-b', title: 'B', contextId: 'context-b' }],
    updatedAt: '2026-09-02T00:00:00Z',
  }
  writeSessionDraft(storage, draft)

  assert.deepEqual(readSessionDraft(storage, 'principal/a', 'session:a'), draft)
  assert.equal(readSessionDraft(storage, 'principal/b', 'session:a'), undefined)
  assert.equal(readSessionDraft(storage, 'principal/a', 'session:b'), undefined)
  assert.notEqual(
    sessionDraftStorageKey('principal/a', 'session:a'),
    sessionDraftStorageKey('principal/a', 'session:b'),
  )
  clearSessionDraft(storage, 'principal/a', 'session:a')
  assert.equal(readSessionDraft(storage, 'principal/a', 'session:a'), undefined)
})

test('empty drafts are removed and malformed records are ignored', () => {
  const storage = memoryStorage()
  const key = sessionDraftStorageKey('principal-1', 'session-1')
  storage.setItem(key, '{broken')
  assert.equal(readSessionDraft(storage, 'principal-1', 'session-1'), undefined)

  writeSessionDraft(storage, {
    version: 1,
    principalId: 'principal-1',
    sessionId: 'session-1',
    clientMessageId: 'message-1',
    text: '',
    attachments: [],
    references: [],
    updatedAt: '2026-09-02T00:00:00Z',
  })
  assert.equal(storage.values.has(key), false)
})

test('client message ids are stable caller-owned transport ids', () => {
  assert.equal(createDraftClientMessageId(1234, 0.5), 'dashboard-1234-8')
})
