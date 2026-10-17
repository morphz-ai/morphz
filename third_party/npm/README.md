# npm security overrides

These are targeted compatibility overrides, not disabled audits or major framework
migrations. Keep lockfiles and bundled licenses synchronized.

| Advisory | Workspace | Remediation |
| --- | --- | --- |
| GHSA-wq5f-xc86-pv6w | website | miniflare's sharp upgraded to 0.35.5 |
| GHSA-68fv-2mgg-jv7q | application, dashboard, website | source-map-js upgraded to 1.2.2 |
| GHSA-rj75-hqrm-r3gf | dashboard | postcss-selector-parser upgraded to 7.1.6 |
| GHSA-hp3w-g68c-fv3c | application | remove sprintf-js through compatible argparse 2.0.1 override for mammoth; DOCX import and CLI checked |
| GHSA-vfj7-8cjw-p6xm | dashboard, website | no upstream patch at review time; explicit local braces fork with non-overridable parser and external AST depth guards |

`braces-3.0.4-morphz.1.tgz` is generated from the adjacent source directory.
It is a locally patched **3.0.3**, not an upstream release. See
[braces/PATCH.md](braces/PATCH.md) for provenance, bounds, license and removal
conditions. The dependency remains named `braces` and the tarball is pinned by
the lockfile integrity digest. No install-time rewriting or network fork is used.

Verification:

```sh
node --test scripts/tests/dependency-security.test.mjs
node scripts/tests/dependency-security-clean-install.mjs
npm --prefix application audit
npm --prefix dashboard audit
npm --prefix website audit
```

Workspace builds, Dashboard tests and application's actual DOCX import regression
also cover compatibility. These checks establish the listed dependency fixes,
not a blanket claim that the application has no security defects.
