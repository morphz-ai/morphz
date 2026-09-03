# HNS Package Format Specification v0.1

> Status: Draft specification candidate
>
> Steward: Newvar
>
> Reference implementation: Morphz Runtime `.hns` Loader
>
> Canonical language: English
>
> Source baseline: Morphz Runtime as of 2026-08-21
>
> Date: 2026-08-21
>
> Chinese translation: [zh-CN](zh-CN/hns_package_format_specification_v0_1.md)
>
> Semantic dependency: [Morphz Harness Specification v0.1](morphz_harness_specification_v0_1.md)

## 1. Scope

This specification defines the `.hns` distribution profile for a portable Morphz Harness Package.
It defines physical forms, logical artifacts, cardinality, manifest fields, entry ownership,
normalization, content identity, path safety, and loading behavior.

The `.hns` suffix identifies a Harness Package. The `.yao` suffix identifies Yao source files
inside a directory Package. `.hns` is not the name of the source language, Evaluation Loop, SDK, or
Cognitive Application category.

One HNS Package MAY realize the execution content of a minimal Cognitive Application. HNS Core
v0.1 packages exactly one Primary Harness and does not define a complete Application Manifest,
multiple Harnesses, user interface, marketplace metadata, commercial policy, or external service
bundle. Cognitive Application, Harness, and HNS Package are therefore not synonyms.

This Draft standardizes the minimum Package currently implemented and separates reserved future
artifacts from active requirements.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be
interpreted as described in BCP 14, [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.html) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html), when, and only when, they appear in all
capitals.

Examples and implementation notes are non-normative unless explicitly identified otherwise.

## 3. Package model

An HNS Package has the following normalized logical form:

```text
HarnessPackage
|- Manifest              exactly one
|- Contract              exactly one
|- Default Mind          zero or one
`- Entry Program         exactly one
```

Each valid Package MUST produce:

- a Harness ID;
- a declared Package version;
- a human-readable title;
- one logical Entry Program ID;
- explicit Runtime-owned or model-owned entry semantics;
- a normalized logical representation;
- a content identity derived from that representation.

Skills, Verifiers, dependencies, migrations, signatures, and arbitrary resources are reserved for
later profiles unless a versioned extension explicitly defines them. Manifest Skill names in Core
v0.1 are discoverable references only; they do not embed Skill content into the normalized Package.

## 4. Physical forms

### 4.1 Single-file Package

A compact Package MAY be one UTF-8 Yao source file whose filename ends in `.hns`:

```text
coding.hns
```

The file MUST contain exactly:

- one `(manifest ...)` top-level artifact;
- one `(contract ...)` top-level artifact;
- zero or one `(mind ...)` top-level artifact;
- one `(eval ...)` or one `(infer ...)` top-level artifact.

Unknown or duplicate top-level artifacts MUST cause loading to fail. Artifact order in source MAY
vary; normalization uses the logical order defined in section 10.

### 4.2 Directory Package

A resource-oriented Package MAY be a directory whose name ends in `.hns`:

```text
coding.hns/
|- manifest.yao
|- contract.yao
|- mind.yao             optional
`- programs/
   `- main.yao          example entry path
```

For HNS Core v0.1:

- `manifest.yao` MUST exist and contain exactly one `(manifest ...)` artifact;
- `contract.yao` MUST exist and contain exactly one `(contract ...)` artifact;
- `mind.yao`, when present, MUST contain exactly one `(mind ...)` artifact;
- the Manifest MUST name one relative Entry Program path;
- the selected Entry Program file MUST contain exactly one `(eval ...)` or `(infer ...)` artifact.

Unreferenced files are non-authoritative in Core v0.1. A Runtime MUST NOT execute them merely because
they are present. Their inclusion in future content identity, signing, or resource profiles remains
reserved.

### 4.3 Equivalent semantics

Single-file and directory Packages are two physical encodings of the same logical Package. After
loading, execution and binding MUST operate on the normalized Package and MUST NOT depend on the
original physical form.

## 5. Yao source requirements

HNS Core v0.1 artifacts use Yao S-expressions encoded as UTF-8 text.

Each top-level artifact MUST be an S-expression list whose first atom identifies its artifact kind.
A Loader MUST reject malformed source, an atom where a top-level list is required, or a required
artifact whose root name does not match its role.

This specification defines Package structure, not the complete Yao language. Entry Program syntax
and lowering are governed by the supported Yao language profile declared or implied by the Runtime.
Before Candidate status, HNS MUST define an explicit source-language compatibility field rather than
relying on Runtime-specific inference.

## 6. Manifest

### 6.1 Core grammar

The active Core v0.1 Manifest shape is:

```lisp
(manifest
  (id coding)
  (version "1.0.0")
  (title "Coding Harness")
  (entry "programs/main.yao")
  (capabilities
    (tools read search edit exec)
    (skills rust testing)))
```

`id`, `version`, and `title` are REQUIRED scalar fields. A directory Package additionally requires
`entry`. A single-file Package MAY omit `entry`; its normalized logical Entry Program ID is then
`main`.

Each scalar field MUST occur at most once and contain exactly one atom or quoted string value.
`capabilities` MAY occur once.

### 6.2 Harness ID

`id` is the stable publisher-selected Harness name. It MUST be non-empty. Core v0.1 does not yet
freeze a global namespace grammar. Publishers SHOULD use a collision-resistant, namespaced ID for
public Packages until governance defines a registry namespace.

### 6.3 Version

`version` is the publisher-declared Package version and MUST be non-empty. It is not content
identity. A Runtime MUST reject installing different content under an already installed `(id,
version)` pair.

Core v0.1 does not require Semantic Versioning, although publishers SHOULD use it when its meaning
fits their compatibility policy.

### 6.4 Title

`title` is human-readable presentation text. It MUST NOT be used for identity, authorization, or
dependency resolution.

### 6.5 Entry

For a directory Package, `entry` is a Package-relative path to the primary Yao Entry Program. It
MUST NOT be absolute, contain a parent traversal component, resolve through a link outside the
Package root, or otherwise escape the admitted Package boundary.

For a single-file Package, `entry` MAY name the logical Entry Program. Physical path resolution does
not apply.

### 6.6 Capabilities

`capabilities` declares requirements and discoverable references. It does not grant authority.

- `(tools ...)` contains zero or more Tool names;
- `(skills ...)` contains zero or more Skill names.

Names MUST be atoms. Duplicate names SHOULD be normalized to one logical occurrence. Unknown
capability categories MAY be preserved by a future extension, but a Core v0.1 Loader MUST NOT grant
or execute behavior based on an unknown category.

## 7. Contract artifact

The Contract artifact MUST have `(contract ...)` as its root. It supplies stable, model-visible
domain semantics and practice constraints.

The Contract:

- MUST be immutable for an exact Package identity;
- MUST be mounted from the exact bound Package;
- MUST NOT grant capabilities;
- MUST NOT assert that an external effect or verification occurred merely by declaring it;
- SHOULD remain compact enough to mount without forcing all detailed Skills into every Evaluation.

Contract subforms remain open in v0.1. Portable extensions SHOULD use namespaced roots until a later
profile standardizes domain objects, evidence declarations, or verifier interfaces.

## 8. Default Mind artifact

The optional Default Mind artifact MUST have `(mind ...)` as its root. It contains publisher-supplied
cognitive material for the bound Evaluation.

Default Mind MUST be mounted read-only. Loading, installing, or binding the Package MUST NOT
automatically write it into persistent Agent Mind. An explicit import, when supported, is a separate
authorized operation and SHOULD preserve Package provenance.

The internal Frame syntax of Default Mind is not frozen by HNS Core v0.1. A Loader MAY apply stricter
Runtime-specific validation before mounting it.

## 9. Entry Program

### 9.1 Cardinality and root

A Package MUST contain exactly one selected primary Entry Program. Its root MUST be exactly one of:

```lisp
(eval ...)
(infer ...)
```

`eval` declares Runtime-owned Evaluation execution. `infer` declares model-owned Evaluation
execution. A Loader MUST reject unknown entry roots and MUST NOT infer ownership from any other
syntax.

### 9.2 Program capability declaration

An Entry Program declares a Tool subset:

```lisp
(eval
  (requires (tools read search))
  ...)
```

Every declared Entry Program Tool MUST also appear in the Manifest Tool set. The program
declaration narrows the Package requirement; it does not grant authority. A model-owned `(infer
...)` Entry Program MUST contain an explicit `(requires (tools ...))`; `(requires (tools))` means
pure inference and exposes no model-callable Tool. A Loader MUST reject omission for a model-owned
entry. A Runtime-owned `(eval ...)` entry MAY omit the declaration only when the active Language
Profile defines the effective subset; omission MUST NOT mean unrestricted Tool access. For a
model-owned entry, the actual offered Tool set is the intersection of this upper bound, the
statically named `(call TOOL ...)` expressions in its complete body, and current authority.

### 9.3 Execution boundary

The Entry Program MUST execute under the Morphz Harness Specification. In particular, `call` or an
equivalent effect request MUST be mediated by Runtime authorization and execution, while nested
`infer` or its equivalent MUST preserve explicit causal identity and a bounded effective capability
scope.

## 10. Normalization and content identity

### 10.1 Logical normalization

A Loader MUST normalize both physical forms into this logical order:

1. Manifest with normalized `id`, `version`, `title`, logical `entry`, and recognized capability
   lists;
2. Contract;
3. Default Mind when present;
4. selected Entry Program.

Filesystem location, source whitespace, comments, and physical single-file versus directory form
MUST NOT affect logical Package identity when they parse to the same normalized artifacts.

The current reference implementation serializes the normalized artifacts as canonical Yao forms,
joins them with a single line-feed character, computes SHA-256 over the resulting UTF-8 bytes, and
represents the result as `sha256:<lowercase-hex>`.

### 10.2 Draft portability limit

The exact cross-implementation canonical Yao escaping, atom quoting, Unicode normalization, and
unknown-field ordering rules are not yet frozen. Therefore, v0.1 requires stable content identity
within a conforming implementation and equivalent identity for its own single-file and directory
encodings, but it does not yet authorize a claim of byte-identical hashes across independent
implementations.

Before Candidate status, the specification MUST publish canonical byte fixtures. Independent tools
SHOULD retain both the original source and the implementation-produced normalized representation
during this Draft period.

### 10.3 Immutability

Once an `(id, version, content identity)` is used by an Evaluation Binding, that identity MUST remain
recoverable for the lifetime and audit-retention period of the Evaluation. A Registry MUST NOT
silently replace its content.

## 11. Loading and validation

A Core v0.1 Loader MUST complete all of the following before Package activation:

1. require the `.hns` suffix on the file or directory Package;
2. parse all required Yao artifacts;
3. enforce artifact cardinality and root names;
4. validate required Manifest fields;
5. resolve the directory Entry without Package escape;
6. determine explicit Entry ownership;
7. verify that Entry Program Tool declarations are a subset of Manifest Tool declarations;
8. normalize the logical Package;
9. compute and retain content identity;
10. reject conflicting content for an installed `(id, version)` pair.

All validation that can be performed without external effects SHOULD complete before any Entry
Program node executes.

## 12. Registration, persistence, and binding

A Runtime catalog SHOULD persist enough normalized Package material to reload and verify an exact
installed identity after restart.

Registration MAY be idempotent when ID, version, and content identity all match. A conflict MUST be
observable and MUST NOT result in last-writer-wins replacement.

An Evaluation Binding MUST use exact ID, version, and content identity. The Package selected by a
Binding MUST be available during recovery. Registry discovery MAY expose version ranges or a latest
view for human selection, but such a floating reference MUST be resolved before durable binding.

## 13. Reserved extensions

The following Package capabilities are intentionally reserved and are not implied by Core v0.1:

- multiple named Entry Programs;
- package-local `process` definitions;
- embedded Skill resources;
- Verifier declarations and executable validator resources;
- Package dependencies and lockfiles;
- publisher identity, signatures, transparency logs, and revocation;
- state schemas and migrations;
- presentation metadata;
- environment or Execution Target requirements;
- policy overlays and Package composition;
- arbitrary binary assets.

An experimental implementation MAY support these features under a namespaced extension. It MUST
NOT present them as HNS Core v0.1 behavior.

### 13.1 Reserved Cognitive Application package layer

**COA** and `.coa` are reserved candidate names for a future Cognitive Application Package layer
above HNS. A future Profile may define:

- an Application Manifest and application identity;
- references to one or more exact HNS Package identities;
- application-level Skills, Verifiers, interfaces, evaluation assets, domain resources, and
  integrations;
- dependency, upgrade, signature, provenance, and rights metadata;
- resolution rules that select one exact Primary Harness Binding for each Evaluation.

HNS Core v0.1 MUST NOT recognize `.coa` as an HNS Package, infer application semantics from the
suffix, or present `.coa` support as a Core compatibility claim. Reserving the name and suffix does
not define the future format.

## 14. Error requirements

A Loader MUST fail visibly and without activation for at least:

- missing, duplicate, malformed, or unknown required artifacts;
- missing required Manifest fields;
- an invalid or escaping directory Entry path;
- an Entry Program whose root is neither `eval` nor `infer`;
- a program Tool requirement outside the Manifest Tool set;
- conflicting content under the same installed ID and version;
- unavailable required language or Harness compatibility;
- resource limits exceeded during parsing or normalization.

Errors SHOULD identify the Package, artifact, and violated rule without exposing secrets.

## 15. Security considerations

An HNS Package is untrusted input. A Loader and Runtime MUST defend against malformed or adversarial
source, path traversal, symlink escape, oversized artifacts, deeply nested expressions, capability
confusion, hash substitution, and same-version replacement.

Content identity and future signatures establish provenance and integrity; they do not authorize
Tool use. Entry execution remains subject to Runtime, Principal, target, sandbox, and Evaluation
policy.

Directory Packages require special care because Core v0.1 does not include arbitrary unreferenced
resources in normalized identity. Runtimes MUST NOT execute or trust such files. Publishers SHOULD
distribute only the active Core artifacts until a signed resource-manifest profile is defined.

## 16. Open decisions before Candidate status

HNS v0.1 cannot advance to Candidate status before resolving:

1. canonical Yao bytes, escaping, Unicode, and cross-implementation hash fixtures;
2. explicit Harness, HNS, Yao, and Runtime compatibility fields;
3. a global or publisher-namespaced Harness ID grammar;
4. signed resource manifests for directory Packages;
5. limits for source size, nesting depth, node count, and canonical output;
6. extension handling for unknown Manifest fields and top-level artifacts;
7. Package signatures, revocation, dependency, and lockfile profiles;
8. a standalone Loader conformance suite.

Each decision requires an MEP or an explicitly recorded format review.

## 17. Reference implementation status

The Morphz Runtime reference Loader currently accepts the two physical forms, enforces the Core
artifact cardinalities, parses the active Manifest fields, validates safe directory Entry paths,
checks program Tool narrowing, normalizes the Package, computes SHA-256 content identity, persists
canonical source, and rejects same-version content replacement.

It does not yet implement the reserved resource, signature, dependency, migration, or general
multi-entry profiles. This section is informative and is not a conformance claim.

## 18. Intellectual-property status

This Draft is licensed and governed by the active [IPR Status Notice](IPR_STATUS.md). Apache-2.0
provides its stated copyright and patent grants; trademark, compatibility-mark, and certification
rights remain separate.

## 19. Errata and interpretations

Suspected errors or ambiguities MUST be recorded through the public issue and MEP process described
in [MEP-0001](../meps/MEP-0001-specification-governance.md). Any interpretation that changes
required Package structure, content identity, loading behavior, or compatibility results requires a
Standards Track MEP and a versioned format update.
