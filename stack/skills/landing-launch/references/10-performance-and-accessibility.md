# 10 — Performance and accessibility

Measure, budget and fix speed (Core Web Vitals) and accessibility (WCAG 2.2 AA) once the page already has its form, analytics, banner and third parties; it applies to any public marketing page (landing, home, pricing, how it works). It is **page-level** (images, JS, CLS, accessibility of the flow) and **site-level** (hosting, compression, cache, CDN: done once and re-checked on later pages).

Index: [Input](#input) · [Decide](#decide) · [Do](#do) · [Deliverable](#deliverable) · [Verify](#verify) · [Audit](#audit) · [Gate](#gate)

This phase comes after 07, 08 and 09 because the form, analytics and consent banner weigh the most; measuring earlier gives a false baseline. 05-seo.md keeps the basic CWV thresholds; the method is here.

## Input

- Page implemented with the approved design, with its third-party scripts already defined: analytics and tags (08), banner/CMP (09), form (07), plus chat, maps, video or pixels if any.
- Hosting and CDN chosen. If the template or a visual builder limits what can be changed (headers, scripts, images), find out now: it determines which fixes are viable.

## Decide

Ask the user; do not assume:

- Which third parties are essential and which are removed (chat, maps, embedded video, ad pixels). Each one costs performance; the decision is a business one.
- Whether there is budget for real measurement (RUM) or Search Console + CrUX is enough.
- Accessibility target if it is not the standard: WCAG 2.2 AA is the reasonable default. If the applicable law requires an accessibility statement, it is decided in 09.

## Do

Order: baseline, budgets, LCP, CLS, INP, third parties, delivery, accessibility, monitoring.

### 1. Measure properly: lab vs field data

- **Field data** (real users; this is what counts): CrUX (28 days, Chrome only), PageSpeed Insights, the Search Console Core Web Vitals report or your own RUM. Evaluate the **75th percentile** of visits, separately for mobile and desktop, and pass only if **all three** metrics meet the threshold: LCP ≤ 2.5 s, INP ≤ 200 ms (> 500 ms is poor), CLS ≤ 0.1.
- **Lab data** (reproducible; for debugging and comparing before deploying): Lighthouse and WebPageTest. It does not predict INP (there is no real interaction; Lighthouse uses TBT as a proxy and can show a good TBT with a poor INP) or CLS shifts during scrolling or after interactions.
- A new page has no field data: CrUX needs enough traffic and 28 days. Until then, use lab data with a slow mobile profile and throttled network, test on a real low-end Android and run RUM from day one.
- Measure 3-5 times and use the median. Record the baseline (date, tool, device profile) so you can compare.
- The Lighthouse score is a summary, not the goal: the goal is field metrics and conversion.

### 2. Budgets

- Set limits and force optimizing, removing or not adding when a change exceeds them. Three types: **quantity** (JS, images, number of fonts and third parties), **user milestones** (LCP, TBT/INP, CLS) and **rules** (Lighthouse score).
- Old web.dev figures (3G network, Moto G4): under 170 KB of compressed critical-path resources, under 170 KB of JS on mobile, interactive in under 5 s on slow 3G. Take them as an order of magnitude, not a rule; TTI is no longer a primary metric (verify in the Lighthouse documentation).
- Starting point for a landing (hypothesis, adjust after measuring): total around 1-1.5 MB without video, compressed JS below ~150-200 KB unless necessary, one or two font families with few weights, a single main image in the hero.
- Enforce them on every deploy (Lighthouse CI, bundlesize or the bundler's features) so a regression fails the build. Without CI, manual review with the checklist in 11-qa-launch-iteration.md.

### 3. LCP (main element)

- Four parts, indicative proportions: TTFB (~40%), resource load delay (< 10%), load duration (~40%), render delay (< 10%). The delays should tend to zero.
- **Early discovery**: the LCP image with `src`/`srcset` in the HTML, not injected by JS or hidden in `data-src`; if it is a CSS background or a font, use `<link rel="preload">`; `fetchpriority="high"` on one or two images at most (if everything is a priority, nothing is); `fetchpriority="low"` off-screen.
- **`loading="lazy"` on the LCP image always makes it worse**: do not lazy-load the hero; it is the most repeated mistake of automatic implementations.
- **Paint early**: reduced or inline critical CSS; no synchronous scripts in `<head>` (`defer`); server-rendered or prerendered HTML (05 and 06 also require it); split long tasks.
- **Deliver fast**: `srcset`/`sizes`, AVIF/WebP, subsetted fonts and a `font-display` other than `auto`/`block`, CDN, long cache, no redirects.
- **TTFB**: HTML from the CDN edge and no unique parameters that defeat the cache.
- Shrinking the resource without touching render delay only moves the saving elsewhere; measuring only in local Lighthouse gives a false picture.

### 4. CLS (stability)

- Causes: images and videos without `width`/`height`, embeds and iframes without reserved space (including injected ones), fonts that reflow the text, banners, animations of layout properties.
- Fixes: `width`/`height` or `aspect-ratio` on all media; `min-height` for embeds (and keep the gap if they fail to load); fonts with `font-display: optional` or an adjusted fallback using `size-adjust`, `ascent-override`, `descent-override`, `line-gap-override`; animate with `transform`, not `top`/`left`/`box-shadow`; keep bfcache eligibility.
- **The cookie banner is an overlay or sits in reserved space, never pushing content**: it appears after paint and is the most common shift.
- In field data, CLS counts the whole life of the page (shifts within 500 ms of an interaction are excluded).

### 5. INP (responsiveness)

- It counts the slowest interaction of the visit. On a marketing page: menu, accepting or rejecting cookies, typing in the form, CTA, FAQ and accordions, price selector.
- Fixes: fewer long tasks on load, yield to the main thread (`setTimeout`), have the handler do only the visual update and defer saving and analytics, avoid layout thrashing, small DOM, `content-visibility` off-screen.
- Diagnosis: field data first (RUM or PageSpeed) to learn which interaction fails; reproduce it in the lab during load, when the thread is busiest; profile in DevTools. Fix the worst one and measure again.

### 6. Third parties (the biggest cost)

- web.dev rules: providers that ship less code; a budget for third parties; **one provider per function** (no two tag managers or two analytics tools); **no synchronous third-party JS on the critical path**; A/B test scripts hold back content even if asynchronous; avoid duplicate libraries from different embeds; **test third-party failure**, which can block rendering for 10-80 s (WebPageTest can simulate it).
- Usual techniques (verify in current documentation): `async`/`defer`, loading after consent or first interaction, **facades** (image + click) for video, chat and maps, self-hosting fonts and libraries (fewer connections and no transfer of the visitor's IP: see 09), `preconnect` only to critical origins, analytics and pixels after load and never blocking the CTA.
- Inventory: `script | purpose | weight | when it loads | cost in TBT/INP | can it be removed?`. Anything without an owner and a purpose is removed.

### 7. Delivery: server, cache, CDN (site-level)

- Brotli or gzip for HTML, CSS, JS and SVG; HTTP/2 or HTTP/3; modern TLS; CDN in front of the origin; images through the CDN with negotiated format and responsive sizes.
- Cache (web.dev): resources with a hash in the file name get `Cache-Control: max-age=31536000` (`immutable` is ignored by some browsers); **HTML with `no-cache`** (revalidates with ETag and gets a 304) so a deploy arrives right away; `no-store` only for what must never be stored; `public`/`private` depending on whether a CDN may store it.
- Common mistakes: omitting `Cache-Control` (the browser guesses), long lifetime on unversioned URLs (stale HTML or CSS after deploying), duplicate URLs for the same content, mixing stable and changing code in one file.
- Security headers are in 11-qa-launch-iteration.md.

### 8. Accessibility (WCAG 2.2 AA)

It is a reasonable target and also a legal risk (lawsuits in the US; an obligation for certain services in the EU, see 09). Automated analysis detects only part of the problems (30-40% is cited; one source says ~57%), so combine it with manual review.

- **Focus not obscured** (2.4.11): fixed headers, the cookie banner or chat must not cover the focused element. Tab and Shift+Tab with no traps, visible focus with good contrast.
- **Target size** (2.5.8): at least 24×24 CSS px or enough spacing; increase the padding, not the icon. Exceptions: inline links, an equivalent elsewhere, essential.
- **Contrast**: 4.5:1 normal text, 3:1 large text, also on hover and focus; no loss at 200% zoom and reflow at 320 px.
- **Forms**: a visible label associated with each field, errors announced (`aria-live`/`aria-describedby`), focus on the first error, correct input types and `autocomplete`.
- **Structure**: one H1, hierarchy without skipped levels, semantic elements, `lang`, informative `alt` (empty on decorative images), information never conveyed by color alone.
- **Motion**: respect `prefers-reduced-motion`; videos with captions; pausable carousels and animations. ARIA only when native HTML is not enough: misused, it makes things worse.
- The new 2.2 criteria are the ones that most escape automated analysis: one cited test detected 0 of 21 hidden-focus failures and 6 of 32 target-size failures.
- Test flow: axe, WAVE or Lighthouse; keyboard only; screen reader (NVDA on Windows, VoiceOver on Mac/iOS) on the main flow (arrive, understand, form, submit); 200% zoom and 320 px; measure touch targets in DevTools.

### 9. Monitoring

- RUM from day one or, at minimum, Search Console + CrUX once there is data; monthly review of field LCP/INP/CLS, mobile and desktop.
- Regression alerts in the pipeline and a new measurement after changing third parties, template or provider. Quarterly review: third parties, weight, images, typefaces, cache and compression.
- Before investing in tenths of a second, compare conversion by speed bracket (08).

## Deliverable

- Baseline report (tool, profile, date) and before/after result in lab data and, if it exists, field data.
- Agreed budgets and third-party inventory with a decision for each one.
- List of changes made and the accessibility test result (automated and manual) with pending items.

## Verify

- PageSpeed Insights and Lighthouse with a slow mobile profile, median of 3-5 runs; DevTools (Performance, Network) for the LCP element and long tasks.
- Inspect the served HTML: LCP image without `loading="lazy"`, with `fetchpriority`, `width`/`height` on media.
- `curl -I` on the HTML and on hashed resources to check compression and `Cache-Control`.
- Reload with the consent banner active: no content shift.
- Keyboard and screen reader on the main flow.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| LCP, INP and CLS within threshold (75th percentile, mobile) | Field data in PageSpeed Insights, CrUX or Search Console; without data, lab data with a slow mobile profile and median of 3-5 runs | High (Blocking if mobile performance is very poor) |
| The LCP image is discovered early and is not lazy-loaded | Served HTML without JS: `src`/`srcset` present, no `loading="lazy"`, `fetchpriority="high"` | High |
| No layout shift from media, fonts or banner | DevTools capture or recording (Layout Shift) with the banner visible; `width`/`height` in the HTML | High |
| INP: key interactions respond | RUM or PageSpeed for the slow interaction; DevTools profile of menu, cookies, form and CTA | Medium |
| Third parties inventoried, off the critical path and without duplicates | Network tab and HTML: synchronous scripts in `<head>`, two analytics tools or tag managers, inventory with owners | High |
| Third-party failure test | WebPageTest with the domain blocked: the page still paints | Medium |
| Budgets defined and checkable on every deploy | CI configuration or documented limits; actual weight vs budget | Medium |
| Correct compression and cache | `curl -I`: `content-encoding` br/gzip, `Cache-Control` on HTML and on hashed resources | Medium |
| Keyboard: no traps and visible, unobscured focus | Tab through the whole flow with the banner and fixed header visible; capture | High (Blocking if the form cannot be used with a keyboard) |
| Touch targets ≥ 24×24 px or with spacing | DevTools measurement of menu, CTA, banner close button and footer links | Medium |
| Contrast 4.5:1 / 3:1 and reflow at 320 px with 200% zoom | Contrast tool and capture at 320 px; no horizontal scroll | Medium |
| Accessible forms | Screen reader: labels, announced error, focus on the first error | High |
| Structure: one H1, hierarchy, `lang`, `alt`, `prefers-reduced-motion` | HTML inspection and reduced-motion emulation | Low |
| Continuous measurement active | RUM or linked Search Console and a scheduled monthly review | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Move on to 11 only if:

- LCP, CLS and INP are within threshold in lab data with a slow mobile profile, with no regression against the baseline.
- Budgets are defined and checkable.
- Third parties are inventoried and load off the critical path.
- Cache and compression are verified.
- Manual accessibility testing of the main flow is done with no blockers.
- RUM or its alternative is active.

Sources: web.dev (Web Vitals, Optimize LCP, Optimize INP, Optimize CLS, Third-party JavaScript, Performance budgets, HTTP cache, Lab and field data); WCAG 2.2 (W3C, https://www.w3.org/TR/WCAG22/) and a web search on its automated detection. web.dev figures verified on the Web Vitals page (updated Oct 2024); the "needs improvement/poor" thresholds were not listed except INP > 500 ms.
