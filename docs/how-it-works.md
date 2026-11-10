# How it works

This page describes each step, the code it follows, and how each claim can be checked. Links to other projects point at a fixed commit, so the lines they cite don't move.

- Node reference: `@semantic-release/github` at [`30e351e`](https://github.com/semantic-release/github/tree/30e351e9378ca93c88d064ad047bb102019f8993), mainly [`lib/success.js`](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js).
- PSR reference: python-semantic-release at [`60de8fc`](https://github.com/python-semantic-release/python-semantic-release/tree/60de8fcacea7fd5177f34368490677be5f098995).

Contents:

- [1. Find the commits](#1-find-the-commits)
- [2. Find the pull requests](#2-find-the-pull-requests)
- [3. Find the closed issues](#3-find-the-closed-issues)
- [4. Comment and label](#4-comment-and-label)
- [Differences from the Node plugin](#differences-from-the-node-plugin)
- [What is tested](#what-is-tested)
- [What is not tested](#what-is-not-tested)

## 1. Find the commits

Source: [`src/git.ts`](../src/git.ts). Tests: [`test/git.test.ts`](../test/git.test.ts), which run against real git repositories.

The release is the set of commits reachable from `tag` but not from the previous release tag, listed with `git log <previous>..<tag>`. With `paths`, only commits touching those paths are kept.

PSR reports a `previous_version` output, but it is the highest version tag in the repository, not necessarily an ancestor of the release ([`version.py` L608-L612](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/src/semantic_release/cli/commands/version.py#L608-L612), with a `TODO` saying so). The action finds the previous tag from git history instead:

1. It builds a pattern from `tag` and `version` by replacing the version with `*.*.*`. Tag `v1.4.0` gives `v*.*.*`, and a monorepo tag `pkg-v1.4.0` gives `pkg-v*.*.*`, so only tags of the same package match. Partial tags such as `v1` and `v1.4` don't match.
2. It runs `git describe --tags --abbrev=0 --match <pattern>` on the parent of the tagged commit, which returns the nearest matching tag in the history.
3. For a full release it excludes pre-release tags (`v*.*.*-*`), so `1.4.0` is compared with `1.3.0` and not with `1.4.0-rc.2`. Pull requests announced for a release candidate are announced again for the full release. A pre-release is compared with the nearest tag of either kind.
4. If no tag matches, it is a first release, and every commit up to `tag` is included.

Set `previous-tag` to skip all of this.

The action fails on a shallow clone instead of working from an incomplete history. `actions/checkout` fetches one commit unless `fetch-depth: 0` is set ([README](https://github.com/actions/checkout/blob/f548e57e544e1ff5a4c46bf1e1b8685f8e4a348a/README.md)).

## 2. Find the pull requests

Source: `findPullRequests` in [`src/release.ts`](../src/release.ts). Tests: [`test/release.test.ts`](../test/release.test.ts).

The action asks the GraphQL API for the `associatedPullRequests` of each commit, 100 commits per query, as the Node plugin does ([L79-L118](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L79-L118)).

GitHub can associate a pull request with a commit it merely contains, so each candidate is kept only if its merge commit, or one of its own commits, is in the release. This is the Node plugin's filter ([L120-L141](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L120-L141)). The merge commit comes back with the first query, so the pull request's commit list is only fetched when the merge commit doesn't match.

## 3. Find the closed issues

Source: `closingParser` in [`src/comment.ts`](../src/comment.ts) and `findClosed` in [`src/release.ts`](../src/release.ts). Tests: [`test/comment.test.ts`](../test/comment.test.ts), [`test/release.test.ts`](../test/release.test.ts).

The action reads the descriptions of the pull requests from step 2 and the messages of the commits from step 1, and collects the issues they close with a keyword. It uses [`issue-parser`](https://github.com/pvdlg/issue-parser), the parser the Node plugin uses ([L149-L167](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L149-L167)). The keywords are `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, and `resolved` ([`hosts-config.js`](https://github.com/pvdlg/issue-parser/blob/779423bf2d1d64617bd4fe78b8aecbe39ee2a361/lib/hosts-config.js)).

References to other repositories are dropped. Each remaining number is looked up with `issueOrPullRequest` to learn whether it is an issue or a pull request ([L175-L184](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L175-L184)). A number that doesn't exist is ignored.

Issues linked to a pull request from the sidebar, without a keyword, are not found.

## 4. Comment and label

Source: `notify` in [`src/release.ts`](../src/release.ts) and [`src/github.ts`](../src/github.ts). Tests: [`test/release.test.ts`](../test/release.test.ts), [`test/github.test.ts`](../test/github.test.ts).

Pull requests and issues left out by the [filters](reference.md#filters) are reported as `filtered` and skipped. For each of the others, in number order, the action:

1. Lists the existing comments and looks for this release's [marker](reference.md#the-comment).
2. Posts the comment if the marker isn't there.
3. Adds the labels.

A 403 or 404 skips that pull request or issue, and any other error is reported at the end, as in the Node plugin ([L242-L260](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L242-L260), [L330-L332](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L330-L332)).

Requests follow [GitHub's REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api):

- They run one at a time, with one second after each write.
- A rate-limited response is retried after the time in `retry-after`, or at `x-ratelimit-reset`, or after one minute that doubles on each attempt. A wait longer than five minutes fails instead.
- Reads, and the label request, are retried on network errors and 5xx responses, up to three times. Three is the Node plugin's retry count ([`retry.js`](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/definitions/retry.js)).
- Posting a comment is not retried on a network error or 5xx, because the comment may have been created.

## Differences from the Node plugin

| Topic            | Node plugin                                                                 | This action                                  |
|------------------|-----------------------------------------------------------------------------|----------------------------------------------|
| Release commits  | Supplied by semantic-release                                                | `git log` between two tags                   |
| Re-runs          | Posts again; duplicates are only removed within one run (`uniqBy`, L193)    | Skips anything carrying the release's marker |
| Concurrency      | All pull requests and issues at once (`Promise.all`, L192)                  | One at a time, a second between writes       |
| 404 responses    | Retried (`retry.js` leaves 404 out of `doNotRetry`)                         | Not retried                                  |
| Comment template | Lodash template with the full release context (L205-L207)                   | Four placeholders                            |
| Comment footer   | "Your semantic-release bot" line (`get-success-comment.js` L24)             | None                                         |
| Labels           | `released`, plus `on @<channel>` for channel releases (`resolve-config.js`) | `released`, or the `labels` input            |
| Size guard       | None                                                                        | `max-targets`, 100 by default                |
| Slug matching    | `owner/repo#1` must match exactly (L158-L160)                               | Case-insensitive                             |

`successCommentCondition` (L196-L203) is a Lodash template evaluated against each pull request or issue. This action has the [`targets`, `skip-labels`, and `skip-authors`](reference.md#filters) inputs instead, which evaluate no code.

Not ported: closing "release is failing" issues (L266-L303), and `addReleases` (L305-L328).

## What is tested

- `npm test` runs the suite. git behavior runs against real repositories created in a temporary directory. API behavior runs against a local HTTP server that stands in for GitHub's REST and GraphQL APIs ([`test/helpers.ts`](../test/helpers.ts)).
- The shape of GitHub's GraphQL answers was checked against the live API on 2026-11-10: `associatedPullRequests` with `mergeCommit`, a bot author's login coming back without its `[bot]` suffix (`dependabot`, where REST gives `dependabot[bot]`), and `issueOrPullRequest` returning `null` with a `NOT_FOUND` error for a number that doesn't exist. The test server reproduces both.
- A dry run of the built action against a clone of `python-semantic-release/python-semantic-release` for tag `v10.7.0`, on 2026-11-10, found 24 commits since `v10.6.2`, 15 pull requests, and 2 issues.

## What is not tested

- Posting comments and adding labels against the live GitHub API. Only the test server has received writes.
- A run inside GitHub Actions with `GITHUB_TOKEN`, including which permissions the GraphQL lookups need.
- A real PSR monorepo. Tag matching and `paths` are tested on synthetic repositories only.
- GitHub Enterprise Server.
- Whether PSR's own conversion of a shallow clone (its [docs](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/docs/configuration/automatic-releases/github-actions.rst?plain=1#L971-L977) describe it from v10.5.0) leaves the history this action needs. `fetch-depth: 0` avoids the question.
