# Morphz License Scope

> Effective: 2026-09-03
>
> Canonical language: English
>
> Chinese translation: [LICENSE_SCOPE.zh-CN.md](LICENSE_SCOPE.zh-CN.md)

## Default license

Unless a file, directory, or artifact states different terms, original material in this repository
is licensed under the [Apache License, Version 2.0](LICENSE). This default includes Morphz software,
tests, developer tooling, examples, technical documentation, normative specifications, and public
conformance fixtures authored for the project.

The SPDX identifier for this license is `Apache-2.0`.

## Material with separate terms

The following material is not relicensed by the repository-level Apache-2.0 license:

- `third_party/` and other vendored or derived third-party material are governed by the license and
  attribution files accompanying that material;
- `docs/ip/` contains patent application and related legal materials; all rights in those documents
  are reserved unless a file expressly states otherwise;
- `website/public/paper/` contains research-paper editions; all rights in those editions are
  reserved unless an edition expressly states otherwise;
- `website/content/` contains editorial website content; all rights in that content are reserved
  unless a file expressly states otherwise;
- logos, artwork, product identity assets, and compatibility or certification marks are governed by
  [TRADEMARKS.md](TRADEMARKS.md), not by the source-code license;
- benchmark corpora, model weights, and generated job artifacts are governed by their accompanying
  terms and are not covered merely because they are stored beside Morphz source code.

Dependency manifests and lockfiles identify external packages but do not relicense them. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Patent and trademark boundaries

The patent grant applicable to Apache-2.0 material is Section 3 of the Apache License. The project
does not add an implied or broader patent promise. See [PATENTS.md](PATENTS.md).

The Apache License does not grant rights to use project names, product names, logos, service marks,
or compatibility marks except for the limited customary uses stated in Section 6. See
[TRADEMARKS.md](TRADEMARKS.md).

## Conflicts

The license notice attached most specifically to a file or separately distributed artifact
controls that material. This scope document explains repository boundaries but does not modify the
terms of the Apache License or any third-party license.
