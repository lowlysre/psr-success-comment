# Recipes

Each recipe assumes the PSR step has `id: release` and the job has the [permissions](permissions.md) the action needs. `@v1` is a placeholder: pin to a full commit SHA, with the release tag in a comment.

- [Preview a release without commenting](#preview-a-release-without-commenting)
- [Write your own comment](#write-your-own-comment)
- [Label pre-releases differently](#label-pre-releases-differently)
- [Comment without labeling](#comment-without-labeling)
- [Leave some pull requests and issues alone](#leave-some-pull-requests-and-issues-alone)
- [Release packages from a monorepo](#release-packages-from-a-monorepo)
- [Use the results in later steps](#use-the-results-in-later-steps)
- [Announce a large or first release](#announce-a-large-or-first-release)

## Preview a release without commenting

`dry-run` does every lookup and reports what a real run would do, in the log, summary, and outputs. It makes read requests only.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    dry-run: true
```

A real run would comment on each `would-comment` result.

## Write your own comment

`comment` replaces the built-in text. `{version}`, `{tag}`, `{url}`, and `{type}` are filled in, and the rest is posted as written, Markdown included.

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

PSR's `is_prerelease` output is `"true"` for a pre-release.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    labels: ${{ steps.release.outputs.is_prerelease == 'true' && 'pre-released' || 'released' }}
```

A pull request that ships in `1.4.0-rc.1` and again in `1.4.0` is commented on for both and ends up with both labels ([how the previous release is found](how-it-works.md#1-find-the-commits)).

## Comment without labeling

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    labels: ''
```

## Leave some pull requests and issues alone

Skip dependency updates and similar with `skip-authors` and `skip-labels`, or limit the action to one kind with `targets`.

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    targets: issues
    skip-authors: |
      dependabot[bot]
      renovate[bot]
    skip-labels: |
      skip-release-comment
      internal
```

With `targets: issues`, a pull request gets no comment, but an issue it closes with `Fixes #12` still does. [Filters](reference.md#filters) shows how filtered items are reported.

## Release packages from a monorepo

Run the action once per package, after that package's PSR step.

- The previous release is the nearest tag with the same format. With `tag_format = "pkg1-v{version}"`, `pkg1-v1.4.0` compares with the last `pkg1-v*.*.*` tag and ignores `pkg2-v*`.
- `paths` limits the release to commits touching the package. Without it, every commit since the package's last release counts, including ones that changed only other packages.

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

A pull request touching two packages is commented on once per package release, because each release has its own marker.

List in `paths` what PSR counts as the package: PSR scopes commits with [`path_filters`](https://github.com/python-semantic-release/python-semantic-release/blob/60de8fcacea7fd5177f34368490677be5f098995/docs/configuration/configuration-guides/monorepos.rst?plain=1#L79-L111), and the action doesn't read PSR's configuration. Tag matching and `paths` have run only on synthetic repositories.

## Use the results in later steps

The outputs are JSON arrays. Read them with `fromJSON`.

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

Set `summary: false` when the step runs several times in one job, such as once per package.

## Announce a large or first release

A first release has no previous tag, so every commit in the history counts: on an established repository, a comment on every pull request ever merged. `max-targets` stops that. Above 100 pull requests and issues, the step fails before writing anything.

To skip the history, tag the commit where announcements should start and pass that tag as `previous-tag`. To announce everything, raise the limit, or set `0` for none:

```yaml
- uses: lowlysre/psr-success-comment@v1
  if: steps.release.outputs.released == 'true'
  with:
    tag: ${{ steps.release.outputs.tag }}
    version: ${{ steps.release.outputs.version }}
    max-targets: 500
```

Writes are one second apart, so 500 targets take at least eight minutes, twice that with labels.
