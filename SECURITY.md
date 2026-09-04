# Security Policy

## Supported versions

Morphz 0.1 is a Developer Preview. Security fixes are provided for the latest published release
and the current `main` branch. Older preview builds may require an upgrade before a fix can be
applied.

## Reporting a vulnerability

Report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/morphz-ai/morphz/security/advisories/new).
Please do not open a public issue for an undisclosed vulnerability.

Include the affected version or commit, operating system, reproduction steps, expected impact, and
any relevant logs with credentials and personal data removed. Reports involving sandbox escape,
credential exposure, authorization bypass, unsafe state mutation, or release integrity are treated
as security-sensitive even when the impact is uncertain.

The maintainers will acknowledge a complete report within five business days, coordinate validation
and remediation with the reporter, and publish an advisory when users need to take action. Please
allow a reasonable remediation window before public disclosure.

## Security boundary

Morphz executes model-proposed actions only through explicitly granted capabilities and platform
sandboxing. A model response, project file, Harness, tool result, or retrieved document is untrusted
input; it does not grant authority by itself. See the
[security and permission boundaries documentation](https://morphz.ai/en/docs/security) for the
runtime model and deployment responsibilities.
