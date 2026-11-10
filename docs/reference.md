# Reference

- [Inputs](#inputs)
- [Outputs](#outputs)
- [Results](#results)
- [The comment](#the-comment)
- [Logs, annotations, and failures](#logs-annotations-and-failures)

## Inputs

| Input          | Required | Default               | Description                                                                                               |
|----------------|----------|-----------------------|-----------------------------------------------------------------------------------------------------------|
| `tag`          | yes      |                       | Git tag of the release. Pass PSR's `tag` output. The tag must exist in the checkout.                      |
| `version`      | yes      |                       | Version of the release. Pass PSR's `version` output.                                                      |
| `release-url`  | no       |                       | URL of the release, linked from the comment and the job summary. Pass PSR's `link` output.                |
| `previous-tag` | no       | derived               | Tag of the previous release. See [how the previous release is found](how-it-works.md#1-find-the-commits). |
| `paths`        | no       |                       | Paths, one per line. Only commits that touch them count as part of the release.                           |
| `comment`      | no       | built in              | Comment template. See [the comment](#the-comment).                                                        |
| `labels`       | no       | `released`            | Labels to add, one per line. An empty string adds none.                                                   |
| `max-targets`  | no       | `100`                 | Fail, without writing, when more pull requests and issues than this are found. `0` means no limit.        |
| `dry-run`      | no       | `false`               | Find and report the pull requests and issues without commenting or labeling.                              |
| `summary`      | no       | `true`                | Write the results to the job summary page.                                                                |
| `token`        | no       | `${{ github.token }}` | Token used to read pull requests and to comment and label. See [permissions](permissions.md).             |

`tag`, `version`, and `link` are outputs of the PSR action, declared in its [`action.yml`](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/action.yml#L124-L158).

`paths` entries are passed to `git log` as pathspecs (see "pathspec" in the [git glossary](https://git-scm.com/docs/gitglossary)), relative to `GITHUB_WORKSPACE`.

The action reads the repository from `GITHUB_REPOSITORY` and the API addresses from `GITHUB_API_URL` and `GITHUB_GRAPHQL_URL`, which the runner sets. It runs git in `GITHUB_WORKSPACE`, so the repository must be checked out there.

## Outputs

| Output          | Description                                                                 |
|-----------------|-----------------------------------------------------------------------------|
| `previous-tag`  | Tag the release was compared with. Empty on a first release.                |
| `commits`       | Number of commits in the release.                                           |
| `pull-requests` | JSON array of the pull request numbers found.                               |
| `issues`        | JSON array of the issue numbers found.                                      |
| `commented`     | JSON array of the numbers that received a comment in this run.              |
| `skipped`       | JSON array of the numbers skipped: already commented, forbidden, not found. |
| `failed`        | JSON array of the numbers that could not be updated.                        |
| `json`          | JSON array with one object per pull request and issue.                      |

Each object in `json` has `number`, `kind` (`pr` or `issue`), `url`, `status`, and, when something went wrong, `detail` with the error message. Read it with `fromJSON`.

No outputs are set when the step fails before it has results, for example when `max-targets` is exceeded or the tag is missing.

## Results

Every pull request and issue ends with one `status`.

| Status              | Meaning                                                                                 | Step fails |
|---------------------|-----------------------------------------------------------------------------------------|------------|
| `commented`         | The comment was posted, and labels were added.                                          | no         |
| `already-commented` | This release's comment was already there. Labels were still added.                      | no         |
| `would-comment`     | Dry run: a real run would comment.                                                      | no         |
| `forbidden`         | GitHub answered 403 for this pull request or issue. Logged as a warning.                | no         |
| `not-found`         | GitHub answered 404. Logged as a warning.                                               | no         |
| `failed`            | Any other error, including a rate limit that outlasted the retries. Logged as an error. | yes        |

A failure on one pull request or issue doesn't stop the others. The step fails at the end, after the outputs and the summary are written. Running the step again is safe: anything that already has the comment is reported as `already-commented`.

If a comment is posted and adding labels then fails, the status describes the label failure. The next run finds the comment and only adds the labels.

## The comment

The built-in comment follows the wording of [`@semantic-release/github`](https://github.com/semantic-release/github/blob/30e351e9378ca93c88d064ad047bb102019f8993/lib/get-success-comment.js#L9-L25):

```markdown
:tada: This PR is included in version 1.4.0 :tada:

The release is available on [v1.4.0](https://github.com/acme/widgets/releases/tag/v1.4.0)
```

An issue gets "This issue has been resolved in version 1.4.0" instead. The second paragraph is left out when `release-url` is empty.

Set `comment` to use your own text. These placeholders are replaced, and anything else is left as written:

| Placeholder | Value                                    |
|-------------|------------------------------------------|
| `{version}` | The `version` input.                     |
| `{tag}`     | The `tag` input.                         |
| `{url}`     | The `release-url` input, possibly empty. |
| `{type}`    | `pull request` or `issue`.               |

Every comment ends with a hidden HTML comment, `<!-- psr-success-comment tag=v1.4.0 -->`. It is how a later run recognizes that the release was already announced, so a comment without it, or with a different tag, doesn't count.

## Logs, annotations, and failures

The log lists each pull request and issue with a colored dot for its status. The job summary shows the same list as a table with colored circles, because it doesn't render ANSI colors.

| Color  | Statuses                 |
|--------|--------------------------|
| Green  | `commented`              |
| Gray   | `already-commented`      |
| Blue   | `would-comment`          |
| Yellow | `forbidden`, `not-found` |
| Red    | `failed`                 |

The step fails with an error annotation when:

| Cause                                         | Message                                                                                         |
|-----------------------------------------------|-------------------------------------------------------------------------------------------------|
| A required input is missing                   | `Input required and not supplied: <name>`                                                       |
| `max-targets` isn't a whole number            | `Invalid 'max-targets' '<value>': ...`                                                          |
| The checkout is shallow                       | `The checkout is a shallow clone, so the release's commits can't be listed. ...`                |
| `tag` or `previous-tag` isn't in the checkout | `Tag '<tag>' was not found in the checkout. ...`                                                |
| `tag` doesn't contain `version`               | `Tag '<tag>' does not contain version '<version>', so the previous tag can't be derived. ...`   |
| Too many pull requests and issues             | `Found <n> pull requests and issues, more than 'max-targets' (<max>). Nothing was changed. ...` |
| A pull request or issue couldn't be updated   | `Failed to update #<n>, #<m>. Re-running is safe: existing comments are not repeated.`          |
| The GitHub API rejected a lookup              | `<METHOD> <path> returned <status>: <message>` or `GraphQL query failed: <message>`             |
| git failed                                    | `git <command> failed: <stderr>`                                                                |
