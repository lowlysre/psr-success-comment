import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fc from 'fast-check'
import { closingParser, marker, renderComment, type CommentContext } from '../src/comment.ts'

const context = (over: Partial<CommentContext> = {}): CommentContext => ({
  kind: 'pr',
  version: '1.2.3',
  tag: 'v1.2.3',
  releaseUrl: 'https://github.com/acme/widgets/releases/tag/v1.2.3',
  ...over
})

describe('marker', () => {
  it('is a hidden HTML comment naming the tag', () => {
    assert.equal(marker('v1.2.3'), '<!-- psr-success-comment tag=v1.2.3 -->')
  })

  it('never lets the tag end the HTML comment early or collide with another tag', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        const inner = marker(a).slice('<!-- psr-success-comment tag='.length, -' -->'.length)
        assert.doesNotMatch(inner, /--|>|\s/)
        assert.equal(marker(a) === marker(b), a === b)
      })
    )
  })
})

describe('renderComment', () => {
  it('uses the built-in wording for a pull request, with the release link', () => {
    assert.equal(
      renderComment('', context()),
      ':tada: This PR is included in version 1.2.3 :tada:\n\n' +
        'The release is available on [v1.2.3](https://github.com/acme/widgets/releases/tag/v1.2.3)\n\n' +
        '<!-- psr-success-comment tag=v1.2.3 -->'
    )
  })

  it('uses the built-in wording for an issue, without a link when there is no release URL', () => {
    assert.equal(
      renderComment('  \n', context({ kind: 'issue', releaseUrl: '' })),
      ':tada: This issue has been resolved in version 1.2.3 :tada:\n\n<!-- psr-success-comment tag=v1.2.3 -->'
    )
  })

  it('fills a template and leaves unknown placeholders alone', () => {
    const template = 'Shipped this {type} in {version} ({tag}): {url} {other} {version}\n'
    assert.equal(
      renderComment(template, context({ kind: 'issue' })),
      'Shipped this issue in 1.2.3 (v1.2.3): https://github.com/acme/widgets/releases/tag/v1.2.3 {other} 1.2.3\n\n<!-- psr-success-comment tag=v1.2.3 -->'
    )
    assert.match(renderComment('{type}', context()), /^pull request\n/)
  })

  it('always ends with the marker for its tag, whatever the template', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (template, tag) => {
        assert.ok(renderComment(template, context({ tag })).endsWith(`\n\n${marker(tag)}`))
      })
    )
  })
})

describe('closingParser', () => {
  const parse = closingParser('acme', 'widgets', 'https://github.com')

  it('finds closing keywords and ignores plain mentions', () => {
    assert.deepEqual(parse('fix: thing\n\nFixes #12, closes #13 and resolved #14. See #15.'), [12, 13, 14])
  })

  it('keeps references to this repository and drops other repositories', () => {
    assert.deepEqual(parse('Closes Acme/Widgets#5, fixes other/repo#6'), [5])
    assert.deepEqual(parse('Fixes https://github.com/acme/widgets/issues/7 and fixes https://github.com/other/repo/issues/8'), [7])
  })

  it('drops numbers that do not fit a GraphQL Int', () => {
    assert.deepEqual(parse('Fixes #0, fixes #2147483647, fixes #2147483648, fixes #99999999999999999999'), [2147483647])
  })

  it('reads issue URLs on a GitHub Enterprise Server host', () => {
    const ghes = closingParser('acme', 'widgets', 'https://ghe.example.com')
    assert.deepEqual(ghes('Fixes https://ghe.example.com/acme/widgets/issues/9'), [9])
    assert.deepEqual(parse('Fixes https://ghe.example.com/acme/widgets/issues/9'), [])
  })

  it('returns only valid issue numbers for any text', () => {
    fc.assert(
      fc.property(fc.string(), text => {
        for (const number of parse(text)) assert.ok(Number.isInteger(number) && number > 0 && number <= 2 ** 31 - 1)
      })
    )
  })
})
