# Morphz desktop icon

`morphz.svg` preserves the exact silhouette, proportions and colors of the
approved `Morphz/assets/brand/morphz-avatar-cyan.svg`. It is not a new logo.
Run `node scripts/render-desktop-icon.mjs` to produce the native-resolution
1024 × 1024 PNG. Packaging generates all ten 1×/2× ICNS representations and
updates an existing bundle when the image hash changes.

The application uses `CFBundleIconFile`, not `app.dock.setIcon()`. The latter
overrode the system-normalized app icon with a raw, oversized square NSImage.
In macOS 26, the system masks and normalizes the bundled flattened artwork;
the source stays full-bleed with its original internal clear space. Do not
add a second hand-drawn rounded mask, frame, or extra background around it.

This is a flattened ICNS development bundle, not a layered Icon Composer
asset or a claim of custom Liquid Glass appearance variants.

References: [Apple app icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons)
and [Apple's explanation of existing Mac icon normalization](https://developer.apple.com/videos/play/wwdc2025/220/).
Actual Dock size and corners were checked on macOS 26.5.1; other OS versions
have not been visually accepted.
