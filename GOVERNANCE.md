# Governance

## Project members and access

| Member                                                        | Role              | Access to sensitive resources                                                 |
|---------------------------------------------------------------|-------------------|-------------------------------------------------------------------------------|
| [@shakaran](https://github.com/shakaran) (Ángel Guzmán Maeso) | Maintainer, owner | Repository admin, GitHub Actions secrets, npm publish rights, release signing |

This is a single-maintainer project. There are no other collaborators, and no
account other than the one above has write access to the repository, the CI
secrets, or the npm package.

## Roles and responsibilities

**Maintainer** — reviews and merges contributions, cuts releases, holds the
credentials used to publish, responds to vulnerability reports within the
timeframe stated in [SECURITY.md](SECURITY.md), and decides the direction of
the project.

**Contributor** — anyone opening an issue or a pull request. Contributors need
no special access: pull requests run the full CI gate from a fork, where
repository secrets are not available.

## Granting escalated permissions

Write access is not granted on request. Before anyone is added as a
collaborator with permissions beyond the default:

1. They must have a track record of merged contributions to this project.
2. The maintainer reviews their public activity and the contributions
   themselves, not just their volume.
3. Access is granted at the lowest level that lets them do the work — `triage`
   or `write`, never `admin` — and is raised only if the work requires it.
4. Access is reviewed when someone stops contributing, and removed rather than
   left dormant.

Any account with write access must have two-factor authentication enabled, as
GitHub requires for this repository.

## Decision making

The maintainer decides. Disagreements are worked out in the issue or pull
request where they arise, in public.

## Succession

If the project is no longer maintained, that will be stated in the README
rather than left for users to infer from commit dates. See
[SUPPORT.md](SUPPORT.md) for what support means while it is active.
