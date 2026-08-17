# DEMO-001 Selective Freeze Receipt

The executable frozen-v2.1 tag is
`demo-001-frozen-v2.1-selective-20260817`.

Its first parent is the original DEMO-001 frozen-v2 commit
`69d04708815a149f4e1a24be7fa9416a2b82b08d`, whose Runtime source baseline is
`paper-eval-runtime-v2` at
`03a32f864a3c38026672b4076855137e0bbb5627`.

Only the dedicated Morphz Profile correction, runner/profile preflight,
transport documentation and frozen metadata are applied on top. The unrelated
`8a06824 fix: normalize objective wait conditions` commit is not an ancestor of
this selective freeze.

The intermediate tag `demo-001-frozen-v2.1-20260817` remains immutable but is
not executable and must not identify reportable runs.
