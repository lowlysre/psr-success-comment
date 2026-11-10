# Recipes

Each recipe assumes the PSR step has `id: release` and the job has the [permissions](permissions.md) the action needs. The examples use `@v1` as a placeholder because this action has no release yet. Once it does, pin it to a full commit SHA with the release tag in a comment.

- [Preview a release without commenting](#preview-a-release-without-commenting)
- [Write your own comment](#write-your-own-comment)
- [Label pre-releases differently](#label-pre-releases-differently)
- [Comment without labeling](#comment-without-labeling)
- [Release packages from a monorepo](#release-packages-from-a-monorepo)
- [Use the results in later steps](#use-the-results-in-later-steps)
- [Announce a large or first release](#announce-a-large-or-first-release)

## Preview a release without commenting

`dry-run` does every lookup and reports what a real run would do, in the log, the job summary, and the outputs. It only makes read requests.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    dry-run: true
```

Pull requests and issues that a real run would comment on have the status `would-comment`.

## Write your own comment

`comment` replaces the built-in text. `{version}`, `{tag}`, `{url}`, and `{type}` are filled in, and the text is otherwise posted as written, so Markdown works.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    release-url: ${{ steps.release.outputs.link }}
    comment: |
      This {type} shipped in [{version}]({url}).

      Install it with `pip install --upgrade widgets=={version}`.
```

## Label pre-releases differently

PSR's `is_prerelease` output is `"true"` for a pre-release. Use it to pick the label.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    labels: ${{ steps.release.outputs.is_prerelease == 'true' && 'pre-released' || 'released' }}
```

A pull request that ships in `1.4.0-rc.1` and then in `1.4.0` is commented on for both, and ends up with both labels. See [how the previous release is found](how-it-works.md#1-find-the-commits).

## Comment without labeling

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    labels: ''
```

## Release packages from a monorepo

Run the action once per package, after that package's PSR step. Two things keep each package's announcements separate:

- The previous release is found among tags with the same format as `tag`. With PSR's `tag_format` set to `pkg1-v{version}`, tag `pkg1-v1.4.0` is compared with the last `pkg1-v*.*.*` tag, and `pkg2-v*` tags are ignored.
- `paths` limits the release to commits that touch the package. Without it, every commit since the package's last release counts, including commits that only changed other packages.

```yaml
- id: release-pkg1
  uses: python-semantic-release/python-semantic-release@v10
  with:
    directory: packages/pkg1
    github_token: ${{ secrets.GITHUB_TOKEN }}

- uses: lowlysre/psr-success-comment@v1
  if: steps.release-pkg1.outputs.released == 'true'
  with:
    tag: ${{ steps.release-pkg1.outputs.tag }}
    version: ${{ steps.release-pkg1.outputs.version }}
    release-url: ${{ steps.release-pkg1.outputs.link }}
    paths: packages/pkg1
    labels: released pkg1
```

A pull request that touches two packages is commented on once for each package's release, because each release has its own marker.

`paths` should match what PSR counts as the package. PSR's monorepo guide scopes commits with [`path_filters`](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/docs/configuration/configuration-guides/monorepos.rst?plain=1#L79-L111). The action doesn't read PSR's configuration, so list the same paths here, one per line. This setup is tested on synthetic repositories, not on a real PSR monorepo.

## Use the results in later steps

The outputs are JSON arrays, so `fromJSON` turns them into values an expression can use.

```yaml
- id: announce
  uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}

- name: Report
  if: steps.release.outputs.released == 'true'
  env:
    COMMENTED: ${{ steps.announce.outputs.commented }}
    SKIPPED: ${{ steps.announce.outputs.skipped }}
  run: echo "Commented on $COMMENTED, skipped $SKIPPED"
```

Set `summary: false` when the step runs several times in one job, for example once per package, and the job summary would otherwise fill with tables.

## Announce a large or first release

A first release has no previous tag, so every commit in the history is part of it. On an established repository that can mean a comment on every pull request ever merged. `max-targets` stops that: when more than 100 pull requests and issues are found, the step fails before writing anything.

To leave the history out, tag the commit where announcements should start, with any name, and pass that tag as `previous-tag`. To announce everything, raise the limit, or set it to `0` for no limit:

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    max-targets: 500
```

Comments are posted about one second apart, so 500 pull requests and issues take at least eight minutes, or twice that with labels.
