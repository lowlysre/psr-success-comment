# Contributing

```sh
npm ci
npm run check
```

`npm run check` type-checks, runs the tests, and rebuilds `dist/`. Coverage over `src/` must stay at 95% for lines and functions and 90% for branches, excluding `src/index.ts`. `npm run test:coverage` prints the per-file report.

- [Layout](#layout)
- [Tests](#tests)
- [Claims and sources](#claims-and-sources)
- [The dist directory](#the-dist-directory)
- [Releases](#releases)
- [Docs](#docs)
- [Required status checks](#required-status-checks)
- [Workflow security](#workflow-security)

## Layout

| Path                     | Purpose                                                                     |
|--------------------------|-----------------------------------------------------------------------------|
| `src/index.ts`           | Entry point.                                                                |
| `src/main.ts`            | Reads inputs, runs the steps, sets outputs, and writes the log and summary. |
| `src/git.ts`             | Finds the previous tag and lists the release's commits.                     |
| `src/github.ts`          | REST and GraphQL client with retries and rate-limit waits.                  |
| `src/release.ts`         | Finds pull requests and closed issues, then comments and labels.            |
| `src/comment.ts`         | Comment text, the release marker, and the closing-keyword parser.           |
| `src/format.ts`          | Status colors for the log and the summary.                                  |
| `test/helpers.ts`        | Temporary git repositories and the local stand-in for the GitHub API.       |
| `dist/index.cjs`         | The bundled action that runs on the runner.                                 |
| `.github/linters/`       | MegaLinter, Prettier, markdownlint, and actionlint configuration.           |
| `.github/releaserc.toml` | python-semantic-release configuration.                                      |
| `.github/codeql/`        | CodeQL configuration.                                                       |

## Tests

The tests use `node:test` and run the TypeScript directly. They need `git` on the `PATH`.

Nothing is mocked below the action's own code. Git behavior runs against real repositories in a temporary directory, isolated from your git configuration. API behavior runs against a local HTTP server that implements the REST and GraphQL calls the action makes, including pagination, 403, 404, and rate limits.

## Claims and sources

- Link claims about another project to a file and line at a fixed commit, not a branch.
- Back claims about this action's behavior with a test.
- Say so when something is unverified.

## The dist directory

The action runs from `dist/index.cjs`. Commit the rebuilt file with source changes: CI rebuilds it and fails when the committed copy is stale.

[`third-party-notices`](https://www.npmjs.com/package/third-party-notices) generates `dist/THIRD_PARTY_LICENSES.txt` for production dependencies, configured under `thirdPartyNotices` in `package.json`.

## Releases

Every push to `main` runs [`release.yml`](../.github/workflows/release.yml). python-semantic-release tags the pushed commit and creates the GitHub release when the commits since the last tag call for one. The action then runs from the checked-out source on that release.

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) set the version: `fix:` is a patch, `feat:` a minor, `!` or a `BREAKING CHANGE:` footer a major. With squash merges, the pull request title is the message.
- The workflow passes `commit: false` and `changelog: false`, so a release adds tags and no commit. `version` in `package.json` stays as is.
- `add_partial_tags` moves the `v1` and `v1.2` tags to each release ([PSR configuration](https://github.com/python-semantic-release/python-semantic-release/blob/b700dbeb1f431a0fcc30a79f3f0869407fe07278/docs/configuration/configuration.rst?plain=1#L123-L135)).
- The release job's harden-runner runs in `audit` mode until the endpoints the PSR Docker build needs are known.

## Docs

Each page under `docs/` starts with a table of contents of its `##` headings, updated by hand. MegaLinter fails on a link or anchor that points nowhere: markdownlint within a page, lychee across pages.

## Required status checks

Each pull request workflow ends in a [`lowlydba/are-we-good`](https://github.com/lowlydba/are-we-good) job that fails if any job it needs failed or was cancelled. Require these two checks, not the jobs behind them:

- `ci-are-we-good`: type check, tests, build, zizmor, and MegaLinter.
- `codeql-are-we-good`: CodeQL for the workflows and the TypeScript.

`scorecard.yml` and `release.yml` run on pushes to `main` only.

## Workflow security

CI audits the workflows with zizmor's pedantic persona. To run the same audit locally, online audits included:

```sh
GH_TOKEN=$(gh auth token) zizmor --persona pedantic .github
```

Every job except the release job starts with step-security/harden-runner in `block` mode. A job that needs a new network endpoint fails until the endpoint is in its `allowed-endpoints` list.
