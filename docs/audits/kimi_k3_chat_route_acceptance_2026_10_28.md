# Kimi K3 256K: deployed Chat route acceptance

Date: 2026-10-28. Scope: the existing development Runtime's `kimi-k3-256k`
connection. This is an operational configuration repair, using the existing
Provider catalog and account network settings. No generic authentication,
Context pruning, model-selection or retry policy was changed for this repair.

## Failure and isolation

The original main conversation still failed after the output-budget and exact
HTTP 400 Context-limit classification fixes. Its maintenance projection was
reduced repeatedly, but the native Kimi Responses endpoint continued to return:

```json
{"error":{"message":"Your request exceeded k3-256k model token limit: 262144","type":"invalid_authentication_error"}}
```

The native count endpoint counted the smallest actual failed projection as
147,912 input tokens. That call counted existing input; it did not run inference
or replay the user's business message. The configured output limit was 32,768,
and was present on both sides of the proxy.

Controlled native protocol comparison, with synthetic repeated-word input and
an output cap of one token:

| Input | Native Responses | Native Chat |
| --- | --- | --- |
| About 32K text tokens | Accepted; reported 32,121 input tokens | Not needed |
| Identical about 64K text tokens | HTTP 400, claiming a 262,144-token overflow | Accepted; reported 64,122 input tokens |

This establishes a Responses-specific admission discrepancy for this input
shape. It does not establish the server's internal counting implementation or
mean that a genuine HTTP 401/403 authentication error should trigger compression.

Large Chat streams through the local proxy also returned an upstream HTTP/2
`PROTOCOL_ERROR` twice. The same synthetic request completed through native
HTTP/1.1 and HTTP/2 clients. For the existing Kimi proxy account only, explicitly
selecting the system's existing local HTTP proxy produced complete large streams.
This is evidence for the working account transport configuration, not proof that
every direct HTTP/2 client fails or that the Kimi server's transport is repaired.
Failed probe receipts are retained in the companion JSON.

## Applied configuration

- Changed only the `kimi-k3-256k` route to a dedicated `openai-chat` Provider
  instance at the existing gateway endpoint.
- Reused the existing credential reference through a Provider-bound logical
  account; no credential was copied into the repository or changed.
- Preserved the model's 262,144-token window, 32,768-token output limit and the
  main conversation's `max` reasoning setting. Usable input remains 229,376.
- Changed only the existing upstream Kimi account's `proxy_url` to the system's
  existing `http://127.0.0.1:2080` HTTP proxy. Other proxy accounts and global
  network settings were preserved.
- Applied the Provider/Account/Route graph atomically through the existing
  `/api/runtime/providers/setup` operation. The mutation receipt reported
  `restart_required: false`.

All pre-existing Provider configurations, account configurations and other
model routes were compared before and after and remained equal. The Runtime
root model was preserved. No Runtime or proxy process restart was required.

## Acceptance

The companion JSON contains the sanitized quantitative receipts.

| Check | Result |
| --- | --- |
| Gateway stream, real 36-tool schema contract, `max`, output limit 32,768 | Accepted, 151,998 input tokens, returned `OK` |
| Cold ASCII prefix, same contract and limits, no retry | Accepted, 151,999 input tokens, returned `OK` |
| Cold Chinese prefix near the usable window, same contract and limits, no retry | Accepted, 208,025 input tokens, returned `OK` |
| Live Runtime route diagnostic | Healthy; binding protocol `openai-chat`, physical model `kimi-k3-256k` |
| Original Desktop main conversation with its existing long Context | One explicitly labelled TEST returned `MORPHZ_OK` at 15:06 local time |
| Durable TEST reply metadata | `configured_reasoning_effort: max`; correct Chat Provider and 256K/32K budget |
| Existing mail listener | Same Job remained running, with a fresh heartbeat after acceptance |
| Existing processes | Runtime, proxy and listener PIDs preserved |

The original Desktop's selected model, reasoning setting and capacity panel
were inspected. Its historical failed messages were retained. The previous
`ping` and business messages were not resent. The TEST requested no tools or
business operations; the synthetic gateway tests executed no tools.

This is the bounded acceptance of the deployed connection, not a claim that
the native Responses defect has been fixed upstream. No new Rust build, retry
relaxation or CI change was needed. Other model routes, multimodal inputs and
future upstream versions are outside this acceptance.

## Configuration maintenance

Keep this connection's protocol explicit in the Provider catalog. Do not change
the shared Responses Provider, infer transport from arbitrary model-name
substrings, switch to the more expensive 1M model, or globally remap authentication
errors to Context maintenance. Reconsider Responses only after a fresh native
protocol comparison proves the long-input admission discrepancy is resolved.

References: [Kimi Code API protocols](https://www.kimi.com/code/docs/en/),
[Kimi model configuration](https://www.kimi.com/en/help/kimi-code/models),
[CLIProxyAPI account-scoped proxy transport](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.35/internal/runtime/executor/helps/proxy_helpers.go),
[CLIProxyAPI auth-file proxy configuration](https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.35/internal/watcher/synthesizer/file.go).
