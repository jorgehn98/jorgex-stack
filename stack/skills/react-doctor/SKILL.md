---
name: react-doctor
description: Run after making React changes to catch issues early. Use when reviewing code, finishing a feature, or fixing bugs in a React project.
version: 1.0.0
---

# React Doctor

Scans your React codebase for security, performance, correctness, and architecture issues. Outputs a 0-100 score with actionable diagnostics.

## Usage

Run the project-pinned binary through the project's package manager:

```bash
pnpm exec react-doctor . --verbose --diff
```

`pnpm exec` resolves the binary from the current project's declared
dependencies or workspace. It does not fetch an ad-hoc release and this skill
does not modify `package.json`, the lockfile, or any global tool directory.

If the command is unavailable, stop and return control to the user with a
clear message that the project dependency is missing. The user can review and
provision an exact project version through the normal dependency workflow,
then rerun this skill.

## Workflow

Run after making changes to catch issues early. Fix errors first, then re-run to verify the score improved.
