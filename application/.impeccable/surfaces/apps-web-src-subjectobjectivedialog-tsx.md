---
version: 1
slug: "apps-web-src-subjectobjectivedialog-tsx"
primary_target: "apps/web/src/SubjectObjectiveDialog.tsx"
related_targets: ["apps/web/src/SubjectObjectives.tsx","apps/web/src/subject-sidebar.css"]
---

# Goal detail dialog

Mode: Operate / Read. Scope: the existing Desktop goal viewer, not the global visual identity.

## Direction contract

THESIS: Goal content is the main object. Management recedes into a compact header, with no permanent bottom action bar.

OWN-WORLD: Preserve Morphz's application-following light/dark palette, accent, native modal, Lucide stroke icons and shared 32px icon controls. No independent theme or new component library.

STORY: Read the full goal and its actual status, supplement it through the shared composer, pause or resume it, and find secondary actions without losing drafts or execution history.

FIRST VIEWPORT: A content-centered dialog capped near 600px. Shared 14px dialog heading and quiet 12px status at left; supplement, copy, pause/resume, more and close icons at upper right. Dense detail body and editor share semantic 14px/1.6 tokens; plain-text paragraphs use 0.65em separation rather than blank-line height. Long content scrolls; short content stays short. Edit, execution records and delete live in More. Editing and deletion each have their own concise, protected state. Copy/edit preserve the full raw text; no Markdown rendering is claimed.

FORM: User-pinned body-led reading dialog with upper-right icon toolbar; concept-seed is not applicable under the precisely specified narrow-request exemption. No concept lottery or new visual identity.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
