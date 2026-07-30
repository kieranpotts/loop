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
