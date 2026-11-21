# AGENTS.md

`CONTRIBUTING.md` is the source of truth for this repository. Read it before
changing code or git history.

## Merging a pull request

Use a merge commit. Never squash, never rebase:

    gh pr merge <n> --merge --delete-branch

`main` keeps the PR's own commits and the branch it came from. Do not infer the
method from what older commits on `main` look like — a few landed squashed by
mistake. The rule is written down in `CONTRIBUTING.md` (§ Pull requests).

## Before merging

- Every required check is green and the PR is `MERGEABLE`.
- The PR title and description describe the diff that is actually in the branch.
