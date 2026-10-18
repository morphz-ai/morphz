---
version: 1
slug: "apps-web-src-reader-tsx"
primary_target: "apps/web/src/Reader.tsx"
related_targets: ["apps/web/src/reader.css","apps/web/src/reader-pagination.ts","apps/web/src/reader-dom.ts"]
---

# EPUB reading

Mode: Read. Extend the existing Reader, not Morphz's visual identity.

## Direction contract

THESIS: Read a book one composed page at a time, not a long webpage trapped inside the workspace. Content remains selectable, annotatable and exactly addressable.

OWN-WORLD: Inherit Morphz's light/dark and Reader preferences, quiet neutral surfaces, serif reading face and Lucide icons. No paper texture, page curl, extra toolbar stack or new theme system.

STORY: Open at the saved source position, read, turn pages with edge arrows, wheel/trackpad or keyboard, and continue across chapter boundaries. Agent jumps still address immutable source text, not guessed screen-page numbers.

FIRST VIEWPORT: Preserve the three-column shell and compact existing book toolbar. A bounded, centered text measure fills the reading height; page arrows occupy only the side gutters. A small chapter/page indicator sits below the page, above the collapsed input's safety area. No persistent scrollbar or oversized navigation footer. Narrow windows keep readable margins, reachable controls and the same source position. Brief horizontal transitions respect reduced motion; selection and input shortcuts are never hijacked.

FORM: User-pinned Apple Books-like light horizontal pagination inside the incumbent Reader; the local-extension exemption applies, with no concept lottery or new visual world.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Boundaries

Pagination is transient layout state, not a new database or stored page identity. Existing positions store source offsets; books, versions, marks, permissions, tool definitions and in-flight work remain intact. PDF retains its real page semantics, other documents retain continuous reading. Validate both direct catalog opens and application-host opens without test-only height overrides.

## User additions: exchange density

The user identified excessive vertical space around the current-reading association and repeated failure copy. Follow DESIGN.md's explicit combination-density rules: a 24px metadata row, shared 4/8px gaps and icon-xs removal; one readable error with real expandable details, not three repetitions. Preserve original error text and exact causal identities. Include the full composer and error message in the finish review, not just the reading canvas.
