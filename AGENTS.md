# [Project Name]

A short paragraph describing what this project does, who it is for, and any
constraints that materially affect how AI agents should approach changes to it.

The capitalized words REQUIRED, MUST, MUST NOT, RECOMMENDED, SHOULD,
SHOULD NOT, OPTIONAL, and MAY are to be interpreted as described in
[IETF RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Tech stack

- Language and runtime versions.
- Major frameworks and libraries.

## Project structure

- `src/`. Application source.

- `tests/`. Automated tests (unit, integration, system).

- `run/`. Dev tools (Bash scripts).

- `docs/`. Developer/maintainer docs, including architectural decision
  records.

- `skills/`. On-demand context for agents.

## Tools

- `command` to build production-grade artifacts.

- `command` for linting.

- `command` for testing.

## Documentation

- **Audit reports.** \
  ./docs/audits/ (mono-repo)
  https://github.com/kieranpotts/audits (multi-repo)

- **Design docs.** \
  ./docs/design/ (mono-repo)
  https://github.com/kieranpotts/design (multi-repo)

## Rules

- MUST NOT do this.

- SHOULD do this.

- MAY do this.

## Skills

- `./skills/release/SKILL.md`. \
  Checklist for cutting a release.

- `./skills/migration/SKILL.md`. \
  Guidance for writing database migrations.

- `../skills/code-review/SKILL.md`. \
  Generic code review checklist.

- <https://example.com/standards/api-design/tree/main/SKILL.md>. \
  API design conventions.

## References

The following technical standards (TS) govern this project. Fetch and ingest
the relevant standards as-and-when required for the task at hand.

- [**TS-9: Version Control**](https://kieranpotts.com/standards/009) \
  Use when working with Git. Covers commits, branching, merging, integration
  strategies, cutting releases, and configuring Git/PR/CI tooling.

- [**TS-25: Technical Documentation**](https://kieranpotts.com/standards/025) \
  Use when deciding what documentation a project needs, where it should live,
  who it's for, or whether it's still trustworthy.

- [**TS-26: Technical Writing Style Guide**](https://kieranpotts.com/standards/026) \
  Use when writing or editing the prose of a technical document. Covers
  tone-of-voice, headings, terminology, lists, and citations.

- [**TS-61: AI Tools**](https://kieranpotts.com/standards/061) \
  Use when planning or executing coding tasks, managing your own context,
  authoring AGENTS.md files or agent skills, calling tools, or handling
  untrusted content.
