# 03 — Language and framework

Choose the language, the framework and the framework category for each layer, once the architecture style and the rendering mode from 02-type-and-architecture.md are fixed. Apply the hard filters first, then the weights, and only then pick an example. Versions, support windows and licenses are read on the official page on the day of the decision, never copied from this file. If the project already has a stack, this phase checks its health and decides only what is missing.

Labels: `[criterion]` marks the skill's own rule, which has no official source. Unlabeled statements about support, licenses and tooling come from the official sources in the last line; the category tables, shortcuts by project type and the defaults below are the skill's own synthesis unless a source is named.

Index: Input · Decide · Do · Deliverable · Verify · Audit · Gate · Not verified / to confirm

## Input

- Brief (01-brief.md): expected lifetime, team size and skills, scale, criticality, data residency.
- Decisions from 02-type-and-architecture.md: platform, rendering mode per zone, architecture style.
- Deployment target from 06-deployment-and-infrastructure.md, if already known.
- Existing stack, if any: versions, dependencies and who maintains them.

## Decide

### Hard filters (first; they eliminate options)

1. **Support lifecycle.** Never start on a version without active support. Read the official support calendar of the language or runtime and of the deployment provider. If the provider drops a runtime before the language does, the provider's date governs.
2. **Deployment model.** Check which runtimes the chosen host accepts, startup time and size, and whether the output is a single binary or a runtime you must patch yourself.

### Weights (decide among the options that pass)

3. **Team knowledge and maintenance.** Ask who maintains this in two years and what they know today. It outweighs most technical advantages unless a hard requirement exists. For a one-person team, that person counts. `[NEED: team skills and maintainer in two years]`
4. **Ecosystem.** List the 5 to 10 capabilities the project needs (auth, payments, PDF, ORM, job queue, provider SDK). Check for maintained libraries with recent releases and more than one maintainer. A missing key library weighs more than any benchmark.
5. **Maturity and continuity.** Check years in production, governance, the backward-compatibility policy and how easily the stack can be staffed. A stack only one person knows is a single point of failure.

### Optional criteria (only when the domain requires them)

6. **Performance and concurrency.** Only with a numeric requirement and a measurement: p95 latency, requests per second or cost per request on the server, and the initial JS and transfer budget on anything the browser runs, which is what decides a public page. Without a number it is not a criterion. The bottleneck is usually the database or the network, not the language. `[NEED: measured requirement]`
7. **Typing and memory safety.** Static typing helps growing teams, frequent refactors and contracts between modules. It is excess for short-lived prototypes, one-person scripts or pages without logic. TypeScript types and Python annotations are not enforced at runtime, so validate external input regardless. Memory safety matters for native code and hostile input (parsers, engines, low-level components). None of the open sources consulted justifies changing language for memory safety in typical web or SaaS code on a garbage-collected runtime. `[criterion]`
8. **Cost of change later.** A language is cheap to replace behind explicit contracts (HTTP, schemas, queues) and expensive inside a monolith without boundaries. Prefer explicit boundaries to getting the language right the first time. `[criterion]`

### Boring technology discipline

- Treat language, framework, database and deployment model as candidates for "innovation tokens", a budget of novelty the project can afford (a discipline, not a number). Spend one only when the novelty solves a real problem the boring option cannot solve, and write that reason down.
- The "three tokens" figure is the author's heuristic, not a measured number; use it as a discipline, not a quota. "Boring" depends on the team, and it never justifies staying on an unsupported version.

### Languages per layer

Use one language across layers by default [criterion]. Allow another for a layer only with a recorded concrete reason, such as a required SDK or a measured performance requirement.

### Framework categories: choose the category first, then an example

Take the category from the rendering mode in 02. Examples illustrate a category; they are not recommendations or a ranking. Categories overlap, so choose by the rendering mode the project needs, not by the framework label.

#### Frontend (six)

| Category | Use when | Do not use when |
|---|---|---|
| A. Content or islands | Landings, corporate sites, blogs, docs, catalogs with little interactivity | Dense client state shared across views (dashboards, editors) |
| B. Full-stack with server rendering (meta-framework) | Public product with SEO and dynamic parts; small team that wants one frontend repository with a light server | A mature backend already exists and only static UI is needed; you do not want to operate a server runtime |
| C. UI library for an SPA | Behind login, where SEO does not matter; the team can assemble router, data and build | Public sites that depend on SEO and fast first load without SSR; teams that do not want to assemble the stack |
| D. Opinionated framework for large apps | Many developers over a long-lived, large codebase | Prototypes, landings, teams of one or two; ceremony outweighs the benefit |
| E. Static site generator | Docs, blogs, content that changes with deploys | Per-user or real-time content without an added dynamic layer |
| F. No framework (plain HTML, CSS and JS) | One or a few pages, prototypes, embeddable widgets | More than a few pages with repeated components or state; you end up rebuilding a framework |

#### Backend (four)

| Category | Use when | Do not use when |
|---|---|---|
| G. Minimal framework | Small API or bounded service; the team knows which parts it wants | Large project without internal conventions; each team rebuilds auth, validation and migrations |
| H. Batteries included (MVC) | SaaS or app with a relational database, heavy CRUD, short deadline, small team | Minimal single-purpose service; cases where the ORM or the request cycle gets in the way |
| I. High-performance, schema-driven API | Pure API for SPA, mobile or third parties, with an OpenAPI contract | Apps with HTML views, admin and user flows that need built-in parts |
| J. Backend as a service (BaaS) | MVP, no dedicated backend team, simple access rules | Complex business logic, strict residency or portability, high provider dependency |

No BaaS product was verified. Evaluate any candidate with the health checklist in Do, plus data portability and the provider's pricing and SLA. `[NEED: name the BaaS candidate and its export path]`

## Do

### Shortcuts by project type

These are starting points. Validate each one against the filters and weights above.

- One-page landing: no framework (F) or a static generator (E).
- Multi-page site, blog, SEO: content or islands (A), or a generator (E).
- SaaS with a public part and a panel: full-stack with server rendering (B).
- Internal panel behind login: SPA (C).
- Large, long-lived application: opinionated framework (D).
- Pure API: schema-driven (I).
- Relational management app: batteries included (H).
- Small microservice: minimal (G).
- MVP without a backend team: BaaS (J), with the exit path written down.

Order of decision: language and team experience, then rendering mode, then category, then example.

### Health checklist (any framework or dependency, or an existing stack)

No single signal decides. Combine them and record the date.

1. **Support policy.** Open the official page, note the end date of the version you would use, and compare it with the expected life of the project. If the life exceeds the window, migration cost enters the decision. No published policy, or a 0.x version, is a medium risk: pin versions and keep tests.
2. **Security advisories.** Check the GitHub Advisory Database and the repository Security tab. Published advisories with fixes show a working process; zero advisories does not prove security. Look at the time between advisory and fix.
3. **OpenSSF Scorecard.** Read it as heuristics with false positives and negatives. A -1 means "not evaluable", not zero.
4. **License and governance.** Read the LICENSE file by hand if the API returns NOASSERTION. Check governance (foundation, single company, GOVERNANCE.md). Dependence on one company is a risk of change of direction or license, not a defect in itself.
5. **Migration path.** Find the migration guide for the latest major version and any automation (codemods, upgrade commands).
6. **Activity.** Check release cadence, number of maintainers and repository status (archived, last push).

### Surveys and volatile facts

Industry surveys (Stack Overflow, State of JS, JetBrains) show usage only; cite them with year and sampling bias, never as a selection criterion.

Versions, support windows and licenses change. Open the linked official page on the day of the decision and record the date next to each value. Support models differ by runtime (even-numbered LTS, fixed years per branch, latest stable only, or a vendor-chosen LTS); read each page for its own model. (volatile, verified 2026-10-12)

## Deliverable

Decision-record section (08-decision-record-and-skeleton.md):

- Language or languages, and why.
- Category and framework per layer, linked to requirements in 01 or 02.
- Innovation spend (any novelty chosen over the boring option) and its justification.
- Health checklist result, with date.
- Chosen version and its end of support, verified that day.
- Discarded alternatives.
- Signals that would trigger a review of the decision.
- `[NEED: ...]` wherever the team has not answered.

## Verify

- Every choice links to a requirement in 01 or 02; anything without a link is removed.
- The chosen version has active support on the official page opened that day.
- Key libraries exist and are maintained: checked, not assumed.
- If the team does not know the candidate language, that is written down and the choice was made consciously.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| The version has ended security fixes | Official support page, opened and dated, does not list the version as supported | Blocking |
| The version ends support before the expected life, with no migration plan | Support end date against the life in 01; written migration plan | High |
| A key dependency is unmaintained or has unfixed advisories | Repository status (archived, last push); advisories with fix dates | High |
| Framework size does not fit the project (large framework in a small project, or the reverse) | Category against team size and project life in 01 | Medium |
| Several languages without a recorded reason | Decision record gives one reason per extra language | Medium |
| Novel technology without a recorded innovation-token spend | Decision record section with the token justification | Medium |
| Versions unpinned in a 0.x project | Lockfile or pinned versions; 0.x noted in the record | Medium |
| Major migrations pending | Latest major against the one in use; migration guide | Medium |
| Only one person or one maintainer knows the stack | Maintainer count and staffing note in the record | Medium |
| License not read from the LICENSE file | Recorded license with file reference and date | Medium |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to 04-data.md without: language(s) and framework(s) chosen, with justification linked to 01 or 02; a version with active support verified and dated; key libraries checked; innovation-token spend declared; health checklist done, or marked as not done. For a phase marked light in the triage, the gate is its one-line entry in the record.

## Not verified / to confirm

- No official support page was opened for Nuxt (the URLs tried returned 404), SvelteKit, Hono, NestJS, Phoenix, React Router or React. The Vue release page defines no support windows. Treat their support as unknown until checked.
- Java: the Oracle support roadmap returned HTTP 403, so no Java LTS data is recorded here. Check the page of the vendor you will use: https://www.oracle.com/java/technologies/java-se-support-roadmap.html
- TypeScript: no published support policy was found; the compiler is pinned per project.
- Memory-safety figures come only from the CISA source; the NSA guidance was not opened.
- Survey figures: State of JS not verified; Stack Overflow and JetBrains only partially read.
- Research summaries from automated readers can be inaccurate: reopen each URL before quoting a value or date. Context7 can lag behind official docs (observed with Astro).
- License changes, deprecations and acquisitions in candidate projects were not audited.

Sources: Node.js previous releases (https://nodejs.org/en/about/previous-releases); Python devguide (https://devguide.python.org/versions/); OpenJDK (https://openjdk.org/projects/jdk/); .NET support policy (https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core); PHP supported versions (https://www.php.net/supported-versions.php); Ruby branches (https://www.ruby-lang.org/en/downloads/branches/); Go release policy (https://go.dev/doc/devel/release); The Rust Book, release appendix (https://doc.rust-lang.org/book/appendix-07-nightly-rust.html); TypeScript download (https://www.typescriptlang.org/download/); TypeScript handbook (https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html); Python typing (https://docs.python.org/3/library/typing.html); CISA, The Urgent Need for Memory Safety (https://www.cisa.gov/news-events/news/urgent-need-memory-safety-software-products); CISA, The Case for Memory Safe Roadmaps (https://www.cisa.gov/resources-tools/resources/case-memory-safe-roadmaps); Dan McKinley, "Choose Boring Technology" (https://mcfunley.com/choose-boring-technology) and companion talk (https://boringtechnology.club/); Next.js support policy (https://nextjs.org/support-policy); Angular releases (https://angular.dev/reference/releases); Express support (https://expressjs.com/en/support/); Fastify LTS (https://fastify.dev/docs/latest/Reference/LTS/); Django download (https://www.djangoproject.com/download/); FastAPI versions (https://fastapi.tiangolo.com/deployment/versions/); Rails maintenance (https://rubyonrails.org/maintenance); Laravel releases (https://laravel.com/docs/master/releases); Vue releases (https://vuejs.org/about/releases); Astro upgrade guide (https://docs.astro.build/en/upgrade-astro/); GitHub Advisory Database (https://github.com/advisories); GitHub security advisories docs (https://docs.github.com/en/code-security/security-advisories); OpenSSF Scorecard (https://scorecard.dev).
