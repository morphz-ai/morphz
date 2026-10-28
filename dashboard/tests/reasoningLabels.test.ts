import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('reasoning effort labels use exact English Runtime values in every UI locale', () => {
  for (const locale of ['zh', 'en']) {
    const { reasoning } = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8'))
    assert.deepEqual(Object.fromEntries(['defaultUnknown', 'off', 'low', 'medium', 'high', 'xhigh', 'max'].map(key => [key, reasoning[key]])), {
      defaultUnknown: 'default', off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
    })
  }
})
