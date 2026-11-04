# Technical audit

The site-wide checks that decide whether anything published can be found. On a small site this is an afternoon, not a tool stack: run it when the inventory shows a reachability problem, after a migration, and once a quarter. It is the last priority in `prioritization.md` because, on its own, it rarely explains flat traffic. The recurring launch and maintenance checklist that triggers it lives in the `landing-launch` skill (`references/11-qa-launch-iteration.md`); this file is the detailed pass, not a second schedule.

Items marked **requires Search Console** cannot be concluded from outside. If the property is not connected, say so and use the alternative; do not turn an absence of data into a pass or a fail.

## Crawlability

- **`robots.txt`**: no accidental block of a path that should rank, the sitemap referenced, and the crawler policy deliberate (the AI-crawler decision is read in `inventory.md`). A WAF or CDN can block a crawler that the file allows.
- **Sitemap**: loads and parses, lists only canonical indexable URLs, and includes the newest pages. Drift between the generator and the committed file is a finding in itself.
- **Reach**: important pages within three clicks of the home page, no orphans, and at least one internal link from a page that is already indexed.
- **Infinite URLs**: parameters, faceted navigation and session IDs do not generate families of near-duplicates.

## Indexation — requires Search Console

- **Coverage**: indexed versus expected, and the reason for every excluded group.
- **Wrong signals**: `noindex` on pages that should rank, canonical pointing at another URL, redirect chains and loops, soft 404s.
- **Alternative without Search Console**: request each key URL, read the served HTML (`X-Robots-Tag`, meta robots, canonical) and compare the sitemap with the pages that exist. That proves the page is servable, not that it is indexed: report it as unverified.

## Canonicalisation and URLs

- One host and protocol (`https`, with or without `www`), one trailing-slash convention, and a self-referencing canonical on every unique page.
- Readable, lowercase, hyphen-separated URLs; keywords where they read naturally, no parameters where a path would do.
- Redirects point to the final URL in one hop.

## Core Web Vitals

- **Field data is what counts**: LCP under 2.5 s, INP under 200 ms and CLS under 0.1 at the 75th percentile. Lab scores are a diagnostic, not the verdict.
- **requires Search Console** for the site's field report. The alternative is PageSpeed Insights, which shows CrUX field data and lab data together, plus a `web-vitals` report from a real session. On a very low-traffic origin CrUX may have no data: say that instead of substituting the lab score.
- The usual causes are the same on every stack: unoptimised images, render-blocking CSS, too much JavaScript, no caching, slow TTFB, web fonts loaded late.

## Mobile and HTTPS

- Responsive layout with the same content as desktop, viewport configured, tap targets large enough, no horizontal scroll.
- HTTPS across the whole site, a valid certificate, no mixed content, and HTTP redirecting to HTTPS.

## Output

One line per finding: URL or file, evidence (command, tool, screenshot), severity (blocking, high, medium, low) and fix. Order by blocking first, then by return. This audit produces a defect list, not a content plan: the next page to write comes from `prioritization.md`.

Sources: adapted and condensed from Marketing Skills by Corey Haines (MIT, revision 88c79f6): the technical audit in `seo-audit`. Thresholds and field-data guidance from Google's Core Web Vitals documentation; check the current values before quoting them.
