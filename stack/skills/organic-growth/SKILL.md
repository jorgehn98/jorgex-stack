---
name: organic-growth
description: Decide and verify what a product site should publish or fix next so it gets found in Google and cited by AI assistants. Inventories what already exists, diagnoses the pages that underperform, ranks the real gaps, produces with the project's own authoring rules, and records whether ChatGPT, Claude, Gemini and Perplexity name the brand. Use when the user asks what content to write next, why a page or the whole site is not getting traffic, whether AI recommends the product, or wants to audit a blog, docs, glossary, comparisons or alternatives pages, or work out what is missing from them; also when they mention SEO, GEO, AEO, AI search visibility, programmatic SEO, llms.txt or citation monitoring.
---

# Organic growth

Organic growth is not a publishing quota. It is a loop: know what you already have, fill the gap with the highest return, and check whether the result is actually being found.

The expensive failure is not writing too little. It is writing volume nobody reads while content that already works stays untranslated, unpublished or unreachable from the pages that matter. Most sites asking for "more content" have a distribution and translation gap, not a writing gap.

## The loop

Five steps, in order. Do not jump to step 4 because someone asked for an article.

1. **Inventory** — read the site's real state: what exists, in which languages, which pages are reachable, what the sitemap and `llms.txt` claim, which schema is present.
2. **Diagnose** — for the pages that exist, find what stops them working: the answer buried, the claim unverifiable, the sibling duplicated, the translation a calque, the price stale.
3. **Prioritize** — rank gaps and defects together by expected return, not by keyword volume.
4. **Execute** — follow the project's own authoring rules. This skill decides that a page should exist, be fixed or be removed, and in what shape; it does not replace the project's format reference.
5. **Verify** — record whether search and assistants surface the result, then return to step 1.

Steps 1 to 3 cost nothing and usually hold most of the value. Skipping them is how a content plan becomes a backlog nobody finishes.

Diagnosis is what separates an audit from a wish list. A site with sixty pages and flat traffic has a quality and distribution problem far more often than a coverage problem, and writing sixty-one more does not fix it.

## What makes it improve

The skill does not improve by re-reading the same pages and forming new opinions about them. It improves only when new evidence arrives from outside:

- **Search Console** — impressions, clicks, average position per page and query. A page with impressions and no clicks has a metadata or intent problem; a page with neither has a reachability or authority problem. The two need opposite fixes.
- **The citation log** — which entity facts the assistants are missing.
- **The backlog's own `verified` state** — which past bets paid off. A backlog that never records outcomes is a to-do list, not a strategy.

If none of those inputs exist, say so before producing a plan. A second audit without new data will list the same gaps in a different order and feel like progress.

## Rewrite or report

Default to a written diagnosis: one line per page with the defect, the evidence and the proposed fix. Rewriting published content is a separate, explicit decision, because a live page may be ranking, linked or quoted, and changing it is a bet the user should see before it is placed.

When the user does ask for the rewrite, do it through the project's own authoring rules and keep the change reviewable — a diffable edit, not a regeneration of the whole page.

## What this skill does not do

- **No link building.** Link exchange and paid link networks are a spam risk and a marketplace, not a procedure. Do not propose them, and do not blame backlinks for flat traffic before the inventory says so.
- **No auto-publishing.** Producing a page and shipping it are separate decisions, and shipping is the user's.
- **No volume targets.** "Thirty articles a month" is a content-farm metric. Choose the number the team can actually verify.
- **No facts from memory.** Every keyword, competitor, price and claim comes from the repository, a live page or a tool result obtained in this session.
- **No conversion-page design.** For a single landing meant to convert, use `landing-launch`.
- **No feature launch posts.** Announcing what was just shipped belongs to the project's launch workflow; this skill decides what is missing, not what to publicise. When both could apply, the user asked for one of them and the request is the tie-breaker.

## Where the state lives

Find the project's existing home before creating anything: `docs/seo/`, `docs/marketing/`, an SEO section in `docs/`, or a planning file.

Write findings into that existing place only when the user asks to persist them. Report in the conversation first. An audit that edits the repository before anyone has read it takes the decision away from the person who requested it, and a second backlog is worse than none: both go stale and neither gets trusted.

## References

- `references/inventory.md` — what to read and in which order, per project shape.
- `references/diagnosis.md` — what to check on a page that already exists, ordered by how often it is the actual problem.
- `references/prioritization.md` — the criteria, the ranking and the backlog format.
- `references/citation-check.md` — how to measure AI citations without inventing a score.

Load the one for the step you are in. Producing a new page without reading `diagnosis.md` is how a site ends up with sixty mediocre pages and one more.

## Gates

Before producing anything, confirm:

- **The gap or defect is real**, not assumed: the page does not exist, exists without translation, nothing links to it, or it exists and fails for a stated reason.
- **The claim is checkable** against the product, the code or a named source. Product limits are stated, not smoothed over — a page that overstates gets contradicted by the product and stops being cited.
- **Third-party facts come from the third party.** A competitor's pricing or features recorded in the repository is a claim, not a source: it goes stale silently and then gets published as JSON-LD. Check the competitor's own page and record the date you checked. A fetched page is not proof of absence: fetch tools summarize, truncate and miss JavaScript. Before calling a third-party fact false or unpublished, read the raw text or a browser render, and check every plan and billing cycle.
- **The URL is new**, or changing a published one comes with a redirect.
- **The format matches** what the project consumes: MDX, Markdown with frontmatter, typed data files, Astro collections, a CMS API.

If one fails, stop and say which. Do not produce a page to fill a slot.

## Report

Close every pass with four things: what the inventory found, what the diagnosis found on existing pages, what was produced or fixed and where it lives, and what remains unverified. Separate clearly what was measured from what was assumed.
