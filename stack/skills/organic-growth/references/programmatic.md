# Programmatic pages

Load this when deciding whether to create or extend a family of pages built from a template and data: comparisons, alternatives, integrations, personas, locations, glossary. It covers the decisions a family needs. The generator and the page format belong to the project.

A family multiplies whatever is in its template and its data, including mistakes. One wrong field becomes a wrong claim on every page that prints it, and in every artifact generated from those pages.

## Should the family exist?

All four must hold. If one fails, stop and say which.

- **Intent is evidenced.** Search Console already shows impressions for the pattern, or the query is a question real buyers ask. Volume from a keyword tool is an input, not a reason. A family that "scales with the number of competitors" scales its liabilities too.
- **Each page has something only it can say.** Write down the fields that differ per page. If removing the swapped name leaves the same page, it is a near-duplicate, whatever the intro says. Data is stronger the harder it is to copy: created by you, derived from your product, contributed by users, licensed, public.
- **Someone can keep it true.** Estimate pages × volatile facts × review cycle. If nobody will do that work, shrink the family or drop the volatile facts.
- **It does not compete with a family you already have.** Same intent on two URLs needs distinct roles and a link between them, or one of them goes.

Check Google's current [spam policies](https://developers.google.com/search/docs/essentials/spam-policies) on scaled content and doorway pages before committing to a large family.

## What each family owes the reader

| Family | Each page needs | The recurring cost |
|---|---|---|
| Comparison or alternative | Facts checked on the third party's own site, a recommendation by use case | Prices, plans and features decay |
| Integration | An integration that works, setup steps, a real use case | Breaks when either product changes |
| Persona or niche | Problems and features specific to that audience, ideally evidence from it | Drifts into the same page with another noun |
| Location | Local data: providers, prices, rules | The local data itself |
| Glossary | A definition with examples, more depth than a dictionary, links to related terms | Low, but can rank without buying intent |
| Directory or curation | Real criteria, details per entry, a visible review date | Entries go stale; rankings need a method |

## Model the data before the first page

Prose can be corrected one page at a time; a type cannot. Before writing content, check against the three messiest real cases that the model can represent them (section 9 of `diagnosis.md`).

- Every volatile field has a source and a checked date, stored per record rather than once for the whole family.
- "Unknown" is a valid value, and the template prints it as unknown. A default in a table reads as a claim.
- A date or year in a title is a promise of review. Generate it from the review date, or schedule the change.

## Template

- The opening answers the query; it does not describe the subject.
- Sections depend on data. When a record has nothing to say for a section, omit it instead of filling it.
- Titles and meta descriptions differ for a reason beyond the swapped name. They decide the click.
- The content is in the initial HTML, so crawlers and assistants can read it.

## Reach

A hub linking to its pages is the minimum, not distribution. Link from existing pages that already receive impressions and match the intent; a family nothing else links to stays invisible however complete it is. Regenerate whatever is derived from these pages (sitemap, `llms.txt`, feeds) and include that diff in the review.

## Roll out in batches

1. Write down beforehand what would make you expand, fix or stop.
2. Publish the strongest pages first: 20 to 50, or fewer on a small site.
3. Wait one full reporting window, for example 28 days, and read Search Console per family: indexed pages, impressions, queries, clicks.
4. Expand only what passed. A defect found now costs a few edits; after the full rollout it costs the whole family.

## When a family does not work

No impressions after a full window, on pages that are indexed and linked, means the intent or the page is wrong, and adding pages will not fix it. Consolidate or remove, with redirects, and record the outcome in the backlog's `verified` state.
