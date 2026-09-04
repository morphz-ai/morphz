import type { InputSelection } from './steering.ts'

export const SESSION_DRAFT_VERSION = 1
export const SESSION_DRAFT_STORAGE_PREFIX = 'morphz.dashboard.session-draft.v1'

export type DraftAttachmentStatus = 'uploading' | 'ready' | 'consumed'

export interface PersistedDraftAttachment {
  id: string
  stageId: string
  name: string
  mediaType: string
  size: number
  offset: number
  status: DraftAttachmentStatus
  sha256?: string
  error?: string
}

export interface PersistedDraftSessionReference {
  sessionId: string
  title: string
  contextId: string
}

export interface PersistedSessionDraft {
  version: typeof SESSION_DRAFT_VERSION
  principalId: string
  sessionId: string
  clientMessageId: string
  text: string
  attachments: PersistedDraftAttachment[]
  references: PersistedDraftSessionReference[]
  inputSelection?: InputSelection
  updatedAt: string
}

export interface SessionDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function sessionDraftStorageKey(principalId: string, sessionId: string): string {
  return `${SESSION_DRAFT_STORAGE_PREFIX}:${encodeURIComponent(principalId)}:${encodeURIComponent(sessionId)}`
}

export function createDraftClientMessageId(now = Date.now(), entropy = Math.random()): string {
  return `dashboard-${now}-${entropy.toString(16).slice(2)}`
}

function isDraftAttachment(value: unknown): value is PersistedDraftAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string'
    && typeof item.stageId === 'string'
    && typeof item.name === 'string'
    && typeof item.mediaType === 'string'
    && typeof item.size === 'number'
    && Number.isFinite(item.size)
    && item.size >= 0
    && typeof item.offset === 'number'
    && Number.isFinite(item.offset)
    && item.offset >= 0
    && (item.status === 'uploading' || item.status === 'ready' || item.status === 'consumed')
    && (item.sha256 === undefined || typeof item.sha256 === 'string')
    && (item.error === undefined || typeof item.error === 'string')
}

function isDraftReference(value: unknown): value is PersistedDraftSessionReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.sessionId === 'string'
    && typeof item.title === 'string'
    && typeof item.contextId === 'string'
}

export function readSessionDraft(
  storage: SessionDraftStorage | undefined,
  principalId: string,
  sessionId: string,
): PersistedSessionDraft | undefined {
  if (!storage || !principalId || !sessionId) return undefined
  try {
    const raw = storage.getItem(sessionDraftStorageKey(principalId, sessionId))
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<PersistedSessionDraft>
    if (value.version !== SESSION_DRAFT_VERSION
      || value.principalId !== principalId
      || value.sessionId !== sessionId
      || typeof value.clientMessageId !== 'string'
      || !value.clientMessageId
      || typeof value.text !== 'string'
      || !Array.isArray(value.attachments)
      || !value.attachments.every(isDraftAttachment)
      || !Array.isArray(value.references)
      || !value.references.every(isDraftReference)
      || typeof value.updatedAt !== 'string') {
      return undefined
    }
    return value as PersistedSessionDraft
  } catch {
    return undefined
  }
}

export function writeSessionDraft(
  storage: SessionDraftStorage | undefined,
  draft: PersistedSessionDraft,
): void {
  if (!storage || !draft.principalId || !draft.sessionId) return
  const key = sessionDraftStorageKey(draft.principalId, draft.sessionId)
  try {
    if (!draft.text && draft.attachments.length === 0 && draft.references.length === 0 && !draft.inputSelection) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify(draft))
  } catch {
    // Restricted/private browser contexts may deny persistent storage. The
    // in-memory composer remains usable for the current page lifecycle.
  }
}

export function clearSessionDraft(
  storage: SessionDraftStorage | undefined,
  principalId: string,
  sessionId: string,
): void {
  if (!storage || !principalId || !sessionId) return
  try {
    storage.removeItem(sessionDraftStorageKey(principalId, sessionId))
  } catch {
    // The caller has already cleared its in-memory state.
  }
}
