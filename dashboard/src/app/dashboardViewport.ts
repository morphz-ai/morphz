const UNZOOMED_WIDTH_TOLERANCE_PX = 2
const KEYBOARD_SETTLE_DELAYS_MS = [120, 360]

function usableVisualViewport(target: Window): VisualViewport | undefined {
  const viewport = target.visualViewport
  if (!viewport) return undefined

  // A desktop-style mobile viewport can start at a scale other than one. Width
  // distinguishes that case from intentional pinch zoom without overriding an
  // accessibility gesture.
  return viewport.width + UNZOOMED_WIDTH_TOLERANCE_PX >= target.innerWidth
    ? viewport
    : undefined
}

export interface DashboardViewportMetrics {
  top: number
  left: number
  width: number
  height: number
}

export function dashboardViewportMetrics(target: Window): DashboardViewportMetrics {
  const viewport = usableVisualViewport(target)
  if (!viewport) {
    return { top: 0, left: 0, width: target.innerWidth, height: target.innerHeight }
  }
  return {
    top: Math.max(0, viewport.offsetTop),
    left: Math.max(0, viewport.offsetLeft),
    width: viewport.width,
    height: viewport.height,
  }
}

export function installDashboardViewportGuard(
  target: Window = window,
  root: HTMLElement = document.documentElement,
): () => void {
  const viewport = target.visualViewport
  let animationFrame: number | undefined
  const settleTimers = new Set<number>()

  const sync = () => {
    if (animationFrame !== undefined) target.cancelAnimationFrame(animationFrame)
    animationFrame = target.requestAnimationFrame(() => {
      animationFrame = undefined
      const metrics = dashboardViewportMetrics(target)
      root.style.setProperty('--morphz-visual-top', `${metrics.top.toFixed(2)}px`)
      root.style.setProperty('--morphz-visual-left', `${metrics.left.toFixed(2)}px`)
      root.style.setProperty('--morphz-visual-width', `${metrics.width.toFixed(2)}px`)
      root.style.setProperty('--morphz-visual-height', `${metrics.height.toFixed(2)}px`)

      // Every intended scroll container lives inside the Dashboard shell. Any
      // document scroll is therefore stale iOS keyboard/browser-chrome state.
      // Restoring the origin keeps the header and composer inside their safe
      // areas after the keyboard closes.
      if (usableVisualViewport(target) && (target.scrollX !== 0 || target.scrollY !== 0)) {
        target.scrollTo(0, 0)
      }
    })
  }

  const settleAfterFocus = () => {
    sync()
    for (const delay of KEYBOARD_SETTLE_DELAYS_MS) {
      const timer = target.setTimeout(() => {
        settleTimers.delete(timer)
        sync()
      }, delay)
      settleTimers.add(timer)
    }
  }

  target.addEventListener('resize', sync)
  target.addEventListener('orientationchange', settleAfterFocus)
  target.addEventListener('scroll', sync)
  target.document.addEventListener('focusin', sync)
  target.document.addEventListener('focusout', settleAfterFocus)
  viewport?.addEventListener('resize', sync)
  viewport?.addEventListener('scroll', sync)
  sync()

  return () => {
    if (animationFrame !== undefined) target.cancelAnimationFrame(animationFrame)
    for (const timer of settleTimers) target.clearTimeout(timer)
    target.removeEventListener('resize', sync)
    target.removeEventListener('orientationchange', settleAfterFocus)
    target.removeEventListener('scroll', sync)
    target.document.removeEventListener('focusin', sync)
    target.document.removeEventListener('focusout', settleAfterFocus)
    viewport?.removeEventListener('resize', sync)
    viewport?.removeEventListener('scroll', sync)
    root.style.removeProperty('--morphz-visual-top')
    root.style.removeProperty('--morphz-visual-left')
    root.style.removeProperty('--morphz-visual-width')
    root.style.removeProperty('--morphz-visual-height')
  }
}
