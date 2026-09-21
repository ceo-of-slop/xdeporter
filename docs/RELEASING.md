# Releases

Requirements: Node.js 22 or newer, Git, and the committed npm lockfile. The extension has no runtime npm dependencies; Playwright is used only for tests.

1. Update the version in `extension/manifest.json`, `extension/INSTALL.txt`, and `package.json`; refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
2. Run `npm ci --ignore-scripts`, `npx --no-install playwright install --with-deps chromium`, `npm test`, `npm run test:browser`, and `npm run test:package`. Linux runners use `xvfb-run -a npm run test:browser` and need OpenSSL for the offline HTTPS fixture.
3. Commit the reviewed changes, then create a tag matching the version, such as `v0.1.5`. Prefer a signed annotated tag when the maintainer has a signing key configured.
4. Push the commit and tag. The release workflow reruns all checks with a read-only token, builds from the clean tag, extracts the ZIP, and runs the real-browser security suite against that exact packaged extension. Only the tested ZIP and checksum pass to a separate release job. That job attests the artifact and creates a draft release. Review its notes and publish the draft.

`npm run package` builds a development ZIP from the current tracked source. `npm run package:release` additionally requires a clean working tree and a matching tag at HEAD, and reads the release files directly from that commit. Untracked extension files, unexpected permissions, missing resources, symlinks, and mismatched versions are rejected. The archive contains an explicit file allowlist, stable file order and timestamps, and no compression metadata. Text files are normalized to LF; tests verify that CRLF and LF checkouts produce identical ZIP bytes while binary files remain unchanged. The PowerShell packaging entry point forwards to this same packager.

Release files go to the ignored `dist/` directory. ZIP structure, names, checksums, manifest capabilities, resource references, and contents are checked before writing the artifact. The package tests exercise malformed archives and shipping-policy failures.

## Verify a download

Compare `sha256sum xdeporter-v0.1.5.zip` with `SHA256SUMS.txt`, or use PowerShell's `Get-FileHash .\xdeporter-v0.1.5.zip -Algorithm SHA256`. A checksum detects changes but is not an independent signature. For releases built by the workflow, verify the build provenance with:

```sh
gh attestation verify xdeporter-v0.1.5.zip --repo ceo-of-slop/xdeporter --signer-workflow ceo-of-slop/xdeporter/.github/workflows/release.yml
```

## Repository settings

The maintainer should enable immutable releases, private vulnerability reporting, and rules protecting `main` and version tags from deletion or force-push. Require the Tests check before merging and restrict release-tag creation to maintainers. Enable dependency alerts and code scanning where available. These are GitHub settings, separate from this repository's workflows. Dependabot checks the locked test dependency and pinned Actions weekly.
