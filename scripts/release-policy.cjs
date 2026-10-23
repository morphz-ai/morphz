#!/usr/bin/env node
"use strict";

// Reuse the existing locked node-semver dependency; do not guess versions from
// tag substrings or implement a second SemVer grammar in release automation.
const semver = require("../dashboard/node_modules/semver");

function releasePolicy(packageVersion, tag) {
  const parsed = semver.parse(packageVersion);
  if (!parsed) throw new Error("Cargo package version must be valid SemVer");
  const canonical = `${parsed.major}.${parsed.minor}.${parsed.patch}`
    + (parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : "")
    + (parsed.build.length ? `+${parsed.build.join(".")}` : "");
  if (canonical !== packageVersion) {
    throw new Error("Cargo package version must be canonical SemVer");
  }
  if (tag !== `v${packageVersion}`) {
    throw new Error("Release tag must exactly match the Cargo package version");
  }
  const prerelease = parsed.prerelease.length > 0;
  return {
    version: packageVersion,
    tag,
    prerelease: String(prerelease),
    make_latest: String(!prerelease),
    release_branch: `release/${parsed.major}.${parsed.minor}.${parsed.patch}`,
  };
}

module.exports = { releasePolicy };

if (require.main === module) {
  try {
    const [packageVersion, tag, ...extra] = process.argv.slice(2);
    if (!packageVersion || !tag || extra.length) {
      throw new Error("Usage: release-policy.cjs PACKAGE_VERSION TAG");
    }
    for (const [key, value] of Object.entries(releasePolicy(packageVersion, tag))) {
      process.stdout.write(`${key}=${value}\n`);
    }
  } catch (error) {
    process.stderr.write(`Release policy rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
