# Contributing

Contributions are welcome — bug reports, fixes, new tools, documentation.

## Reporting a bug

Open an [issue](https://github.com/shakaran/symfony-agent-mcp/issues) with what
you ran, what you expected and what happened. If it involves a Symfony project,
the version of Symfony and PHP matters.

**Do not open an issue for a security vulnerability.** See
[SECURITY.md](SECURITY.md) for the private reporting channel.

## Making a change

1. Fork the repository and create a branch off `main`.
2. Make the change, with tests covering it.
3. Run the full gate before pushing (below). CI runs the same checks, so a
   green run locally means a green run there.
4. Open a pull request describing what changed and why.

## The gate

```bash
pnpm install --frozen-lockfile
pnpm run lint          # ESLint, must report 0 errors
pnpm run lint:md       # markdownlint
pnpm run build         # TypeScript, must compile clean
pnpm run test:coverage # Jest
```

`src/utils/` is held at 100% statements, lines and functions, and 90% branches.
A change there that drops coverage fails CI.

## What a change should look like

- **Tests describe behaviour, not implementation.** A test name should say what
  breaks if it fails.
- **Comments explain why, not what.** The code already says what it does.
- **No new dependencies without a reason.** Every one is a supply-chain
  surface; the runtime has three.
- **Tools are read-only.** Nothing in `src/tools/` may execute a command, write
  a file or make a network request. The server parses files and configuration,
  and that guarantee is what makes it safe to point at a production checkout.
- **Every result passes through the sanitiser.** If you add a tool, its output
  goes through the same pipeline as the rest — credentials must never leave.

## Adding a tool

Tools live in `src/tools/`, one module per subject area, each exporting its own
definitions. `src/server.ts` registers the handlers. The two lists are checked
against each other by `tool-registry-integrity` — a tool that is advertised
without a handler fails the suite, which is how three broken tools in 1.0.0
were caught.

New tools are categorised in `src/utils/tool-categories.ts` so progressive
discovery can find them.

## Commit messages

A short imperative subject, then a body explaining why the change is needed.
The subject line is what someone reads in `git log` two years from now.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence, the same as the rest of the project.
