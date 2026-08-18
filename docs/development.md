# Development

## Pre-commit hooks

It is RECOMMENDED to install the [pre-commit](https://pre-commit.com) framework to enable local validation hooks before committing. You need only to run the following command once to install pre-commit system-wide:

```bash
pipx install pre-commit
```

Then install the pre-commit hooks in every local repository where you want pre-commit checks to be run:

```bash
pre-commit install
```

This installs all hook types declared in `.pre-commit-config.yaml` (`pre-commit`, `commit-msg`).

Edit `./.pre-commit-config.yaml` to configure the pre-commit validation checks you want for your project. See the [pre-commit documentation](https://pre-commit.com) for details.

## Repository settings

This repository's GitHub configuration is defined as code in
`.github/settings.yml`. The configuration is applied by the "Apply Settings"
workflow on pushes to the default branch.

### Setting up the admin token

The workflow needs a token with admin-level access. GitHub's built-in
`GITHUB_TOKEN` is not adequate because it has no `Administration` scope, so
it cannot change repository settings.

1.  Create a fine-grained personal access token in a GitHub account associated
    with a code owner of this repository. Set the following scopes:

    - **Administration**: write

    - **Contents**: read

    - Write access to whichever sections are defined in `settings.yml`, eg.
      **Issues** (for labels, milestones), **Environments**, **Pages**,
      **Actions**, **Actions variables**, **Repository hooks**,
      **Secrets**, **Dependabot secrets**, **Codespaces secrets**,
      **Repository custom properties**, **Secret scanning alerts**. Grant
      only what the file actually uses.

2.  Add it as a repository secret named `ADMIN_TOKEN`.

3.  Trigger the workflow and confirm it applies cleanly.

Until the secret exists, the workflow runs and fails loudly.
