import type { ReactNode } from 'react'

/** Shared response feedback for the main conversation and discussion. */
export function StreamStatus({ label, failed = false, animated = true, children }: {
  label: string
  failed?: boolean
  animated?: boolean
  children?: ReactNode
}) {
  return <div className={`stream-status${failed ? ' is-failed' : ''}`} data-static={!animated || undefined}>
    {!failed && <span className="stream-typing" aria-hidden="true"><b /><b /><b /></span>}
    <span>{label}</span>
    {children}
  </div>
}
