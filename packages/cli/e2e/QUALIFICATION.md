# Survey isolation and FlightPaths follow-up

## Large JSON output qualification — September 8 follow-up

The expanded real packed fixture reproduced truncated Nx logger output on the
Nx 22 lane. CLI/plugin private-file handoff fixed that boundary. Both real lanes
then passed with 220 additional library projects each: 143,379-byte Nx 22 report
and 142,936-byte Nx 23 report, parsed directly from complete stdout. Consumer
snapshots, the read-only store and shared installation registry stayed unchanged.

`npm exec nx -- run @megamono/cli:e2e-survey-output` separately passed with a
559,997-byte Unicode report over real OS pipes and a deliberately slow reader.
It exercises the packed CLI with a synthetic Nx producer (not a real graph),
including nonzero graph failure and malformed JSON; failure stdout is empty and
the final stderr record carries a stable error code. Unit tests cover staging
failure, preflight failure, and private-file cleanup on both success and failure.
The real isolation fixture still covers actual npm staging and Nx generation.
This is not a rerun of Fontstack's application graph/build or container tests.

## Repeatable packed isolation fixture

Run `npm exec nx -- run @megamono/cli:e2e-isolated-yalc-survey` on a POSIX
host under Node 24 with npm and Yalc available. Public registry access is
required. The fixture uses real packed Megamono, real npm/Nx installations,
and a real Yalc process redirected to a disposable store (no HOME change).
No real adopter installation or global Yalc publication is performed.

September 8, 2026: both synthetic lanes passed: Nx 22.7.8/TypeScript 5.9.3 and
Nx 23.1.1/TypeScript 6.0.3. The fixture proved source-store writes fail, both
complete consumer snapshots (including installed files and symlink identities)
remain equal, the source store remains equal, only `yalc dir` executes, the
shared installation registry hash remains equal, and survey staging is removed.
Reports, tarball hashes and logs are in `tmp/survey-isolation/`.

The fixture exposed a second real issue beyond Yalc registration: `fs.cp`
preserves read-only modes. The CLI now makes **only the private copy**
owner-writable so npm can install dependencies and cleanup can complete.
Nx cache/workspace-data directories are also staged privately, with the daemon
disabled. The faster `e2e-ephemeral-survey` fixture still substitutes installation
transport; it is not equivalent evidence to the real-process lane.

## Read-only FlightPaths rerun

Both actual repositories passed `adopt --survey --format=json
--local-packages=yalc` using the built CLI from commit
`995dfa4440497eb02e0e05b57a43c9d83ee577b4` and the existing Yalc plugin publication.
Package-manager caches were placed in disposable directories; no dependency
installation into FlightPaths or adoption writes were performed.

- `flightpaths-int` at `6550587f437ab051c3afe774430fad47818f38dc`: 27 projects,
  pnpm 11.24.0, declared Nx 22.7.8 and TypeScript `~5.9.2`.
- `flightpaths-js` at `63c29779edcff067e625b01396a3e481e90f6600`: 10 projects,
  pnpm 11.24.0, declared Nx 23.1.1 and TypeScript `~6.0.3`.

The API repository had advanced from the original audit baseline; this result
applies to the revision above. Both Git statuses remained clean. Before/after
snapshots covered all tracked and non-ignored untracked files plus Git status,
not ignored dependency/cache trees in the actual adopters. Full installed-tree
isolation is covered separately by the disposable fixture.

Before and after hashes were identical:

- API repository: `20ec148ea9e154e51fbeb35d2e0ae2e8cb718e92cd4689c315db533993800f65`
- JS repository: `f8efd4c4feacd3491bdb34f8538975fd53bd1a881213223ff2058bee65f52430`
- Shared Yalc installation registry: `825cfae740cbb7de7189c0fbb5046f9f6ead5b3f3c480ed8ca1b97d3f12b4944`

Local reports and complete survey output are retained in
`tmp/flightpaths-survey/`. The hashes identify this check, not a permanent
version identity or runtime compatibility certificate.

## Remaining application decisions (not applied)

The API survey requests a reviewed Render service mapping. Based on the existing
Blueprint and Nx graph, the candidate `--renderServiceProjects` value is:

```json
{
  "flightpaths-api": {
    "project": "@flightpaths-int/api",
    "root": "apps/api"
  }
}
```

Review this together with the pilot adoption map on a named application branch.
Project ownership must not change the root-level Blueprint command cwd, manual
release admission, predeploy migrations, `/ready`, or existing Springbar/CI
ownership. Shared-library platform choices and any documentation ownership
remain reviewed application configuration. No map, tag, dependency or runtime
migration was applied by this work.

Storage/cache **generated** consumer qualification remains blocked on Playstack
publishing templates. Megamono now regression-tests truthful requirements-only
planning with those real manifests; see the plugin E2E qualification document.
