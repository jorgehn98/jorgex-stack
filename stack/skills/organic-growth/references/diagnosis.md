# Diagnosis

What to check on a page that already exists. Ordered by how often it is the actual problem, not by how easy it is to check.

Look at the rendered page and its HTML, not only the source file. A page can be correct in the repository and broken in the output: metadata overwritten by the layout, schema injected twice, an image that never loads.

## 1. The answer is buried

Read only the first paragraph. If it does not answer the question in the title, the page fails for both a reader and an extractor. This is the most common defect and the cheapest to fix: move the answer up, keep the build-up below.

## 2. The claim cannot be checked

Mark every sentence that asserts something: a price, a limit, a comparison, a capability, a date. Each needs a source — the code, the pricing page, a named document. A page made of adjectives is not citable; a page with one precise number is quotable in isolation, which is exactly what an assistant extracts.

State the condition, not the absolute. "Exports on the paid plan" is true; "exports" is not.

## 3. The page is a near-duplicate

In a programmatic family, read the two nearest siblings — same type, closest competitor or niche — and compare paragraph by paragraph. Swapping the competitor name in a template produces a page that competes with its own siblings for the same query, and search engines usually keep one.

If the only difference is the name, the page needs a real differentiator: pricing specific to that competitor, a feature it lacks, a migration note, an actual screenshot of the difference.

## 4. Nobody can reach it

Count internal links pointing in, from pages outside the family, and check whether the hub lists it. An orphan page has no traffic regardless of quality, and it is invisible in a content plan that only counts what was published.

Also check the paths a crawler and a reader take: does the hub link to the detail page, does the detail page link back, is the page in the sitemap, does `llms.txt` mention it.

## 5. Title and intent disagree

A page titled as a comparison that never compares, or as a guide that is a product announcement, loses the click and the citation. The title promises a shape; the body must deliver that shape in the first screen.

Check the meta description too: if it repeats the title, it wastes the only free chance to state the differentiator.

## 6. Schema and content disagree

Every `FAQPage` question must appear as text on the page. Every `Article` needs a real author and date. A `Product` with a price that no longer matches the pricing page is worse than no schema.

Validate the generated JSON-LD, and check there is exactly one of each block — duplicated schema from a layout plus a page component is common.

## 7. The translation is a calque

Compare structure, not wording: same number of sections, same tables, same internal links with the locale prefix. Then read two paragraphs and check they read as written in that language.

The recurring defects are mechanical and worth checking explicitly: frontmatter keys that must stay identical across locales, quotes that break the parser when the language uses apostrophes, and app labels copied from Spanish instead of the locale's real UI strings.

## 8. The facts are stale

Prices, competitor features, product limits and dates all decay. A comparison quoting last year's price is a liability: it is the page most likely to be quoted back at the user as proof the site is wrong.

Check the date in the frontmatter or the page, compare the numbers against the live pricing page, and flag anything older than the last pricing change.

## 9. The data cannot represent the reality

The page is generated from a record: a typed object, a frontmatter schema, a CMS field. When that shape cannot express something true about reality — a competitor whose plans are modular instead of one ladder, a product with different language support per surface, a price that depends on billing cycle — every page in the family inherits the distortion, and correcting the prose leaves the defect in place.

Ask whether the data could hold the truth at all. If it cannot, say so plainly: the fix belongs in the type or the data file, it affects every sibling page, and it is a decision for the user rather than a text edit. This is the finding most likely to be missed, because it requires looking past the page that was asked about.

## How to report

One line per defect, in this shape:

> `es/comparisons/rival.ts` — FAQ answer quotes $50/mes while the live pricing page says $49. Evidence: pricing page, checked today. Fix: update the answer and the table row.

Then group by page, and order pages by the priority file. Do not rewrite anything in this step. A diagnosis the user can argue with is more useful than a rewrite they have to reverse-engineer.
