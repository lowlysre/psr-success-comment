# How it works

Links to other projects are pinned to a commit.

- Node plugin: [`@semantic-release/github` at `30e351e`](https://github.com/semantic-release/github/tree/30e351e9378ca93c88d064ad047bb102019f8993). A bare `L123` below means that line of [`lib/success.js`](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js).
- PSR: [python-semantic-release at `60de8fc`](https://github.com/python-semantic-release/python-semantic-release/tree/60de8fcacea7fd5177f34368490677be5f098995).

- [1. Find the commits](#1-find-the-commits)
- [2. Find the pull requests](#2-find-the-pull-requests)
- [3. Find the closed issues](#3-find-the-closed-issues)
- [4. Comment and label](#4-comment-and-label)
- [Differences from the Node plugin](#differences-from-the-node-plugin)

## 1. Find the commits

Code: [`src/git.ts`](../src/git.ts). Tests: [`test/git.test.ts`](../test/git.test.ts), against real git repositories.

The release is the commits reachable from `tag` but not from the previous release tag (`git log <previous>..<tag>`). With `paths`, only commits touching those paths count.

PSR's `previous_version` output is the highest version tag in the repository, not necessarily an ancestor of the release ([`version.py` L608-L612](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/src/semantic_release/cli/commands/version.py#L608-L612), marked `TODO`). The previous tag is found from git history instead:

1. The version in `tag` becomes `*.*.*`: `v1.4.0` gives `v*.*.*`, and `pkg-v1.4.0` gives `pkg-v*.*.*`. Partial tags such as `v1` and `v1.4` don't match.
2. `git describe --tags --abbrev=0 --match <pattern>` on the tagged commit's parent returns the nearest match.
3. A match is skipped when the part where the version should be isn't a complete SemVer version, so `vlib-9.0.0` doesn't count as a `v*.*.*` tag. A `version` that isn't SemVer turns this check off.
4. For a full release, pre-release tags are skipped, so `1.4.0` compares with `1.3.0`, not `1.4.0-rc.2`. A tag is a pre-release when its version has a hyphen right after the patch number, so `1.3.0+build-5` is a full release. A pre-release compares with the nearest tag of either kind.
5. With no match, it is a first release and every commit up to `tag` counts.

`previous-tag` skips this search.

A shallow clone fails the step. `actions/checkout` fetches one commit unless `fetch-depth: 0` is set ([README](https://github.com/actions/checkout/blob/f548e57e544e1ff5a4c46bf1e1b8685f8e4a348a/README.md)).

## 2. Find the pull requests

Code: `findPullRequests` in [`src/release.ts`](../src/release.ts). Tests: [`test/release.test.ts`](../test/release.test.ts).

GraphQL returns the `associatedPullRequests` of each commit, 100 commits per query, as in the Node plugin ([L79-L118](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L79-L118)).

GitHub also associates a pull request with commits it merely contains. A candidate stays only if its merge commit, or one of its own commits, is in the release, as in the Node plugin ([L120-L141](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L120-L141)). The merge commit arrives with the first query, so a pull request's commit list is fetched only when the merge commit doesn't match.

GitHub rejects a query that could return more than [500,000 nodes](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#node-limit). A query asks for 100 commits, 40 pull requests per commit and page, and 100 labels per pull request: about 404,000 nodes. The Node plugin reads 40 labels ([L382](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L382)), so 100 pull requests fit there. `skip-labels` needs more labels.

## 3. Find the closed issues

Code: `closingParser` in [`src/comment.ts`](../src/comment.ts), `findClosed` in [`src/release.ts`](../src/release.ts). Tests: [`test/comment.test.ts`](../test/comment.test.ts), [`test/release.test.ts`](../test/release.test.ts).

[`issue-parser`](https://github.com/pvdlg/issue-parser), the Node plugin's parser ([L149-L167](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L149-L167)), reads closing keywords in the pull request descriptions from step 2 and the commit messages from step 1. The keywords are `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, and `resolved` ([`hosts-config.js`](https://github.com/pvdlg/issue-parser/blob/779423bf2d1d64617bd4fe78b8aecbe39ee2a361/lib/hosts-config.js)).

References to other repositories are dropped. `issueOrPullRequest` tells issues from pull requests ([L175-L184](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L175-L184)), and a number that doesn't exist is ignored.

An issue linked from a pull request's sidebar, without a keyword, isn't found.

## 4. Comment and label

Code: `notify` in [`src/release.ts`](../src/release.ts), [`src/github.ts`](../src/github.ts). Tests: [`test/release.test.ts`](../test/release.test.ts), [`test/github.test.ts`](../test/github.test.ts).

[Filtered](reference.md#filters) pull requests and issues are reported as `filtered` and skipped. For each other one, in number order:

1. List its comments and look for this release's [marker](reference.md#the-comment).
2. Post the comment if the marker is missing.
3. Add the labels.

A 403 or 404 skips the target. Any other error is reported at the end ([L242-L260](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L242-L260), [L330-L332](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/success.js#L330-L332)).

Requests follow [GitHub's REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api):

- One request at a time, one second after each write.
- A rate-limited response waits for `retry-after`, else until `x-ratelimit-reset`, else a minute that doubles per attempt. A wait over five minutes fails.
- GraphQL reports a rate limit as HTTP 200 with an error ([docs](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit)) and waits the same way.
- Reads and the label request retry up to three times on network errors and 5xx, the Node plugin's count ([`retry.js`](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/definitions/retry.js)).
- Posting a comment is never retried on a network error or 5xx, because the comment may exist.

## Differences from the Node plugin

| Topic            | Node plugin                                                                 | This action                                  |
|------------------|-----------------------------------------------------------------------------|----------------------------------------------|
| Release commits  | Supplied by semantic-release                                                | `git log` between two tags                   |
| Re-runs          | Posts again; `uniqBy` dedupes within one run (L193)                         | Skips anything carrying the release's marker |
| Concurrency      | All targets at once (`Promise.all`, L192)                                   | One at a time, a second between writes       |
| 404 responses    | Retried (`retry.js` leaves 404 out of `doNotRetry`)                         | Not retried                                  |
| Comment template | Lodash template with the full release context (L205-L207)                   | Four placeholders                            |
| Comment footer   | "Your semantic-release bot" line (`get-success-comment.js` L24)             | None                                         |
| Labels           | `released`, plus `on @<channel>` for channel releases (`resolve-config.js`) | `released`, or the `labels` input            |
| Size guard       | None                                                                        | `max-targets`, 100 by default                |
| Slug matching    | `owner/repo#1` matches exactly (L158-L160)                                  | Case-insensitive                             |

`successCommentCondition` (L196-L203) evaluates a Lodash template per target. [`targets`, `skip-labels`, and `skip-authors`](reference.md#filters) replace it and evaluate no code.

Not ported: closing "release is failing" issues (L266-L303) and `addReleases` (L305-L328).
