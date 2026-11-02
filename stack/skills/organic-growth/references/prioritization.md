# Prioritization

Rank by expected return per unit of effort and risk. Search volume is not a criterion; it is an input to one.

## The order that holds

1. **Correct what is false on published pages.** A wrong price or an overstated capability gets quoted against the site, and every step below copies or spreads it.
2. **Translate what demonstrably works.** A page with evidence of traction in one language and missing in another is the cheapest win available: no new research and a proven structure. A page merely existing is not that evidence, and the business may have ruled the market out for now. Without both, a zero in the matrix is a question, not a priority.
3. **Bottom-funnel pages that do not exist.** Comparisons, alternatives, pricing, integrations, migration, "X vs Y". Whoever types these already wants to buy or is trying to leave a competitor.
4. **Entity coverage.** The pages an assistant needs to describe the product correctly: what it is, who it is for, what it costs, what it connects to, where data lives, how to cancel. Without them the brand is absent or misdescribed in AI answers, which is worse than not appearing.
5. **Citation gaps.** Questions where a competitor is named and the product is not. Prioritize the ones that match a real buyer question over the ones that flatter the brand.
6. **Internal linking and orphans.** Content nothing links to is invisible to both crawlers and readers. Usually cheaper than writing, and frequently the actual reason a good page has no traffic, so move it up when new pages are the alternative.
7. **Technical hygiene.** Schema, canonical, hreflang, sitemap and `llms.txt` drift. Cheap and worth doing, but on its own it rarely explains flat traffic — do not lead with it because it is the easiest to verify.

## Anti-criteria

Reject a topic when:

- **It targets volume without intent.** A definition nobody searches before buying can rank and still produce no customers.
- **It duplicates an existing page under another keyword.** Programmatic families collapse into near-duplicates quickly; read the two nearest neighbors before adding a third.
- **It would exceed what the team can review.** Unreviewed pages on a young domain are a liability, not an asset. Publishing less and reviewing it beats publishing at a rate nobody can check.
- **It exists to mention the brand.** Ten thin pages repeating the product name do not create authority; they create sameness.
- **The only argument is a competitor does it.** Copying a competitor's page adds nothing the assistant can prefer.

## What each candidate must state

One line per candidate, in this shape:

> **Comparison: Acme vs Rival (en)** — exists and converts in Spanish, missing in English and German. Reuses the validated structure. Effort: translation plus price verification. Worth it if the English pricing page is ready.

That is enough to argue about. Note what would have to be true for it to be worth it, and say when something depends on an unfinished decision elsewhere.

Avoid numeric scores. A fabricated 1–10 hides the reasoning and invites ranking by the number instead of the argument.

## Backlog format

One table in the project's existing SEO home:

| # | Gap | Type | Locale | Why | Status |
|---|---|---|---|---|---|
| 1 | Acme vs Rival | comparison | en, de | mirrors a working es page | idea |

Ordered by the priority above. Status is one of: `idea`, `brief`, `drafted`, `published`, `verified`.

Keep one table. Per-person or per-quarter copies diverge within a month.
