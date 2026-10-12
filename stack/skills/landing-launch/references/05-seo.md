# 05 — SEO

Make a public marketing page crawlable, indexable and well marked up for search engines. It covers page-level items (title, headings, canonical, page schema) and site-level items, done once (robots.txt, sitemap, Search Console, organization schema); on the second page, check that the site-level items exist and are still current.

Index: Input · Decide · Do (1 crawling and indexing, 2 technical and speed, 3 on-page, 4 schema, 5 conditionals, 6 new page) · Deliverable · Verify · Audit · Gate

## Input
- Main keyword and search intent, and cannibalization map (phase 02-E).
- Approved copy with provisional title and meta description (phase 04).
- Stack and hosting (phase 01); market and languages from the brief.

## Decide
- **Non-organic traffic** (ads, email): this phase shrinks to correct indexing or a deliberate `noindex`. Pages duplicated per segment for ads get `noindex` or a canonical to the main page; decide it with the user.
- **Multilanguage or multiregion**: does the brief flag it? If so, apply block 5.
- **Local service**: is the page type local service? If so, apply the local business part of block 5.
- Pages at scale by variants (programmatic SEO) are outside this skill.

## Do
Priority: 1) crawling and indexing, 2) technical base and speed, 3) on-page, 4) content quality, 5) authority. What is not indexed does not rank, so do not polish the title of a blocked page.

### 1. Crawling and indexing
- Site-level: `robots.txt` without accidental blocks and with a reference to the sitemap; sitemap with only canonical, indexable URLs, submitted to Search Console. The AI crawler policy is decided in 06 and reflected in this same `robots.txt`.
- Look for a stray `noindex` (typical: inherited from a staging environment), redirect chains and soft 404s.
- Self-referencing canonical; HTTPS, www/non-www and trailing slash consistent, with a single accessible version.
- The main content must be in the server HTML, not only after running JS: it affects Google and even more the AI agents (06).
- After publishing, request indexing once in Search Console and do not repeat it. If it is still not indexed after a few weeks, diagnose the cause instead of resubmitting.

### 2. Technical and speed
The measurement method, budgets and fixes are in 10; the thresholds and basic rules stay here.
- Core Web Vitals: LCP < 2.5 s, INP < 200 ms, CLS < 0.1. Measure with PageSpeed Insights and the Search Console field data, not only in the lab: the lab does not reflect real users.
- Images: WebP/AVIF, explicit dimensions (they prevent CLS), lazy loading except the hero image (deferring it delays LCP) and preload of the LCP image; fonts loaded in a way that does not block rendering.
- Mobile first: viewport, tap targets, no horizontal scroll, same content as on desktop.
- HTTPS everywhere, no mixed content, HTTP to HTTPS redirect.
- The CTA and the headline must not depend on JS hydration.
- Readable URL, lowercase with hyphens and stable (do not change the slug for a year or number).

### 3. On-page
- **Title:** ~50-60 characters (Google truncates by pixels; put the important part in the first 50), main keyword at the start, a reason to click (result, scope, format) and the brand at the end only if it adds something. Pattern for a product or service: `[Category] for [Audience] | [Brand]`. Unique and aligned with H1, slug and meta description.
  - Before writing it, search the target query: titles that already rank show format, expected words and the differentiating gap.
  - Google rewrites the title if it is too long, repetitive ("| Brand | Brand"), generic ("Home") or contradicts the H1.
  - Promise "free", a year or a number only if the page delivers it.
- **Meta description:** ~150-160 characters, unique, with a value proposition and an invitation to act. It is not a direct ranking factor; it affects the click. Google may rewrite it.
- **Headings:** one H1 with the proposition and the keyword if it fits naturally; hierarchy without skips; do not use headings only for styling. Make the H2s reflect the questions from 03 (this also helps 06).
- **Content:** keyword in the first stretch, related terms used naturally, the intent from 02-E answered better than in the current results. No keyword stuffing.
- **Images:** descriptive file names, descriptive `alt` (empty on decorative ones), compressed, dimensions declared.
- **Internal links:** if the page is inside a site, link to it from at least 3 relevant pages with descriptive anchor text; it is the most underrated lever on a new page and prevents an orphan page.
- **Cannibalization:** confirm that no other URL on the site competes for the same intent.
- **Open Graph and Twitter Card:** `og:title`, `og:description`, `og:image` (~1200×630), `og:url`, `twitter:card`.
- **Favicon and `lang` on `<html>`**; `theme-color` optional.

### 4. Structured data
- JSON-LD in `<head>` or at the end of `<body>`, server-rendered, matching the visible content; combine types with `@graph`.
- Site-level: `Organization` (name, url, logo, `sameAs`, contact) and `WebSite` (site name). Page-level, as applicable: `Product` or `SoftwareApplication` with `offers` if the price is visible, `LocalBusiness` if local service, `Event` if webinar or event, `BreadcrumbList` only with visible breadcrumbs, reviews or ratings only if real and visible.
- **Before implementing any type, check Google's current gallery** ([structured data](https://developers.google.com/search/docs/appearance/structured-data/search-gallery)): being valid in schema.org does not imply eligibility for a rich result. The verified gallery lists Organization, Product, Local business, Software app, Event, Review snippet and Breadcrumb; FAQ and HowTo are not listed.
- According to the source repo (not verified): FAQ rich results were removed in 2026, HowTo in 2023 and `WebSite/SearchAction` (sitelinks search box) in 2024. Resolution on FAQPage: what matters is the FAQ visible in the HTML; marking it with `FAQPage` is optional and neutral, and no rich result is promised. If a type is not in the gallery, do not sell it as an SEO improvement.
- Typical errors: missing required properties, dates not in ISO 8601, non-absolute URLs, inexact enumerations, marking up content that is not on the page.
- Minimal page example with `@graph`:
```json
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","@id":"https://example.com/#org","name":"Brand","url":"https://example.com/","logo":"https://example.com/logo.png","sameAs":["https://www.linkedin.com/company/brand"]},
 {"@type":"SoftwareApplication","name":"Product","applicationCategory":"BusinessApplication","operatingSystem":"Web","offers":{"@type":"Offer","price":"29.00","priceCurrency":"EUR"}}
]}
```

### 5. Conditionals
- **Multilanguage or multiregion:** `hreflang` with a self-referencing entry and reciprocal return links; valid codes (`en-GB`, never `en-UK`) and `x-default`; each version with its own canonical (never a cross-language canonical) included in the hreflang set; same protocol and domain in canonical, hreflang and sitemap; prefer subdirectories (`/es/`, `/en/`); translate all the main content, not only the template; do not redirect by IP or `Accept-Language` (Googlebot does not send that data and would not see the other versions).
- **Local business:** NAP (name, address, phone) consistent everywhere, `LocalBusiness`, Google business profile, reviews and a location page.

### 6. New page and after publishing
- Checklist: links from 3 relevant pages, unique title and meta aligned with the query, an H1 aligned with the title, self-referencing canonical, present in the sitemap, schema where applicable, content in server HTML, indexable and connected to the conversion path.
- If it ranks in positions 8-20, make a minimal adjustment: answer the query in the first two sentences, add the missing section (do not rewrite), link from strong pages and update what is outdated. With a low CTR, change only the title and description and measure for 3-4 weeks. If two rounds move nothing, the limit is the intent or the authority, not on-page. The iteration method is in 11.

## Deliverable
- Final title, meta description, H1 and slug, aligned.
- Correct canonical, `robots.txt` and sitemap (site-level, if they did not exist).
- Validated JSON-LD, with the types justified.
- Open Graph and Twitter Card, favicon and `lang`.
- Internal link plan toward the page.
- Indexing decision (indexable or deliberate `noindex`).

## Verify
- `view-source` or `curl` of the URL: the main content, title, meta, canonical and H1 are in the served HTML; no `noindex` or `X-Robots-Tag`.
- URL Inspection in Search Console: indexable and the canonical chosen by Google equals the declared one.
- Rich Results Test (renders JS) and validator.schema.org. `curl` does not detect JSON-LD injected by JS: in the rendered DOM, `document.querySelectorAll('script[type="application/ld+json"]')`.
- PageSpeed Insights and the Search Console Core Web Vitals report; Open Graph debugger; Bing Webmaster Tools (it also feeds Copilot; see 06).

## Audit
| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| The URL is indexable (no `noindex`, not blocked in robots.txt, real 200) | `curl -I` and `view-source`: status code, `X-Robots-Tag`, meta robots; robots.txt rule | Blocking |
| Self-referencing canonical and a single URL version | `rel=canonical` tag in the served HTML; the http/www/slash variants redirect to it | Blocking |
| Main content (headline, CTA, text) in the served HTML without JS | `curl` of the URL or `view-source`: the headline and the CTA appear in the initial HTML | High |
| Title, meta description and H1 unique and aligned with the query | Quote the three texts, their lengths and compare with the keyword from 02-E | High |
| Core Web Vitals on mobile within threshold | PageSpeed Insights or Search Console field report screenshot with LCP, INP and CLS | High |
| Sitemap contains the URL and only canonical indexable URLs; robots.txt references it | Download of `/sitemap.xml` and `/robots.txt`; status in Search Console | High |
| Schema valid, matches the visible content and the type is in Google's gallery | Rich Results Test result and comparison with the rendered page | Medium |
| Hero image without lazy loading and with dimensions; the rest with `alt` | Inspection of the HTML of the hero and the images (loading, width/height, alt) | Medium |
| Internal links from at least 3 pages and no cannibalization | Search for inbound links in the site crawl and for other URLs with the same intent | Medium |
| Open Graph and Twitter Card complete | Sharing debugger output with title, description and image | Low |
| `lang` on `<html>`, favicon, correct hreflang if multilanguage | `<head>` inspection; validation of reciprocal hreflang pairs | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate
Move on to 06 only with: indexable URL and correct canonical, content in the server HTML, title, meta and H1 aligned, Core Web Vitals within threshold on mobile, schema validated and matching the content, and correct sitemap and robots.txt.

Sources: seo-audit skills (with title-tags, rankings-push, international-seo and local-seo) and schema adapted from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT); [Google structured data gallery](https://developers.google.com/search/docs/appearance/structured-data/search-gallery) (Google Search Central).
