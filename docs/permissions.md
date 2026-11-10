# Permissions

The action uses the job's `GITHUB_TOKEN` unless `token` is set.

- [Job permissions](#job-permissions)
- [What each request needs](#what-each-request-needs)
- [Using another token](#using-another-token)
- [Why the action runs in the release job](#why-the-action-runs-in-the-release-job)
- [Troubleshooting](#troubleshooting)

## Job permissions

```yaml
permissions:
  contents: write # for python-semantic-release, which pushes the tag and creates the release
  issues: write
  pull-requests: write
```

The action reads no repository contents through the API. `contents: write` is for the PSR step in the same job.

## What each request needs

GitHub's REST reference lists the permissions for each endpoint the action calls:

| Request                                                                                                                            | Permission, as documented               |
|------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------|
| [List issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#list-issue-comments)                   | Issues (read) or Pull requests (read)   |
| [Create an issue comment](https://docs.github.com/en/rest/issues/comments?apiVersion=2022-11-28#create-an-issue-comment)           | Issues (write) or Pull requests (write) |
| [Add labels to an issue](https://docs.github.com/en/rest/issues/labels?apiVersion=2022-11-28#add-labels-to-an-issue)               | Issues (write) or Pull requests (write) |
| [List commits on a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-commits-on-a-pull-request) | Pull requests (read)                    |

The reference requires at least one of the two write permissions for comments and labels. It doesn't say whether `issues: write` alone covers a pull request, or `pull-requests: write` alone an issue. Grant both.

The GraphQL lookups (`associatedPullRequests`, `issueOrPullRequest`) have no documented permission list.

## Using another token

Pass a GitHub App installation token or a personal access token as `token` to comment as that identity. It needs the permissions above.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    token: ${{ secrets.RELEASE_BOT_TOKEN }}
```

## Why the action runs in the release job

A separate workflow triggered by the release never starts with the default token: events caused by `GITHUB_TOKEN` [don't trigger new workflow runs](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs). Running right after the PSR step also leaves the tag in the checkout.

## Troubleshooting

- `Tag '<tag>' was not found in the checkout`: run the action after the PSR step in the same job.
- `The checkout is a shallow clone`: set `fetch-depth: 0` on `actions/checkout`.
- `forbidden` on every pull request and issue: the token lacks `issues: write` or `pull-requests: write`. The warning annotation carries GitHub's message.
- `returned 401: Bad credentials`: the `token` input is empty, expired, or revoked.
- `Found <n> pull requests and issues, more than 'max-targets'`: see [announce a large or first release](recipes.md#announce-a-large-or-first-release).
