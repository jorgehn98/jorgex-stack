# 01 — Brief

Scope note: This phase fixes what the project is and which constraints are real before any technology is proposed. Later phases, including visual and launch work, read its output. It covers new, existing and mixed projects. It does not choose a stack and does not analyze legal obligations: the data map recorded here is read later by the legal phase of the landing-launch skill. Unless a heading says otherwise, the rules below are the skill's own criteria.

## Input

Establish the project case first. It decides what you inspect.

- **New project**: no repository or stack to read. Input is what the user says plus what already exists around them: domain, hosting or service accounts, tools and languages they know, other projects that should share infrastructure, documentation or earlier ideas. Record the existing stack as "none"; do not invent one.
- **Existing project**: inspect before asking. Read the repository, lockfiles, configuration, CI, containers, existing documentation, and the domain and hosting in use. Detect the real stack and reuse it unless the goal prevents it.
- **Mixed** (partial code, a prototype, or a landing page that will grow): treat the existing parts as existing and the missing parts as new.
- Even in a new project, check the user's installed tools and the conventions of their other projects, so you do not propose something they cannot maintain.

## Decide

### Opening question

Ask one open question: "What is the project about, and what must it achieve?" Derive every other question from the answer. Do not run a fixed questionnaire.

### What to find out

Ask only for what is missing and would change a decision:

1. **Type and purpose**: informational or marketing site, app with accounts, internal tool, API or service, store, editorial content, prototype.
2. **Users and realistic volume**: who uses it, how many, expected peaks. Design for the scale expected in 12 to 18 months, not an imagined one.
3. **Data**: what is stored, whether it includes personal or sensitive data (health, minors, payments), who writes and who reads it, and how long it is kept.
4. **Functions that force architecture**: accounts and permissions, payments, real-time, heavy files, search, AI, offline use, native mobile, mandatory integrations.
5. **Visibility**: public and indexable (SEO) or behind login; languages and regions.
6. **Constraints**: maximum monthly budget, deadline, tolerance for vendor lock-in, data residency or compliance requirements.
7. **Team and maintenance**: who builds it, who maintains it, what they already know, who edits the content.
8. **Lifespan**: disposable prototype, product to validate, or long-lived system.
9. **Existing assets**: for an existing project, repository, stack, domain, hosting and services; for a new one, what the user already has or knows. Reuse unless the goal prevents it.
10. **Jurisdiction and market**: where the users are, if there is personal data or sales. Record the answer in the data map and mark `[NEED: legal review]` for any legal conclusion. Legal analysis is out of scope here.

### Commercial use

Ask whether the project is a business or earns money (sales, subscriptions, ads, paid services). The answer can change which plans are eligible in phase 06. Check each provider's current terms on the day of the decision.

### User preferences

Preferred providers or tools (hosting, database, auth, payments) are a weighty criterion, because the team's knowledge and its ability to maintain the system matter. They are never imposed. Check each preference against the project's requirements, and say when one does not fit. Do not discard a preference by default. Do not store preferences in the skill; read them from the conversation, the user's instructions or the project's documentation.

### Triage: which phases apply

Do not walk through all eight phases for every project. After the brief, decide which phases apply, which take one line, and which are skipped. Tell the user, give the reason and record it in the brief. The user can add or remove phases. A phase marked light has a light gate: its one-line entry in the record.

Phases: 1 brief, 2 type and architecture, 3 language and framework, 4 data, 5 identity and services, 6 deployment and infrastructure, 7 security, privacy and cost, 8 decision record and skeleton.

| Project type | Phases that apply | Reduced or skipped |
|---|---|---|
| Landing or static informational site | 1, 2, 3 (light), 6 (light), 7 (light), 8 | 4 and 5 unless a form service or third-party analytics is used; no database or accounts |
| Site with managed content (CMS) | 1, 2, 3, 4 (where content lives), 5 (partial), 6, 7, 8 | Identity only for editors |
| Online store | 1, 2, 5 (payments and email), 6, 7, 8 | 3 and 4 nearly empty if a commerce platform is used |
| App with accounts (SaaS) | All | None |
| Internal tool | 1, 2, 3, 4, 5 (identity), 6, 7, 8 | Public visibility and SEO |
| API or service without interface | 1 to 8 | Rendering (phase 02, zone model) |
| Mobile app | All, plus store requirements | None |
| Extension or automation | 1, 2, 3, 6 (light), 8 | 4, 5 and 7 unless data or credentials are involved |

Rules:

- Phase 08 always applies.
- A light phase is resolved with one question and one line in the record.
- Record every skipped phase with its reason (for example, "no database: content lives in files"), so a later review knows it was deliberate and not forgotten.
- If a later requirement reactivates a skipped phase (for example, a form that now stores data), return to that phase.

## Do

### How to ask

- Group independent questions; leave dependent ones for later.
- Give each question a recommendation and its cost. Separate facts you can investigate from decisions that belong to the user.
- If a material ambiguity remains, use the `grilling` skill. Otherwise do not.
- Stop when the objective, limits and risks are understood. Implementation preferences do not start a second interview.

### Existing projects and pitfalls

- Read the repository before the interview and confirm the findings with the user. Write the stack as detected, not as assumed; if the documentation disagrees with the code, the code wins and the difference is recorded.
- Flag these pitfalls [criterion]: technology chosen before the problem; design for a hypothetical scale; choice by trend or by a developer's résumé; ignoring who will maintain the system.

## Deliverable

Record in `docs/decisions/00-brief.md`, or in the documentation folder the project already uses:

- One-sentence purpose, project type and lifespan.
- Users and expected scale; data and its sensitivity.
- Functions that condition the architecture; main constraints.
- Team, maintenance and content editors.
- Existing assets, or "none" for a new project.
- Unknowns, each with an owner; the phases that apply, the light ones and the skipped ones with reasons.
- Data map entry for the legal phase: audience and jurisdiction, whether there is personal or sensitive data, and whether there are sales. `[NEED: legal review]`.

Missing data is marked `[NEED: …]`, never invented.

## Verify

- Existing project: stack detected by reading the repository (lockfiles, configuration, CI, containers), not assumed.
- New project: the user confirmed nothing exists to reuse, and their real tools and knowledge are recorded.
- Scale and budget figures are confirmed by the user, not estimated by the skill.

## Audit

Applies to existing projects only (review mode). If no brief exists, rebuild it from the repository and confirm it with the user. Severities are the skill's own criteria.

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Sensitive data (personal, health, payments, minors) is recorded | Brief lists it; compare with the schema and the data flows | High |
| The brief exists with purpose, type and constraints | Brief file present and matching the project's scope | High |
| The built system matches the stated type | Routes and features against the brief's type | High |
| Expected scale matches the architecture | Confirmed volumes against deployed capacity | High |
| Budget and maintenance limits are respected | Monthly cost of services against the stated maximum; a named maintainer | High |
| The stack was chosen after the problem was defined | Decision record: dates and reasons for the stack | Medium |
| Preferred providers were checked against requirements | Each preference marked as fit or no fit, with the reason | Medium |
| Unknowns have an owner or a `[NEED: …]` marker | Search the brief for unresolved items | Low |
| Skipped phases have a recorded reason | Triage section of the record | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to phase 02 without:

- A one-sentence purpose.
- The project type.
- The main constraints.
- The existing stack detected, or confirmation that the project is new.
- Critical unknowns resolved or assigned.
- The triage recorded.

## Not verified / to confirm

- Whether the commercial-use answer changes plan eligibility for a given provider: check its current terms on the decision day.
- The legal consequences of the data map: out of scope here, `[NEED: legal review]`.

Sources: none. This phase has no external sources; its rules are the skill's own criteria.
