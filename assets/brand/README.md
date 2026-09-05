# Morphz brand assets

The primary mark is the pointed, butterfly-shaped M in electric cyan (`#56d0de`).
Both repository READMEs reference the same SVG as the website navigation:
[`morphz-mark-cyan.svg`](../../website/public/brand/morphz-mark-cyan.svg).

`morphz-avatar-cyan.svg` and `morphz-avatar-cyan-512.png` place that exact silhouette on
a full-bleed dark background, with clear space for square or circular avatar masks.
Use the PNG for the GitHub organization avatar. Regenerate it with:

```bash
MORPHZ_BRAND_SHARP=/absolute/path/to/sharp/dist/index.cjs node scripts/render-github-avatar.mjs
```

The previous `(M)` design remains in `morphz-mark.svg`, `morphz-avatar.svg`, and
`morphz-avatar-512.png` as a legacy asset. Existing videos can retain it until their next update.

- Ink: `#17191d`
- Paper: `#f7f8f8`
- Accent: `#56d0de`

Preserve the pointed tips, continuous wings, and proportions of the primary mark.
See the [website brand guide](../../website/brand/README.md) for other approved formats.
