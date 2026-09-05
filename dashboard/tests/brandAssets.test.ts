import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('Dashboard favicon is the website electric-cyan butterfly, not a second design', () => {
  assert.equal(
    read('../public/favicon.svg'),
    read('../../website/public/brand/morphz-favicon-cyan.svg'),
  )
})

test('the embedded Runtime artifact carries the updated favicon and cache key', () => {
  assert.equal(read('../dist/favicon.svg'), read('../public/favicon.svg'))
  assert.match(read('../dist/index.html'), /href="\.\/favicon\.svg\?brand=cyan-butterfly"/)
})

test('header and authentication share the same decorative brand mark', () => {
  const mark = read('../src/BrandMark.tsx')
  assert.match(mark, /alt=""/)
  assert.match(mark, /aria-hidden="true"/)
  assert.match(mark, /width=\{24\}/)
  assert.match(mark, /height=\{24\}/)
  for (const entry of ['../src/App.tsx', '../src/DashboardAuthGate.tsx']) {
    assert.match(read(entry), /import \{ BrandMark \} from '\.\/BrandMark'/)
    assert.match(read(entry), /<BrandMark \/>/)
  }
  assert.match(read('../src/App.css'), /\.morphz-brand-mark\s*\{[^}]*flex: 0 0 auto/)
})

test('tab and header use a cache-busted icon within the Dashboard deployment prefix', () => {
  const iconUrl = read('../index.html').match(/rel="icon"[^>]+href="([^"]+)"/)?.[1]
  assert.equal(iconUrl, './favicon.svg?brand=cyan-butterfly')
  assert.ok(read('../src/BrandMark.tsx').includes(`src="${iconUrl}"`))
  for (const prefix of ['/', '/console/', '/nested/dashboard/']) {
    assert.equal(
      new URL(iconUrl!, `https://example.test${prefix}`).pathname,
      `${prefix}favicon.svg`,
    )
  }
})
