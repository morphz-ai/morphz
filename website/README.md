# Morphz website

The public Morphz website and bilingual product documentation live here. The site is built independently from the embedded Runtime Dashboard but versioned in the same repository.

## Content boundaries

- `content/docs/zh` and `content/docs/en` contain public, current product documentation.
- Repository-level `docs/` contains architecture, research, evaluations, and historical material and is not published automatically.
- `lib/docs.generated.ts` is generated from Markdown and must not be edited by hand.

## Local development

```bash
npm install
npm run dev
```

## Validation

```bash
npm test
npm run lint
```

Every public page must keep its Chinese and English slug in parity. Update both languages when a product contract changes.

## Generated CLI reference

The bilingual CLI reference is generated from the same Clap command tree used by the Morphz binary. Refresh it from the repository root after changing CLI commands, options, or localized help:

```bash
cargo run -q -p morphz-cli-docs -- website/content/docs
```

Do not edit `content/docs/{zh,en}/cli-reference.md` by hand. The generator tests assert that every registered command path is present and that both locales render deterministically.
