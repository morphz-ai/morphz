# Homepage concepts

These are additive, local design routes, not a replacement for `/` and not a
deployment of the account service. They are excluded from the sitemap and carry
`noindex, nofollow`. No new dependencies or external account APIs are used.

| Route | Main decision | Agent entrance |
| --- | --- | --- |
| `/homepage-lab/a` | Open-source technical project first | Local install and personal Agent side by side; official Agent immediately below the technical introduction |
| `/homepage-lab/b` | Technical identity and immediate use together | First-fold start panel: personal Agent, official Agent, local Runtime |
| `/homepage-lab/c` | Work-first application entrance | Write a task first; preserve it across sign-in and creation; switch explicitly between personal and official Agent |

`/homepage-lab` opens the selected concept A. All three keep the existing Morphz mark, headline,
and technical concepts so the comparison is primarily information architecture,
not a proposed rebrand. The research/docs/source links and existing demo video are
real website resources; the runtime visual is labeled as a structural illustration.

## Selected candidate A

A is now a complete local homepage candidate, still separate from `/`. It reuses
the original `BrandMark`, `ButterflyArrival`, theme switch, electric-cyan palette,
light/dark CSS variables, rounded panels, headline, recording, and paper results.
Its sequence is: technical introduction and runtime illustration → compact
official-persona entrance → real recording → three mechanisms → paper/evaluation
→ installation and personal-Agent creation → documentation/community footer.
The personal entrance is also available in the header and hero.

Copy rules for this revision:

- Chinese navigation, headings, labels, and explanatory prose. Preserve actual
  product names, operator names, commands, and source identifiers where needed;
  do not add decorative English subtitles to the Chinese page.
- Explain the product to visitors. Keep design rationale, revision commentary,
  and instructions to reviewers in this README, not in homepage copy.
- Keep the original brand vocabulary and supported technical claims. Reuse
  recorded evidence with its evaluation context; do not invent activity feeds,
  adoption figures, or stronger claims to make the page appear more established.
- The preview toolbar owns prototype warnings and comparison controls. It is not
  proposed production navigation. Actual sign-in/provisioning remains a separate
  integration gate.

`tests/homepage-candidate.test.mjs` guards the Chinese-copy boundary, brand reuse,
technical-first order, real local destinations, evaluation context, and noindex.

## Interaction scope

- Personal Agent: entry → simulated GitHub sign-in → name → workspace → simulated
  model connection → sample conversation.
- Official Agent: separate shared-cognition conversation; sign-in when sending.
- Public and private drafts/messages are separate. The work-first draft survives
  the sign-in/create flow. Returning to the homepage keeps the current demo Agent.
- Sign-out requires sign-in before returning to the personal workspace.
- Reset or page reload discards demo state; there is no persisted account, real
  Agent provisioning, model request, credential collection, or cloud cost.
- The native dialog supports keyboard dismissal. Model setup never asks for real
  secrets. This interaction prototype must not be relabeled as a working account
  service without replacing the simulated operations with the verified real flow.

## Verification

Validated on 2026-09-20: website build, typecheck, focused ESLint, and all 89
website tests passed (85 existing plus 4 candidate tests). Candidate A browser
checks covered 320, 390, 768, and 1280 CSS-pixel widths without horizontal
overflow; desktop/mobile layout; light/dark theme persistence; runtime
illustration tabs; platform-specific installation commands; simulated
create/model/message flow; independent official/personal drafts; sign-out and
re-entry; and keyboard dialog dismissal. A narrow-column defect in the mobile
official-persona strip was corrected and visually rechecked.

The video poster rendered correctly. An accessibility-action click on the native
video control crashed one temporary in-app-browser tab. A fresh tab with a click
on the visible play control successfully played the unchanged 160-second video:
playback advanced past 11 seconds, `readyState` was 4, the media error was null,
and pausing worked. That verification tab had no console warnings or errors.
This verifies the local prototype, not production frontend/backend acceptance;
no deployment was performed.
