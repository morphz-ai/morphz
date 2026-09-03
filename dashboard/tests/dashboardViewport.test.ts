import assert from 'node:assert/strict'
import test from 'node:test'

import { dashboardViewportMetrics } from '../src/app/dashboardViewport.ts'

test('Dashboard bounds itself to the unzoomed visual viewport', () => {
  const target = {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: {
      width: 390,
      height: 503.75,
      offsetTop: 287.5,
      offsetLeft: 0,
    },
  } as Window

  assert.deepEqual(dashboardViewportMetrics(target), {
    top: 287.5,
    left: 0,
    width: 390,
    height: 503.75,
  })
})

test('Dashboard does not reinterpret an intentional pinch zoom as keyboard chrome', () => {
  const target = {
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: {
      width: 260,
      height: 560,
      offsetTop: 120,
      offsetLeft: 45,
    },
  } as Window

  assert.deepEqual(dashboardViewportMetrics(target), {
    top: 0,
    left: 0,
    width: 390,
    height: 844,
  })
})
