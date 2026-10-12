# 11 — QA, launch and iteration

Verify everything before, during and after publishing a marketing page, and define how to improve it afterwards. It applies to any public page; **page-level** checks (content, form, SEO, conversion) are repeated for each one, while **site-level** checks (HTTPS, security headers, DNS, CDN, cache, monitoring) are done once and on the second page you only confirm they are still current.

Index: [Input](#input) · [Decide](#decide) · [Do](#do) · [Deliverable](#deliverable) · [Verify](#verify) · [Audit](#audit) · [Gate](#gate)

## Input

- Phases 01-10 met, with the page deployed to staging: brief (01), message and price (02), structure (03), copy (04), SEO (05) and AI search visibility (06), lead capture (07), analytics (08), legal and consent (09), performance and accessibility approved (10).
- Access to hosting, DNS, Search Console and analytics, and someone who can deploy and roll back.

## Decide

Ask the user:

- Launch date and window, and who responds if something fails.
- Whether the page replaces an existing one (which implies a 301 redirect map) or whether DNS is changing.
- Who receives uptime alerts and form notifications.
- Whether traffic volume allows an A/B test or the change is published directly (see Iteration).

## Do

### Readiness gate

Before QA, check three things: does the page do **one** thing (single goal, 01)? Would it be chosen and not just tolerated (clear proposition, 02-03)? Is it complete for that one thing, with no gaps in proof, legal or form? This is an adaptation of "Simple, Lovable, Complete" (Jason Cohen). If you keep polishing beyond that bar, publish; if you keep adding scope, cut.

Launch in three passes: before the switch, at the switch and the first two weeks, with a tested rollback.

### 1. Before publishing (staging)

**Content and links**
- Final copy: no lorem ipsum, "TBD", test prices or pending `[NEED: …]` placeholders (04, 09).
- Staging crawl with no broken links or missing images; real CTAs and contact details.
- Legal pages linked from the footer and the form, with the owner's details complete (09).
- Price, plans, timelines and contact match what sales and support say.

**Forms and conversion (07, 08)**
- Real submission of each form through to the database or CRM, the internal notification and the confirmation to the user, tested with Gmail and another provider, without landing in spam. This is the end-to-end test: a form that seems to work and does not deliver is the most expensive failure.
- Server-side antispam: a filled honeypot and an invalid token are rejected; a double submit creates a single record.
- The conversion fires on confirmed success (thank-you page or server event), not on the click.
- Analytics installed once, internal traffic excluded, no duplicate events; UTM and source reach the lead.
- Banner/CMP: with the banner not accepted, no non-essential cookie is written and there are no tracking requests (09).

**SEO (05, 06)**
- **Staging is `noindex` or behind a password and production is not.** Publishing with the staging `noindex` is the most common SEO failure on launch day; check the `X-Robots-Tag` header and the meta robots tag.
- Unique title, meta description, one H1; canonical to the production domain, not the staging one.
- `robots.txt` allows what is indexable and reflects the AI crawler policy; the sitemap lists production URLs.
- Structured data validated (Rich Results Test for Google features; Schema.org validator for the rest).
- Main content in the server HTML (source code, no JS).
- If it replaces a page or migrates: 301 map loaded and tested with a sample of old URLs.

**Experience**
- Works on a real mobile device, Safari and in-app browsers (LinkedIn, Instagram, Facebook).
- Open Graph: correct title and image when shared (each network's debugger). Custom, useful 404, favicon, `lang`.
- Performance and accessibility were already approved in 10; here repeat a quick check in **production** (lab LCP/CLS/INP, keyboard and screen reader on the main flow), because the CDN, cache and real scripts can change the result.

**Basic security (site-level)**
- HTTPS on all hostnames (www and apex), one redirecting to the other; valid certificate with automatic renewal.
- Headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` disabling what is unused, `frame-ancestors`/`X-Frame-Options`, CSP; remove `Server`/`X-Powered-By` with version. With Nginx use `always` so they are also sent on 404 and 500. Verify with a header analysis tool.
- **Deployment order**: HSTS and `nosniff` first; HSTS only once everything is HTTPS and with a moderate `max-age` at the start (it is hard to undo: the browser remembers it); CSP last, and first in "report-only" mode, because a strict CSP silently breaks analytics, fonts and forms.
- Secrets server-side only, no keys in the repository or in client JS; dependencies without known serious vulnerabilities.

**Rollback**
- You know how to roll back on the platform (promote the previous deployment, restore a backup) and someone has **tested** it once: an unrehearsed rollback is an assumption.
- If you change DNS: lower the TTL a day earlier and note the current records, including mail records (SPF, DKIM, DMARC). If they are lost in the switch, the form's email and the company's email start going to spam or bouncing.

### 2. At launch

- Deploy the redirects at the same time as the new page.
- Load the key pages and check content, title, canonical and a 200 status, with correct HTTPS on all hostnames.
- Repeat the check that production has no `noindex`.
- Submit a real form and confirm it reaches every destination and that the conversion appears in analytics.
- Submit the sitemap in Search Console and Bing Webmaster Tools; request indexing of the URL **once**.
- Enable the uptime alert for the URL and for the form endpoint.

### 3. The first two weeks

- Search Console: coverage, indexing and 404s daily the first week, then weekly; fix any missing redirects.
- Compare traffic and conversions with the previous period page by page, not just in total.
- Confirm that conversions reach each ad platform at the expected rate, cross-checking against the server (08).
- Repeat the full flow in production at 2-3 days and at one week (form, email, consent).
- Fix internal links that still point to redirected URLs and collect the failures reported by the team and users.
- Light AI search visibility audit (06) and a check that the page appears indexed with the intended title.
- Targeted legal review if any volatile source from 09 has changed since its verification.

### Recurring maintenance

- **Monthly**: field Core Web Vitals (10), broken links, certificate and domain expiry, form errors, consent, and new providers loading scripts.
- **Quarterly**: visible dates and figures (social proof, prices, "updated on…"), the privacy policy against the actual processing, volatile sources from 09, and content competing for rankings (05).

### Iteration: when to A/B test and when to publish

A reliable A/B test requires a sample, which depends on the base conversion rate, the minimum detectable improvement, and 95% confidence / 80% power. Visitors per variant (table from the source, indicative):

| Base conversion | 10% improvement | 20% improvement | 50% improvement |
|---|---|---|---|
| 1% | 150k | 39k | 6k |
| 3% | 47k | 12k | 2k |
| 5% | 27k | 7k | 1.2k |
| 10% | 12k | 3k | 550 |

Calculators: Evan Miller, Optimizely.

- **Skill rule (working hypothesis)**: if you cannot reach the sample in 4-6 weeks, do not test. Publish the change backed by qualitative input (5-10 users, session recordings, a short "what held you back?" survey) and measure before and after with caution. Sources give widely differing thresholds, from ~1,000 weekly visits to tens of thousands per variant: take them as indicative. A typical page rarely has that traffic.
- **If you test**: big changes (a 50% improvement needs ~1/10 of the sample a 5% one does), one hypothesis per test, few variants (each one splits the traffic), a fixed duration with a minimum of two full weeks, no peeking and stopping early, no changing the page or the traffic mix midway. A non-significant result is **inconclusive**, not a tie.
- **Hypothesis**: "Because [observation/data], we believe [change] will cause [effect] in [metric], because [reason]". One primary metric and one guardrail metric (e.g. lead quality).
- **Priority**: ICE score (impact, confidence, ease). First the biggest friction flagged in 03 (value proposition, headline, CTA, form, social proof), then price and order.
- **Typical mistakes**: a change that is too small, too many things at once, no hypothesis, stopping early, slicing segments until something turns up, over-interpreting the inconclusive. The figure "only 1 in 8 tests is significant" comes from a blog and is unverified.

## Deliverable

- Completed QA list with evidence per item and the date of each pass.
- Documented, tested rollback procedure, with the previous DNS and mail records noted.
- Security headers deployed (or an explicit decision on what is missing and why) and monitoring active.
- Maintenance plan (monthly and quarterly) and an agreed iteration criterion.
- Final summary: what is operational, decisions made, volatile facts verified and when, and pending items on third parties (lawyer, provider).

## Verify

- Link crawler on staging; `curl -I` and "view source" for `X-Robots-Tag`, meta robots, canonical, 200 status and security headers (with a header analysis tool).
- Real form submissions and a check of the destination; the analytics debug mode or real-time view to see the conversion.
- Network tab with the banner not accepted, to detect cookies or tracking requests.
- Search Console (indexing, 404s, sitemap) and each network's Open Graph debuggers.
- Tests on a real mobile device and in in-app browsers.

## Audit

Evidence per moment: before (staging), during (launch) and after (two weeks).

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Production without `noindex` and staging protected (before and during) | `curl -I` and production source: no `X-Robots-Tag: noindex` or noindex meta robots; staging with noindex or password | Blocking |
| End-to-end form (before and during) | Real submission: record in database or CRM, internal notification and confirmation email (captures, not in spam) | Blocking |
| Conversion in analytics on confirmed success, without duplicates | Event visible in real time after the real submission; a single event; a click without submit does not convert | High |
| Consent respected before accepting | Network with the banner not accepted: no non-essential cookies or tracking requests | Blocking |
| Canonical, sitemap and robots point to production | Source and `sitemap.xml`: production URLs; `robots.txt` according to the AI policy | High |
| 301 redirects (if migrating) loaded | Sample of old URLs with `curl -I`: 301 to the correct destination and a final 200 | High |
| HTTPS and security headers | Header analysis tool and `curl -I`: certificate, www/apex redirect, HSTS, nosniff, Referrer-Policy, also on 404 | Medium (High if HTTPS is missing) |
| Final copy and real data | Crawl and search for `[NEED`, lorem, "TBD"; broken links | High |
| Legal linked and complete | Footer and form link to the documents with the owner's details (09) | High |
| Tested rollback and DNS/mail records noted | Documented procedure, date of the test; SPF/DKIM/DMARC before and after the DNS change | High |
| Quick CWV and accessibility check in production | Lighthouse and keyboard on production against the baseline from 10 | Medium |
| Uptime monitoring of the URL and the form endpoint | Alert configuration and test notification received | Medium |
| Post-launch follow-up: indexing, 404s and conversions per page | Search Console report and comparison with the previous period | Medium |
| Sharing and in-app browsers | Open Graph debugger and a capture in LinkedIn, Instagram or Facebook | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Consider the page launched when all of these are met:

- The pre-launch list is complete, with evidence.
- Production has no `noindex`.
- Form and conversion are verified in production.
- Rollback is tested.
- The uptime alert is active.
- Follow-up for the first two weeks is under way, with an owner.

Sources: site QA checklist and launch readiness gate (adapted; product launches, Product Hunt and alpha/beta phases are discarded); A/B testing guide (sample table); web search on security headers and WCAG 2.2; Evan Miller and Optimizely (sample calculators). Adapted in part from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT: launch site QA, ab-testing).
