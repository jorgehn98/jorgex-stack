# Inventory

Produce a factual picture of what exists. Everything in this step is read-only: do not fix, translate or publish anything yet.

## Routes and pages

Find the routing model before listing URLs:

- Astro: `src/pages/`
- React Router or Remix: `src/routes.ts`
- Next: `app/` or `pages/`

Then read the prerendered output if the project builds statically (`build/client`, `dist/client`, `.vercel/output/static`). The generated HTML is what a crawler sees; the source tree can disagree with it when routes are generated from data.

## Content shapes

Identify each family and how it is stored, because the format decides how a new entry is added and what validates it:

| Shape | Looks like | Extension point |
|---|---|---|
| Markdown with frontmatter | `src/blog/posts/<locale>/<slug>.md` | copy a recent file, same frontmatter keys |
| Typed data files | `src/data/<locale>/comparisons/<slug>.ts` | add a module conforming to the shared type |
| Content collections | `src/content/<collection>/<slug>.md` | collection schema plus i18n pairing file |
| CMS or API | no files in the repo | the project's own integration path |

For each family, note: the locale set, whether slugs are shared across locales, how alternates are paired, and which script regenerates derived artifacts.

## Coverage matrix

The single most useful artifact of this step. Count per family and locale:

| Family | es | en | de | Status |
|---|---|---|---|---|
| Blog posts | 42 | 42 | 42 | complete |
| Programmatic comparisons | 10 | 0 | 0 | gap |

Zeros are the finding, and a matrix makes them undeniable in a way prose does not. Whether a zero is worth filling is decided later, in prioritization.

## Machine-readable surfaces

Check each of these and whether it agrees with reality:

- `sitemap.xml` — generated or hand-written? Does it include the newest pages?
- `robots.txt` — are AI crawlers allowed or blocked? Blocking GPTBot while asking for AI citations is a contradiction worth catching here.
- `llms.txt` and `llms-full.txt` — do they list pages that exist?
- JSON-LD per page type: `Article`, `FAQPage`, `Person`, `Product`, `SoftwareApplication`, `BreadcrumbList`.
- `canonical` and `hreflang` — is every variant of a page listed on every other variant?
- Markdown variants served to agents, if the project has them.

If the project has a generation step for these files, run it and inspect the diff instead of editing artifacts by hand. Drift between the generator and the committed files is itself a finding.

## What the site does not say

Read the top pages as a stranger arriving from a search result. Can you answer, without leaving them:

- what the product is and who it is for
- what it costs, and what the price includes
- what it integrates with
- where the data is stored and how to cancel

A missing answer is a gap as real as a missing page, and it is the gap that stops an assistant from describing the product correctly.

## Output

A short table per family and locale, the list of drifted or unreachable artifacts, and the unanswered questions from the last section. No fixes in this step.
