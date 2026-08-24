# Roadmap

What the project intends to do next, and what it deliberately will not do.
Dated 2026-08-24; revised when a release changes the picture.

## Now

**Coverage of `src/tools/`.** The 820 tool modules have no tests, which puts
overall statement coverage at 2.8% while `src/utils/` sits at 100% and the HTTP
transport at 99.5%. The security-critical layer is covered; the breadth is not.
The plan is not to chase a percentage but to cover, per subject area, the
parsing each tool does — the regular expressions in particular, which is where
every ReDoS defect so far has come from.

**A second maintainer.** Several things the project cannot honestly claim —
peer review of changes, a bus factor above one, independent security review —
are blocked on there being one person. This is the highest-value change
available and does not depend on writing more code.

## Next

- Cover the remaining branches in `src/utils/` (currently 91%).
- Extend property-based testing beyond the validators to the tool parsers.
- Evaluate whether the optional HTTP transport should stay. It is far more
  attack surface than stdio, and no reported use so far needs it.

## Not planned

- **Write access of any kind.** No tool will execute a command, modify a file
  or make a network request. This is the guarantee that makes it safe to point
  the server at a production checkout, and it is not negotiable for a feature.
- **Bundling a Symfony runtime.** The server parses source and configuration;
  it does not boot the application.
- **Telemetry.** Nothing is reported anywhere.

## How this is decided

See [GOVERNANCE.md](GOVERNANCE.md). Proposals belong in an
[issue](https://github.com/shakaran/symfony-agent-mcp/issues).
