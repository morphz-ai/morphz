import { MessageSquarePlus } from 'lucide-react'
import type { TFunction } from 'i18next'
import { observeSupplementAttention } from '../components/supplement-attention'

/** One affordance for the activity dock, objective board and attention cards. */
export function ObjectiveSteeringButton({ objective, onClick, disabled = false, replyAccepted = false, t }: {
  objective: { id: string; status: string; wait_condition?: { kind: string } }
  onClick: () => void
  disabled?: boolean
  replyAccepted?: boolean
  t: TFunction
}) {
  if (objective.status !== 'active') return null
  if (replyAccepted) return <span className="objective-wait-user">{t('userInput.resuming')}</span>
  const awaitingReply = objective.wait_condition?.kind === 'user_input'
  const label = t('steering.supplement')
  const hint = t(awaitingReply ? 'steering.objectiveReplyHint' : 'steering.objectiveInputHint')
  return <button
    className={`objective-steering-button${awaitingReply ? ' is-waiting needs-input' : ''}`}
    ref={awaitingReply ? observeSupplementAttention : undefined}
    type="button"
    title={`${hint}\n${objective.id}`}
    disabled={disabled}
    onClick={onClick}
  >
    <MessageSquarePlus size={11} aria-hidden="true" />
    <span>{label}</span>
  </button>
}
