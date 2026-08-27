# Yao Core Language Specification v0.1

> Status: Draft
>
> Steward: Newvar
>
> Canonical language: English
>
> Last updated: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/yao_core_language_specification_v0_1.md)

## 1. Purpose

Yao is the cognitive evaluation language shared by a model and a Runtime. It gives both evaluators
one typed representation for data, decisions, programs, and effects while preserving a strict
authority boundary: a model may propose meaning and programs; only the Runtime may validate,
authorize, persist, and execute effects.

Yao Core defines implementation-independent syntax, values, types, lexical scope, pure
expressions, structured control, structured concurrency, Program Values, and effect typing. The
[Yao Evaluation Semantics](yao_evaluation_semantics_v0_1.md) defines the two evaluator modes and
durable execution rules. Runtime-specific objects and effects are defined by profiles such as the
[Yao Morphz Runtime Profile](yao_morphz_runtime_profile_v0_1.md).

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be
interpreted as normative requirements.

## 2. Design properties

A conforming Yao Core implementation MUST preserve these properties:

1. **Explicit evaluation ownership.** A program root is either `eval` or `infer`.
2. **Typed nondeterministic boundaries.** Every inference has a statically known result type,
   either inferred from its body or narrowed by an explicit result contract.
3. **Effect visibility.** Effects are statically discoverable upper bounds, not hidden inside pure
   expressions.
4. **Authority separation.** A declaration requests or narrows authority; it never grants it.
5. **Structured concurrency.** Parallel work has lexical lifetime, stable branch identity, and a
   deterministic join value.
6. **Programs as validated values.** Model-produced code becomes executable only after parsing,
   type/effect checking, capability settlement, canonicalization, and persistence.
7. **Bounded Core.** Core contains no unbounded loop, recursion, detached spawn, shared mutable
   variable, or dynamic operator lookup.

## 3. Source model and diagnostics

Yao source is UTF-8 and uses S-expression concrete syntax. Implementations MUST retain, for every
token and syntax node, a source span containing byte offsets and human-readable line and column
positions. A rejected program MUST identify the primary span and SHOULD include a stable diagnostic
code and related spans. Protocol-facing diagnostic detail MUST use canonical English. A localized
product surface MAY translate the stable diagnostic code, but MUST preserve that code and the
canonical detail; program control flow MUST NOT depend on diagnostic wording.

Whitespace separates tokens. `;` starts a line comment. Strings use double quotes and the escapes
`\\`, `\"`, `\n`, `\r`, and `\t`. The atoms `true`, `false`, and `nil` are reserved literals.
Integers use base-10 notation. Floating-point literals MUST contain a decimal point or exponent.
Other unquoted atoms are symbols.

An implementation MUST reject invalid UTF-8, unterminated strings, unknown escapes, unmatched
parentheses, excess nesting, and more than one top-level artifact before semantic analysis.

## 4. Program envelope

A program contains exactly one top-level artifact:

```lisp
(eval DECLARATION... BODY)
(infer DECLARATION... BODY)
```

`eval` gives the Runtime ownership of the Evaluation Loop. `infer` gives the model ownership of the
Evaluation Loop while leaving the Runtime Control Loop authoritative. Apart from the owner, both
roots use the same Yao body language, parser, type system, effect system, and result values.

Declarations precede the body and MAY include, in this order:

```lisp
(requires
  (tools TOOL...)
  (effects EFFECT...)
  (objects OBJECT-KIND...))
(types TYPE-DECLARATION...)
```

Yao source has no in-band language-version declaration. `(version ...)` is not a Core form and
MUST be rejected. The specification version, a Harness Package version, and an implementation's
persisted typed-IR schema version are independent metadata boundaries; none changes source meaning
from inside a program. A program MUST contain at most one declaration of each kind. An
implementation MUST reject an unknown declaration instead of ignoring it.

`(requires (tools ...))` is valid without `(effects ...)`. Tool names in
`requires` are a closed upper bound for statically named `call` and nested `infer` evidence tools.

### 4.1 Model-visible Language Card

A model-hosting profile MUST publish one compact Yao Language Card derived from the same language
implementation and MUST place it in a stable shared context prefix. Tool descriptions and Harness
prose MUST refer to that card instead of republishing operator tables or alternate syntax. The card
MUST be parseable, version-controlled out of band, and protected by an explicit size budget.

## 5. Types

### 5.1 Built-in types

Yao Core defines:

```text
Nil Bool Int Float String Bytes Json
List<T> Map<T> Record{field: T, ...} Option<T> Result<T, E>
Ref<K> Program<T, E>
```

`Json` is the explicit dynamically shaped boundary type. It is not an implicit escape from static
typing. A value of type `Json` MUST be checked or decoded before use where a narrower type is
required.

`Ref<K>` is an opaque reference to a host object kind. Core defines reference identity and
non-forgeability; profiles define concrete kinds and operations.

`Program<T, E>` is an immutable validated Program Value whose terminal value is assignable to `T`
and whose effective execution effect set is a subset of `E`. For an `eval` root this is its
statically inferred effect set. For an `infer` root, first-class execution through `run` adds the
model-ownership transition as an `infer` effect, because it creates a new formal Evaluation from
the caller's perspective.

`Record{...}` is a compiler-produced structural record type used for results such as `par` whose
field names arise from the containing expression. User-declared records remain nominal.

### 5.2 Type syntax

Parameterized types use list syntax:

```lisp
(List Finding)
(Map String)
(Option (Ref Objective))
(Result Decision Error)
(Program Decision (effects infer (tool read)))
```

### 5.3 Named records and unions

Named types are declared inside `(types ...)`:

```lisp
(types
  (record Finding
    (title String)
    (confidence Float))
  (union Decision
    (accept (reason String) (confidence Float))
    (reject (reason String))))
```

Names, field names, and union variant names MUST be unique in their declaration. Recursive type
definitions are not part of v0.1. Implementations MUST reject direct or indirect recursive types.

### 5.4 Assignability

Assignability is structural for anonymous collection types and nominal for named records and
unions. `Int` is assignable to `Float`; no other numeric widening is implicit. Every type is
assignable to `Json`, but decoding `Json` into another type is an explicit checked operation.

Branch expressions MUST have a common result type. An implementation MAY infer a precise union of
compatible result types; otherwise it MUST require an explicit common type rather than silently
falling back to `Json`.

## 6. Values and pure expressions

References to lexical bindings use the bare binding name; field selection uses `name.field`.
Bindings are immutable and cannot be shadowed in the same lexical scope. The `$name` spelling is
invalid Yao source and implementations SHOULD diagnose it with the bare-name replacement.

Core value constructors are:

```lisp
(list EXPR...)
(dict (KEY EXPR)...)
(record TYPE (FIELD EXPR)...)
(variant TYPE.VARIANT (FIELD EXPR)...)
(some EXPR)
(none TYPE)
(ok EXPR ERROR-TYPE)
(err EXPR OK-TYPE)
```

`list` constructs a homogeneous `List<T>` and `dict` constructs a homogeneous `Map<T>`; every
element or value therefore needs a common type. A fixed object whose named fields intentionally
have different types is a named `record`, not a `dict`. Implementations MUST NOT silently widen a
heterogeneous `dict` to `Map<Json>`. A diagnostic SHOULD identify the conflicting field and suggest
a named record or an explicit `Json` boundary.

`none` names the absent element type. Because v0.1 does not use contextual or bidirectional type
inference, `ok` also names its uninhabited error type and `err` names its uninhabited success
type. This makes every constructor independently typable and keeps serialized HIR unambiguous.

Core pure operators are:

```lisp
(get EXPR FIELD)
(decode TYPE JSON-EXPR)
(is TYPE EXPR)
(eq LEFT RIGHT)  (ne LEFT RIGHT)
(lt LEFT RIGHT)  (le LEFT RIGHT)
(gt LEFT RIGHT)  (ge LEFT RIGHT)
(and EXPR...)     (or EXPR...)     (not EXPR)
(add EXPR...)     (sub LEFT RIGHT)
(mul EXPR...)     (div LEFT RIGHT)
```

`and` and `or` short-circuit left to right. Numeric overflow, division by zero, failed `decode`, a
missing field, and an invalid comparison are classified failures with source spans; they MUST NOT
silently coerce to another value.

Core v0.1 uses an effect-normal form: operands of value constructors and pure operators, `if`
conditions, `match` values, `map` collections, Tool/Host arguments, inference arguments, and the
operand of `run` MUST be pure. An effectful result is first named with `bind` and then referenced.
This keeps every durable suspension at an explicit control boundary and makes restart positions
unambiguous.

## 7. Binding and structured control

```lisp
(seq STEP...)
(bind NAME EXPR)
(if CONDITION WHEN-TRUE WHEN-FALSE)
(match VALUE CASE...)
(fallback PRIMARY BACKUP)
(map COLLECTION ELEMENT BODY)
```

`seq` evaluates left to right and returns its last value. `bind` fully evaluates its expression,
adds one immutable lexical binding, and returns `nil`. Bindings created in `if`, `match`,
`fallback`, `map`, or `par` branches do not escape the branch.

`if` requires `Bool`; truthiness coercion is not part of typed v0.1.

Union matching uses:

```lisp
(match decision
  ((case Decision.accept (reason why) (confidence score)) EXPR)
  ((case Decision.reject (reason why)) EXPR))
```

A named-union match MUST be exhaustive and MUST NOT repeat a variant. Pattern field names MUST
match the declaration; local binding names are introduced for the case body.

`map` iterates a materialized finite list and preserves input order. A profile MUST define a finite
element limit. `map` is sequential; parallel mapping is not part of Core v0.1.

`fallback` evaluates `PRIMARY` and evaluates `BACKUP` only after a classified failure. It does not
catch cancellation, lost authority, invalid program admission, or Runtime integrity failures.

## 8. Effects

### 8.1 Effect set

Every expression has a result type and an effect set. Core effect atoms are:

```lisp
infer
(tool TOOL)
(host OPERATION)
(program EFFECT...)
```

Profiles MAY define additional namespaced effects. Effect sets are unordered and deduplicated.
The effect of a composite expression is the union of effects it may execute. Untaken `if` or
`match` branches do not execute, but their effects remain in the static upper bound.

### 8.2 Capability settlement

Before execution, the Runtime MUST verify that the inferred effect set is contained in the
effective capabilities produced by intersecting deployment policy, Principal authority,
Execution Target policy, Package declarations, Program declarations, and per-operation narrowing.

Passing static effect analysis does not guarantee authorization. Runtime authorization MUST be
revalidated at every effect boundary where policy, lease, target, or Principal state may have
changed.

## 9. Tool and inference expressions

### 9.1 Tool request

```lisp
(call TOOL (ARG EXPR...)...)
```

`TOOL` is static. Argument evaluation is pure and occurs before the Tool request is persisted.
Argument fields and results MUST be checked against the Tool schema. A `call` has effect
`(tool TOOL)`.

### 9.2 Model-owned evaluation

```lisp
(infer
  [(captures NAME...)]
  [(returns TYPE)]
  BODY)
```

`BODY` is one complete Yao expression. Replacing an outer `eval` with `infer` changes which
evaluator owns that expression; it does not lower the expression to a fixed task/evidence request.
The same frontend MUST parse and type-check the body, and its statically visible effects remain an
upper bound on what the model-owned Evaluation may request.

At a nested ownership boundary, the body starts with an empty lexical scope. `(captures NAME...)`
is the only source-level mechanism that imports bindings from the parent program. Every named
binding MUST exist in the parent scope. Its typed value MAY be serialized into the internal
Evaluation request and sent to the currently configured model provider. No unlisted parent binding
or whole Runtime environment may be included implicitly. `captures` authorizes disclosure of a
value; it does not grant any Tool, Host, or object capability.

Without `(returns TYPE)`, the result contract is the statically inferred type of `BODY`. For an
ordinary value, an explicit `TYPE` MUST accept the body type. `Program<T,E>` is the one synthesis
contract: the body describes how the model derives a quarantined Program candidate, and the
candidate is independently parsed, typed, effect-checked, canonicalized, and persisted before it
can become a value.

Available evidence tools are derived from statically named `(call TOOL ...)` expressions in the
body and intersected with root declarations and deployment policy. The Runtime MUST decode and
validate the terminal result before it enters Runtime-owned data flow. Failure to decode is a
classified inference failure.

Type names are case-sensitive. Historical lowercase aliases such as `text` and `json` are not Core
types and MUST be rejected rather than silently normalized.

## 10. Structured parallelism

Core v0.1 defines one parallel expression:

```lisp
(par
  (branch NAME EXPR)
  (branch NAME EXPR)
  ...)
```

`par` MUST contain at least two uniquely named branches. Each branch receives the same immutable
lexical environment snapshot. Branch bindings and intermediate values are isolated. Branch names
are stable causal identities within the containing Program Value and MUST survive lowering,
persistence, restart, tracing, and result construction.

All branches are joined. The successful result is a record whose fields follow source order and
whose values are the branch results. If one or more branches fail, the `par` expression becomes a
classified failure only after all already-admitted branches reach a terminal state. The failure
MUST retain every branch status and successful result for audit, even though ordinary expression
flow receives the classified failure.

The Runtime MAY cap physical concurrency without changing the semantic result. It MUST NOT
serialize a branch because an earlier branch is waiting when capacity exists. Detached execution,
race, quorum, and implicit shared state are not part of v0.1.

## 11. Program Values

An inference may return a Program Value:

```lisp
(infer
  (returns (Program Decision (effects infer (tool read))))
  (seq
    (bind evidence (call read (path "decision-input.json")))
    evidence))
```

Its model-facing representation is exactly one raw Yao source artifact:

```lisp
(eval ...)
; or
(infer ...)
```

The response MUST contain no JSON wrapper, Markdown fence, or explanatory text. Raw source is only
a quarantined candidate, not yet a Program Value, and MUST NOT be passed to a string evaluator. The
Runtime MUST perform this admission pipeline before constructing `Program<T, E>`:

1. parse with source spans;
2. require exactly one explicit `eval` or `infer` root and preserve its evaluation owner;
3. resolve declarations and names;
4. type check the terminal value against `T`;
5. infer effects, add `infer` for a model-owned root at the first-class execution boundary, and
   require the effective set to be a subset of `E` and current authority;
6. enforce depth, size, effect-count, and profile budgets;
7. canonicalize the validated representation;
8. compute a content hash and attach provenance to the producing inference;
9. persist the Program Value before it can execute.

Program Values are closed over ordinary lexical bindings: references to caller-local values are
forbidden. A Runtime profile MAY inject one explicitly typed, immutable host environment (for
example Morphz `runtime`) into both parent and child; this is inherited authority, not lexical
capture. Other inputs must be embedded as validated values or supplied through a future explicitly
typed function profile.

A Program Value executes only through:

```lisp
(run PROGRAM-EXPR)
```

`run` revalidates current authority and creates a causally linked durable child execution. An
`eval` root advances through Runtime-owned Plan control. An `infer` root immediately suspends at a
formal child Evaluation and joins its typed result; the durable Plan state remains only as the
causal, budget, restart, and result boundary. It MUST NOT execute by recursive in-process evaluation
of source text. Program nesting depth and aggregate budgets MUST be bounded by the Runtime profile.

## 12. Canonical representation and identity

Implementations MUST provide a canonical encoding of the validated typed representation. The
encoding MUST be independent of insignificant whitespace, comments, map insertion order, source
file path, and diagnostic metadata. It MUST preserve branch order, declared nominal type identity,
literal value identity, and all effect-relevant distinctions.

A Program Value identity is `sha256:` followed by lowercase hexadecimal SHA-256 of the canonical
UTF-8 encoding. Source text and spans remain provenance artifacts and are not the identity input.

## 13. Resource limits

A conforming Runtime profile MUST publish finite limits for source bytes, syntax nesting, typed IR
nodes, record fields, collection elements, Tool effects, inference effects, parallel branches,
Program Value nesting, and total child work. Admission MUST reject statically exceeded limits;
dynamic excess becomes a classified resource failure.

## 14. Compatibility and migration

The Morphz reference implementation admits one source language: typed Yao described by this
specification. Historical untyped source and in-band `(version ...)` declarations MUST be rejected;
there is no source-level legacy profile. A deployment MAY retain readers for already-persisted
legacy Plan IR during a bounded migration window. Such a storage reader MUST NOT expose a parser,
Tool, Harness, or model path that admits legacy source.

## 15. Conformance requirements

A Core implementation claiming v0.1 conformance MUST publish tests that cover:

- tokenization, spans, canonical encoding, and malformed-source diagnostics;
- every built-in type, constructor, operator, and failure rule;
- name resolution, immutability, branch scope, exhaustiveness, and type rejection;
- static effect inference and capability subset rejection;
- typed inference decoding, including malformed and adversarial results;
- `par` ordering, isolation, bounded concurrency, multi-failure reporting, and restart equivalence;
- Program Value validation, effect escape rejection, hashing, provenance, nesting limits, and
  durable execution;
- rejection of historical untyped source and in-band version declarations, plus persisted-IR
  migration fixtures where that storage format remains supported.

The same normative example MUST produce an observationally equivalent result before and after a
serialization/restart boundary.
