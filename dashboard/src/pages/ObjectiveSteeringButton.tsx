import { MessageSquarePlus, Reply } from 'lucide-react'
import type { TFunction } from 'i18next'

/** One affordance for the activity dock, objective board and attention cards. */
export function ObjectiveSteeringButton({ objective, onClick, disabled = false, t }: {
  objective: { id: string; status: string; wait_condition?: { kind: string } }
  onClick: () => void
  disabled?: boolean
  t: TFunction
}) {
  if (objective.status !== 'active') return null
  const awaitingReply = objective.wait_condition?.kind === 'user_input'
  const label = t(awaitingReply ? 'steering.reply' : 'steering.supplement')
  const hint = t(awaitingReply ? 'steering.objectiveReplyHint' : 'steering.objectiveInputHint')
  return <button
    className={`objective-steering-button${awaitingReply ? ' is-waiting' : ''}`}
    type="button"
    title={`${hint}\n${objective.id}`}
    disabled={disabled}
    onClick={onClick}
  >
    {awaitingReply ? <Reply size={11} aria-hidden="true" /> : <MessageSquarePlus size={11} aria-hidden="true" />}
    <span>{label}</span>
  </button>
}
