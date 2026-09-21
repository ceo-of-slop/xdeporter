# Security

Use [private vulnerability reporting](https://github.com/ceo-of-slop/xdeporter/security/advisories/new) for security issues. Include the affected version, reproduction steps, and impact. Never include real session cookies, authorization headers, or personal account data. If private reporting is unavailable, open an issue asking for a private contact without disclosing the vulnerability.

Security fixes target the latest release. Older versions do not receive separate backports.

The extension treats X page content and page scripts as untrusted. Only its background worker can perform country lookups and write lookup results to the cache. Authentication stays in extension memory, is scoped to its exact X/Twitter origin, and is cleared when lookups are disabled. It is never stored or exposed to content scripts. Disabling also aborts pending lookups and stops observing requests.

X's reported country is an estimate, and its private API and page markup can change. Country filters are not an access-control or identity-verification mechanism. See [data limits](docs/SOURCES.md) and [release verification](docs/RELEASING.md).
