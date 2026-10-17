# Local security patch

Base: upstream `braces@3.0.3` from the npm registry, MIT, copyright and original
README preserved. `3.0.4-morphz.1` is a local fork identifier, NOT an upstream
release. The upstream advisory is GHSA-vfj7-8cjw-p6xm / CVE-2026-93687:
https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

The parser now rejects brace/parenthesis nesting beyond 128 before building a
deep tree. The compile, expand and stringify entry points validate external
ASTs iteratively, including cycles, depth and node count, before recursive
walkers. Callers cannot override these safety ceilings. Other parsing and
expansion behavior and the existing output-range guard remain upstream code.

Dashboard and website use the checked-in npm tarball through explicit lockfile
overrides; installation does not rely on a postinstall patch or a network fork.
Rebuild with `npm pack ./third_party/npm/braces --pack-destination third_party/npm`.
Remove the override and this fork when a verified upstream release fixes the
advisory. Tests: `node --test scripts/tests/dependency-security.test.mjs`.
