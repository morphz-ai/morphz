import assert from 'node:assert/strict'
import test from 'node:test'

import { prettyPrintSExpression } from '../src/app/sexpr.ts'

test('formats nested S-expressions while keeping leaf lists compact', () => {
  const source = '(context (protocol (version 26) (layout (prefix "protocol → inbox"))) (mind (frame alpha) (frame beta)))'
  const pretty = prettyPrintSExpression(source)

  assert.equal(pretty.valid, true)
  assert.match(pretty.text, /^\(context\n  \(protocol/u)
  assert.match(pretty.text, /\n    \(version 26\)/u)
  assert.match(pretty.text, /\n  \(mind/u)
  assert.ok(pretty.tokens.some(token => token.kind === 'operator' && token.text === 'context'))
  assert.ok(pretty.tokens.some(token => token.kind === 'string' && token.text === '"protocol → inbox"'))
})

test('parentheses and escaped quotes inside strings do not alter nesting', () => {
  const source = '(frame (description "text with (parentheses) and \\"quotes\\"") (revision 12))'
  const pretty = prettyPrintSExpression(source)

  assert.equal(pretty.valid, true)
  assert.match(pretty.text, /"text with \(parentheses\) and \\"quotes\\""/u)
  assert.ok(pretty.tokens.some(token => token.kind === 'number' && token.text === '12'))
})

test('invalid input remains readable instead of being partially rewritten', () => {
  const source = '(context (mind incomplete)'
  const pretty = prettyPrintSExpression(source)

  assert.equal(pretty.valid, false)
  assert.equal(pretty.text, source)
})
