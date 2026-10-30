# Runtime reasoning efforts

Reviewed 2026-10-28. Runtime accepts `none`, `low`, `medium`, `high`,
`xhigh`, and `max`; omission or `provider_default` retains its existing
inheritance/default semantics. These are distinct request values. `xhigh`
is never translated to `max` or `high` by Morphz.

## Physical capability ownership

`ProviderModelConfig.supported_reasoning_efforts` declares the exact native
vocabulary of a physical endpoint/model, independently of task preferences.
`None` is unknown, while `[]` means no selectable effort. This optional field
uses the existing provider configuration/serialization path; task records keep
their existing nullable string columns, so no database migration is required.
Thread, Objective, Schedule and Session inheritance, immutable model attempts,
request identities, and existing saved defaults are preserved.

Explicit declarations take precedence over documented physical model defaults:

```toml
[provider_instances.gateway.models."custom-physical-model"]
supported_reasoning_efforts = ["low", "medium", "high", "xhigh", "max"]
```

Provider discovery also reads an explicitly returned `supported_reasoning_efforts`
array or `supported_reasoning_levels` entries with an `effort` value. This uses
the existing catalog diagnostic/enablement path, not new polling or inference
requests. Model routes intersect all physical candidates; an unknown candidate
cannot certify `xhigh`. Unknown endpoints keep their previous controls and do
not advertise the new level without a capability declaration. Explicit unknown
`xhigh` requests fail before upstream I/O, without fallback or downgrade.

Dashboard and Desktop consume these same Runtime capabilities. Desktop's
existing discrete slider and Dashboard's existing selector retain their layout.
Chat Completions sends `reasoning_effort: "xhigh"`; Responses sends
`reasoning: { effort: "xhigh" }`. Provider/model declarations remain authoritative
for other native protocols; their capabilities do not inherit an OpenAI list.

## Reviewed model defaults

- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
  and [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra):
  `low`, `medium`, `high`, `xhigh`, `max`.
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra),
  [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
  [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna),
  [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
  [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
  [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): all six levels.
- [GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2),
  [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), and
  [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5):
  `none`, `low`, `medium`, `high`, `xhigh`, with no `max`.
- [GPT-5.2-Codex](https://developers.openai.com/api/docs/models/gpt-5.2-codex)
  and [GPT-5.3-Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex):
  `low`, `medium`, `high`, `xhigh`.
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/):
  published V4/Flash native controls are `none`, `low`, `high`, `max`. Its
  compatibility spelling `xhigh` maps to `high`, so it is not advertised as a
  distinct higher setting. Other models/gateways require their exact declaration.
- The existing xAI model-scoped capability and `max` compatibility rules remain
  unchanged; they do not certify `xhigh`.

Only exact physical IDs and dated snapshots of these IDs use these defaults;
logical route labels and arbitrary prefixed/suffixed names do not establish
capabilities. Future endpoint differences belong in the existing exact model
profile, not a global expansion of available controls.
