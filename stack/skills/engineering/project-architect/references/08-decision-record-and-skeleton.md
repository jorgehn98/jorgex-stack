# 08 — Decision record and skeleton

Deliverable of the skill, and it always applies, even in its smallest form: for a landing page, a brief, a record of stack and hosting, and the list of skipped phases. Phases 01-07 produce decisions; this phase writes them in one place so that Visual Director, `landing-launch` and any implementing agent can read them later. The minimal skeleton is optional and needs the user's approval.

## Input

- Decisions from phases 01-07 (`01-brief.md` to `07-security-privacy-and-cost.md`).
- Skipped phases, each with its reason.
- Pending items.

## Decide

### When to record `[criterion]`

Based on a community guide, not on Nygard, MADR or Fowler.

- Record a decision when it is hard to reverse, has real alternatives, affects structure, quality, interfaces or cost, or when its reasoning would otherwise be lost.
- Do not record minor preferences, temporary choices, single-person decisions, or anything already covered by a standard. No filler records.

### Entry types

All three use the same template.

1. **Decision taken**: status `accepted`.
2. **Phase or topic deliberately skipped** `[criterion]`: by default, a line in the triage section of `00-brief.md` with its reason ("no database: content in files"). Give a skipped topic its own record (status `accepted`, titled "Skip X" or "Do not decide X yet", with the reason, the `revisit-if` condition and what is assumed meanwhile) only when it has a condition for revisiting it or the user asks. Review mode reads both forms as deliberate, not as an oversight.
3. **Pending item** `[criterion]`: status `proposed`. It lists the known options and the criterion to close it. When decided, it becomes `accepted` or `rejected`.

## Do

### Where it lives

- Folder `docs/decisions/`, or the one the project already uses. This follows MADR's convention; Fowler uses `doc/adr` and Nygard `doc/arch`.
- One file per decision, named `NNNN-short-title-with-hyphens.md`. Numbers are sequential and never reused.
- Index `docs/decisions/README.md`: one line per record (number, title, status) and a "Pending" list.
- The phase 01 brief (`01-brief.md`) is stored as `00-brief.md`.

### Template

MADR 4.0.0 minimal base plus the status and consequences sections from Nygard (MADR 4.0.0: volatile, verified 2026-10-12). Fields marked `[criterion]` are this skill's additions.

```markdown
---
status: proposed | accepted | rejected | deprecated | superseded by NNNN
date: YYYY-MM-DD
decision-makers: [names or roles]
supersedes: NNNN              # [criterion] only if it replaces another record
revisit-if: [condition]       # [criterion] context change that forces re-evaluation
---
# NNNN. Short title: problem and chosen solution

## Context and problem statement
Forces at play, in neutral full sentences. Brief requirements that justify it.

## Considered options
* Option A
* Option B

## Decision outcome
Chosen option: "A", because … (one verifiable reason).

### Consequences
* Good: … / Bad: … / Neutral: …

## More information (optional)
Links and evidence with read date; `[NEED: …]` or `[NEED: legal review]` if applicable.
```

- Write as an inverted pyramid, with serious alternatives and a confidence level. Use the minimal template by default; the full MADR template (pros and cons per option) only when real options must be compared.
- Size: a landing page needs the brief (with its triage and skipped phases) and one or two records, for example stack and hosting; a SaaS has one entry per decision from phases 02-07.

### Supersede rules

- Never rewrite an accepted record; supersede it. Create a new record with a new number and `supersedes: NNNN`. In the old record, change only its status to `superseded by NNNN`, the only permitted change.
- Never delete or renumber a record. Volatile facts carry a link and a read date; `revisit-if` states when to read them again.

### Expected content per phase

- 01: brief (`00-brief.md`).
- 02: type and platform, rendering model per zone, architecture style.
- 03: language, framework, innovation spend, version and end of support.
- 04: data and its operation, RPO and RTO, backup policy, data map with retention and location.
- 05: services, build or integrate, decisions expensive to reverse (user ID, organizations, session model).
- 06: hosting, environments, CI/CD and rollback, region, cost and alerts, observability level.
- 07: security rigor level, main threats, before-launch list, reporting channel.

Skipped phases appear in the triage section of the brief, or as type 2 entries when they have a revisit condition.

### Handoff to other skills

The record is what other skills read; they do not ask the user for anything already written in it. Without a record, they keep working with the existing stack.

- **Visual Director** reads project type, platform, rendering model and framework (02, 03) to choose visual technology within the decided stack.
- **landing-launch** is meant to read the hosting and headers record (phase 6), the forms, analytics and services records (phase 5), and, in its legal phase, the data map (phase 4). This skill does no legal analysis. The receiving skills must be updated to read the record: until then they keep working with the existing stack.

### Optional minimal skeleton

Only with the user's approval and after the stack is decided. No business code, no screens. It leaves a project that starts and deploys, so Visual Director and `landing-launch` begin on something that builds.

1. README: requirements, install, run, test, build, required variables.
2. `.gitignore` for the chosen stack, from the official templates, committed before the first install. Covers `.env` and build output.
3. Example variables file with names and placeholder values, never real ones; secrets come per deployment. Only Laravel documents this pattern officially.
4. Chosen package manager with its lockfile committed. Verified for npm only; check other managers' documentation.
5. Install, build and test commands defined and documented with what the stack provides.
6. Minimal CI running tests and build on push and pull request.
7. Branch and deploy policy in one or two lines: main branch, whether a PR is required and which checks, what deploys and how, within the provider's plan.
8. License or notice decided by the owner. SECURITY, CONTRIBUTING and CODE_OF_CONDUCT only if the repository is public or accepts contributors.
9. `docs/decisions/` with the template and the first records.

Do not: write business code; install dependencies before the package manager and version are decided; create empty folders or files by ceremony; commit `.env` or real secrets; copy legal templates without deciding they apply.

Larger scaffolding (several packages, a monorepo, infrastructure) goes to the normal planning flow (`to-spec` and the normal planning flow), outside this skill.

## Deliverable

- `docs/decisions/` with `00-brief.md`, the records, the index with status and pending items, and the skeleton if accepted.

## Verify

- Each triage phase is covered by a record, or by a skip line in the brief (or a skip record) with its reason.
- Each record links to a brief requirement and has a status and a date; records that depend on volatile data or skip a topic also have a `revisit-if`, and volatile data has a link and a date.
- No secret or real value is in the repository. The skeleton, if present, starts, builds and passes the minimal test with the documented commands.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| `.env` or secrets committed | Search the tree and history for secrets and `.env` files | Blocking |
| No `docs/decisions/` in a project with non-trivial decisions | Folder listing; several contributors raise it to High | Medium |
| Records without status, or rewritten after acceptance | Diff of accepted records against their history | High |
| Superseded decisions without a link | Search for `superseded by` and `supersedes` | Medium |
| Phases skipped without a reason | Compare the triage with the records and skip entries | Medium |
| Volatile decisions without a date or `revisit-if` | Front matter of each record | Medium |
| No lockfile, no start README, or no CI or branch policy | Repository tree; workflow files; branch protection settings | Medium |
| Index out of date | Compare `README.md` with the files in the folder | Low |
| Filler records | Records with no link to a brief requirement or a real decision | Low |

Verdict per item: Pass / Improvable / Missing / N/A. Without a record, rebuild it from the repository and confirm it with the user.

## Gate

The skill is finished when the record exists (with the brief and decisions, or with "skip" entries and their reasons), the index lists pending items, volatile decisions are dated, and the skeleton exists if the user asked for it. Recommended next steps: Visual Director for design, then `landing-launch` for the main pages.

## Not verified / to confirm

- Lockfiles of pnpm, yarn, bun, composer and pip; the consequence of having no license (GitHub does not explain it); protected-branch limits in personal private repositories.
- MADR 4.0.0: the full template was checked for structure only; the minimal template's front matter was read truncated.
- The guide on when not to record comes from a community repository (Joel Parker Henderson), not from Nygard, MADR or Fowler. Skipped phases, pending items, `revisit-if`, `supersedes` and the index are this skill's adaptations. Source quotations were read through summaries: reopen the originals before quoting.

Sources: Nygard, "Documenting Architecture Decisions" (2011, https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions); ADR GitHub organization (https://adr.github.io/) and templates (https://adr.github.io/adr-templates/); MADR (https://adr.github.io/madr/, repository https://github.com/adr/madr, minimal template https://raw.githubusercontent.com/adr/madr/4.0.0/template/adr-template-minimal.md); Fowler, "Architecture Decision Record" (https://martinfowler.com/bliki/ArchitectureDecisionRecord.html); GitHub docs: ignoring files (https://docs.github.com/en/get-started/git-basics/ignoring-files), community profiles (https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories), SECURITY policy (https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository), CONTRIBUTING (https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors), code of conduct (https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project), license (https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository), protected branches (https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), GitHub Actions (https://docs.github.com/en/actions/get-started/understand-github-actions); Twelve-Factor App, config (https://12factor.net/config); Laravel configuration (https://laravel.com/docs/12.x/configuration); npm package-lock.json (https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json); read 2026-10-12.
