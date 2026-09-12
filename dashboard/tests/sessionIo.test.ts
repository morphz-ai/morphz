import assert from 'node:assert/strict'
import test from 'node:test'
import { formatIoData, inspectIoMessage } from '../src/app/sessionIo.ts'
import { conversationEventKind } from '../src/app/presentation.ts'

test('the generic inspector preserves numeric lexemes and does not execute content', () => {
  assert.equal(formatIoData({type:'number', value:'9007199254740993123456789'}), '9007199254740993123456789')
  assert.equal(formatIoData({type:'number', value:'1.0'}), '1.0')
  assert.equal(formatIoData({type:'string', value:'<script>bad()</script>'}), '"<script>bad()</script>"')
  assert.throws(() => formatIoData({type:'number', value:'1;bad()'}))
})
test('input, output and old chat are distinct without hiding typed results', () => {
  assert.equal(inspectIoMessage({text:'legacy'}), null)
  const message = {format:{id:'third.party',version:'2'}, content:{encoding:'json',value:{type:'object',value:{hello:{type:'string',value:'world'}}}}}
  assert.equal(inspectIoMessage({session_io:{request:{message}}})?.format, 'third.party@2')
  assert.equal(inspectIoMessage({io_message:message})?.text, '{\n  "hello": "world"\n}')
  assert.equal(conversationEventKind('session/io_output', {}), 'agent')
  assert.equal(conversationEventKind('session/io_state', {}), 'system')
})

test('immutable resource metadata is inspectable without evaluating a URL or exposing storage paths', () => {
  const resource_id = 'io-resource:ZXhhbXBsZQ'
  const message = {format:{id:'morphz.data',version:'1'},content:{encoding:'resource',resource_id}}
  const view = inspectIoMessage({session_io:{request:{message},binding:{resources:[{original_resource_id:resource_id,name:'<script>bad()</script>',sha256:'exact-digest',size_bytes:12}]}}})
  assert.equal(view?.encoding,'resource')
  assert.ok(view?.text.includes('exact-digest'))
  assert.ok(view?.text.includes('<script>bad()</script>'))
  assert.ok(!view?.text.includes('not supported'))
})
