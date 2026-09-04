# Morphz technical website

`website/` is the public technical home of Morphz. It publishes the computational idea, paper, source, downloads, and bilingual product documentation. It is built independently from the embedded Runtime Dashboard but versioned in the same repository so implementation and public claims can change together.

## Public surface boundary

- `morphz.ai` — this project: technical main site, paper, essay, documentation, and distribution.
- `chat.morphz.ai` — separate persona site: the official Morphz agent's state, activity, and public interaction.
- the future consumer Agent product — a separate product surface; it is not implemented inside this technical website.
- the future managed Cloud/SaaS — a separate operational product; it is not implied by the download page.

The main site may link to these surfaces, but it must not present an official persona, a user's private Agent, and the open-source Runtime as the same product or workflow.

## Content boundaries

- `content/docs/zh` and `content/docs/en` contain public, current product documentation.
- `public/paper` contains the frozen bilingual preprint served by the paper route.
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

## Production deployment

Build and deploy the generated Worker from `website/`:

```bash
npm test
npm run lint
npx wrangler deploy --config dist/server/wrangler.json --strict \
  --domain morphz.ai --domain www.morphz.ai
```

Wrangler records every deployed Worker version. List the available versions and restore a known-good version with:

```bash
npx wrangler deployments list --name morphz-website
npx wrangler rollback VERSION_ID --name morphz-website
```

After a deployment, verify the Chinese and English navigation, documentation language switch, PDFs, installers, crawler files, and the semantic 404 page on `https://morphz.ai`.

## Generated CLI reference

The bilingual CLI reference is generated from the same Clap command tree used by the Morphz binary. Refresh it from the repository root after changing CLI commands, options, or localized help:

```bash
cargo run -q -p morphz-cli-docs -- website/content/docs
```

Do not edit `content/docs/{zh,en}/cli-reference.md` by hand. The generator tests assert that every registered command path is present and that both locales render deterministically.
