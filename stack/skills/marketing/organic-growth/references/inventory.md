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
- `robots.txt` — are AI crawlers allowed or blocked, and is the block deliberate? Blocking the *search* crawlers (`OAI-SearchBot`, `PerplexityBot`, `Claude-SearchBot`, `meta-webindexer`) while asking to be cited is a contradiction worth catching here. Blocking training crawlers (`GPTBot`, `ClaudeBot`) is a separate opt-out and does not stop citations on its own. A WAF or CDN can block them too, even with a permissive file.
- `llms.txt` and `llms-full.txt` — do they list pages that exist, and is `llms.txt` linked from a visible page?
- JSON-LD per page type: `Article`, `FAQPage`, `Person`, `Product`, `SoftwareApplication`, `BreadcrumbList`.
- `canonical` and `hreflang` — is every variant of a page listed on every other variant?
- Markdown variants served to agents, if the project has them.

If the project has a generation step for these files, run it and inspect the diff instead of editing artifacts by hand. Drift between the generator and the committed files is itself a finding.

The rest of the site-wide technical checks — real indexation, canonicalisation, URL structure, Core Web Vitals, mobile, HTTPS, and what needs Search Console — are in `technical.md`. Do not repeat them here.

## The entity off the site

Models build the brand from everything published about it, not only from the site. Read the profiles a buyer or an assistant would find: LinkedIn (company page and the person's profile), Google Business Profile where the business has a local presence, directories, review platforms and partner pages.

- **The same segment, category and proposition as the About page.** If the site says one thing and the profile says another, the assistant has two entities and picks the one with more corroboration.
- **Fill the free fields** (what it does, who it is for, which industries). An empty profile is an absence, and absence reads as unknown, not as neutral.
- **Reviews and posts on those profiles count as text.** An outdated claim there gets quoted back as current.
- **After a repositioning, change the off-site profiles first and the site second.** The old association survives longer in profiles and reviews than in the page; swapping everything at once loses the old segment before earning the new one.
- **Answer the "cons" assistants repeat.** Aggregators list one con per product. If it reinforces a weakness the model already states, publish the real number or process on the page that owns it and ask the publisher for a different true con, never for removal.

The LinkedIn surface, and how to make its text citable, is in `offsite-surfaces.md`.

## What the site does not say

Read the top pages as a stranger arriving from a search result. Can you answer, without leaving them:

- what the product is and who it is for
- what it costs, and what the price includes
- what it integrates with
- where the data is stored and how to cancel

A missing answer is a gap as real as a missing page, and it is the gap that stops an assistant from describing the product correctly.

### Fact families, not a page per question

Engines rewrite a prompt into several background searches before answering, and 91% of ChatGPT's search queries were unique across repeated runs (Profound, April 2026; observational vendor research). Exact query strings will not repeat, so plan by the stable **fact families** underneath them: price, delivery time, stack, process, integrations, data location, cancellation, limits.

Each fact family has **one owning page**, however many derived questions point to it. One strong page can answer several families. A page per fan-out query is a doorway page, it competes with its own siblings, and Google's scaled-content policy targets it.

List the families a buyer needs, name the owning page for each, and mark the missing ones. If two pages claim the same fact, that is a defect to fix, not a plan.

## Output

A short table per family and locale, the list of drifted or unreachable artifacts, and the unanswered questions from the last section. No fixes in this step.
