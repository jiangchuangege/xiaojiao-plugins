# compatibility.md

## Verified matrix (local evidence, 2026-08-13)

| Axis | Verified | Evidence |
| --- | --- | --- |
| Harness baseline | local `master` @ `47f943859bef60e4160492346772ded9b24f765a` | acceptance script (CLI install, composition, real boot) |
| Node | v24.18.0 | all local gates |
| Browser | Google Chrome 151.0.7922.109 (macOS arm64) | real-Chrome suite (46 tests) |
| OS | macOS | real-Chrome suite |
| pnpm | 11.7.0 (corepack-managed) | acceptance script pins it |

## Unverified (publication gates)

Node 22.19 and 26, Linux, Windows, and Chromium variants other than Chrome 151 are declared-supported only once CI evidence exists. Platforms where sandbox confinement or a connect-IP egress proof is unavailable are removed from the supported matrix rather than claimed.

## npm release baseline

The npm-published `@deepseek-ai/dsh-*` rc family lags the local checkout (e.g. `dsh-attachment` 0.0.1-rc.1 vs local 0.1.0-rc.5) and its rc manifests reference the unpublished `dsh-type-meta`. Publication must pin a released npm baseline and verify the API surface against it; the local acceptance works around the rc gap with an explicit peer install plus a local `dsh-session` stand-in.
