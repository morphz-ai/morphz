# Build-tool export adapter

Upstream: npm minimatch 11.0.1, BlueOak-1.0.0, official security fix for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Original upstream LICENSE.md, README and distributed files are preserved.
Registry tarball integrity: `sha512-t+Vn6DX4wPCxS23y03C0uhF7S1jpi1GfqPrnlEipCJaA2ykiNbMkVlDutZtmvLfRcUN6R8AYVlzTsQrT4RZoLQ==`.

Local version `11.0.1+morphz.1` uses build metadata, not an invented upstream
release. The matching implementation is byte-identical upstream code. The only
code addition assigns CommonJS module.exports to the existing upstream matcher
function with all named exports retained. This lets older ESLint plugins call
require("minimatch") while modern callers use its named exports; ESM is unchanged.
No pattern parsing, matching, options, bounds or security logic is patched.

The manifest removes upstream development lifecycle scripts and includes this
notice. Dashboard and website lock the checked-in tarball by integrity through
an explicit override. There is no install-time mutation, audit exception,
framework migration or production Runtime change. Remove this adapter once the
installed lint dependencies all use the modern CommonJS interface.

Rebuild: `npm pack ./third_party/npm/minimatch --pack-destination third_party/npm`.
Verify: `node --test scripts/tests/minimatch-security.test.mjs`, both workspaces'
complete tests/build/lint, and unchanged npm audit gates.
