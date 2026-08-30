import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dashboardBasePathFromUri,
  dashboardHttpBaseUrl,
  dashboardWebSocketUrl,
  normalizeDashboardBasePath,
} from '../src/api/deployment.ts'

test('Dashboard deployment paths normalize root and nested prefixes', () => {
  assert.equal(normalizeDashboardBasePath('/'), '/')
  assert.equal(normalizeDashboardBasePath('/console/'), '/console')
  assert.equal(normalizeDashboardBasePath('internal//console///'), '/internal/console')
})

test('Dashboard derives one HTTP and WebSocket namespace from document base URI', () => {
  const basePath = dashboardBasePathFromUri('https://cloud.example/console/')
  const http = dashboardHttpBaseUrl('https://cloud.example/', basePath)
  assert.equal(basePath, '/console')
  assert.equal(http, 'https://cloud.example/console')
  assert.equal(dashboardWebSocketUrl(http), 'wss://cloud.example/console/ws')
})

test('Dashboard root deployment keeps origin-level API and WebSocket paths', () => {
  const http = dashboardHttpBaseUrl('http://127.0.0.1:8080', '/')
  assert.equal(http, 'http://127.0.0.1:8080')
  assert.equal(dashboardWebSocketUrl(http), 'ws://127.0.0.1:8080/ws')
})
