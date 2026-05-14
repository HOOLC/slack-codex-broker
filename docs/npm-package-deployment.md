# NPM Package Deployment

## Goal

Ship broker releases as built npm packages, then let admin deploy and roll back
installed package versions.

Production must not be a build machine. CI or a release workstation builds the
TypeScript and admin assets, packs the npm artifact, and publishes or stores that
artifact. The live admin process only chooses a package version, installs that
version into a versioned release directory, switches the `current` symlink, and
restarts the launchd services.

## Current State

The current release path is Git based:

- the live machine keeps a repository clone;
- admin fetches refs from that clone;
- deploy creates a Git worktree under `releases/<sha>`;
- deploy runs `pnpm install`, `pnpm build`, then `pnpm install --prod` on the
  live machine;
- rollback can resolve an arbitrary Git ref and build it if that release is not
  already present.

That couples live deploy safety to Git/network/build behavior on the production
host. It also makes the public package boundary unclear because deployment relies
on a whole checkout instead of a runtime artifact.

## Target Design

The release unit is the npm package:

The package is named `agent-session-broker`, not after Slack or Codex. The
release artifact should describe the stable abstraction: sessions from external
message systems connected to agent runtimes. Slack and Codex are adapters inside
that package, not the package identity.

1. `pnpm build` creates `dist/` with server code, copied prompt assets, and the
   built admin UI.
2. `pnpm release:pack` packs the runtime package from explicit `package.json`
   `files`.
3. CI always builds, tests, and packs an artifact for the checked commit.
4. The npm publish workflow publishes that same package to npm for versioned
   releases.
5. The admin deployment service reads candidate versions from the package
   registry.
6. Deploy installs `agent-session-broker@<version>` into
   `<service-root>/releases/npm-<version>/`.
7. The `current` symlink points at the installed package root inside that release
   directory.
8. Rollback only activates a release that is already installed locally. It never
   fetches source or builds a missing version during rollback.

Package contents are runtime-only:

- `dist/`;
- launchd helper scripts needed by installed services;
- README, license, and package metadata.

Source files, tests, local state, generated preview data, and private operator
configuration are not part of the package.

## Publish Workflow

Npm publication is a release operation, not a side effect of every push.

- Pull requests and pushes run CI build, test, and pack.
- Versioned release tags and manual dispatch run the npm publish workflow.
- The publish workflow installs dependencies from the lockfile, builds, tests,
  packs the artifact for inspection, then runs `npm publish`.
- The workflow uses `NPM_TOKEN` from GitHub Actions secrets and does not store
  npm credentials in the repository.
- The workflow requests GitHub OIDC permission and publishes with npm
  provenance.

## Public Boundary

Open-source metadata must point at the public repository. Tests and fixtures may
use reserved example identities, but must not encode real operator emails,
accounts, hosts, domains, or tokens as negative assertions.

The right test shape is to assert the expected public structure: package files,
repository metadata, deployment commands, and UI labels. Avoid tests like
"repository does not contain X" where `X` is a real private value.

## Admin UX

The publish panel selects package versions, not free-form refs or main commits.

- The deploy selector lists recent package versions returned by deployment
  status.
- The deploy request sends a version.
- The recent release list remains the rollback surface.
- Each rollback button activates that already-installed package release.

## Acceptance Criteria

- `package.json` has explicit package metadata for the public repository.
- `package.json` exposes a runtime-only `files` boundary for packed releases.
- CI builds, tests, and packs the npm artifact.
- `.github/workflows/npm-publish.yml` publishes `agent-session-broker` from
  versioned release tags or manual dispatch using `NPM_TOKEN`.
- Admin deployment status reports package name and recent package versions.
- Admin publish UI selects a package version.
- `/admin/api/deploy` requires a package `version`, not a Git `ref`.
- `ReleaseDeploymentService.deploy` does not run Git fetch/worktree commands.
- `ReleaseDeploymentService.deploy` does not run `pnpm install` or
  `pnpm build` on the live host.
- `ReleaseDeploymentService.rollback` only uses local installed releases.
- Launchd services still execute through the `current` symlink.
- Regression tests avoid private-string negative assertions.
- `pnpm test` and `pnpm build` pass.
