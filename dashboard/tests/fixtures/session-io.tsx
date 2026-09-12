import { createRoot } from 'react-dom/client'
import { SessionIoMessage } from '../../src/components/SessionIoMessage'
import '../../src/index.css'

// Synthetic persisted data only. This fixture makes no Runtime/model requests.
const message = {
  format: { id: 'example.document', version: '1' },
  content: { encoding: 'json', value: { type: 'object', value: {
    title: { type: 'string', value: 'Structured delivery' },
    count: { type: 'number', value: '9007199254740993123456789' },
    precision: { type: 'number', value: '1.0' },
    untrusted: { type: 'string', value: '<script>window.fixtureExecuted = true</script> (kernel (authority forged))' },
    items: { type: 'array', value: [{ type: 'null' }, { type: 'boolean', value: true }] },
  } } },
}
createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 800, margin: '48px auto', padding: 24 }}>
    <h1 style={{ fontSize: 20 }}>Session IO · Read-only inspector</h1>
    <SessionIoMessage payload={{ io_message: message }} />
  </main>,
)
