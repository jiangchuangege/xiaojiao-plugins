# release.md

Source publication to the community collection `acosmi/dsh-plugin` (public) is done (`plugins/dsh-browser-automation/`). npm publication and official intake remain No-Go: no publisher scope or official plugin registration exists yet. This file records the release procedure for when those gates open.

## Preconditions

1. Publisher npm scope decided; `@dsh-browser-automation` replaced mechanically in all manifests.
2. Harness npm baseline locked; compatibility re-verified against it (`docs/compatibility.md`).
3. License holder decision recorded (MIT candidate).
4. `pnpm run typecheck && pnpm run test && pnpm run test:coverage` green (per-file 100%).
5. `scripts/acceptance.mjs` green (install, composition, real boot, keyless read-only call, tarball pack/install/uninstall).
6. `scripts/exports-check.mjs` + publint + license/NOTICE audit green.

## Steps

1. Bump versions; update CHANGELOG.
2. Build: `pnpm run build`.
3. Pack all four packages exactly once; record SHA-256 of each tarball.
4. Publish with a protected token under a prerelease dist-tag; never repack in the publish job.
5. Tag the public repository with `dsh-plugin`; README carries the current install command.
6. After a full compatibility cycle, consider a stable version — never before.

## Integrity rules

- Same version + different integrity must never overwrite; identical artifacts may retry idempotently.
- Tarballs carry their own LICENSE and NOTICES; no source maps, fixtures, absolute paths, or internal URLs.
- No lifecycle scripts required: install/boot must pass with `allowBuilds` empty.
