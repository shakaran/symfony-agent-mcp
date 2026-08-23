# Support

## Getting help

- **Questions and bugs** — open an
  [issue](https://github.com/shakaran/symfony-agent-mcp/issues).
- **Security vulnerabilities** — do not open an issue. See
  [SECURITY.md](SECURITY.md) for the private reporting channel.

## What is supported

**Only the latest released version.** This is a single-maintainer project and
backporting to older lines is not sustainable. Fixes, including security
fixes, are released as a new version on top of `main`.

| Version             | Supported                  |
|---------------------|----------------------------|
| Latest `1.0.x`      | Yes                        |
| Any earlier version | No — upgrade to the latest |

Because the project follows semantic versioning, upgrading within `1.x` does
not break the tool interface.

## End of life

A major version stops receiving fixes when its successor is released. There is
no overlapping support window: when `2.0.0` ships, `1.x` receives nothing
further, and that will be stated in the release notes and the README at the
time.

Should the project stop being maintained altogether, the README will say so
explicitly and the npm package will be marked deprecated. Users will not be
left to guess from the date of the last commit.

## Runtime requirements

Node.js 22 or later. Older versions are not tested and not supported.

## Verifying what you install

See [SECURITY.md](SECURITY.md), section "Verifying a release", for how to check
that a published package came from this repository.
