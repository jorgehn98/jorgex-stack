# 08 — Analytics

Define what to measure, with which tool, and how to guarantee that the recorded conversion is real. It is site-level for the tool, the consent and the account (done once) and page-level for the event plan and the source fields. It applies to any public marketing page; a landing page needs few events.

## Input

- Single goal and jurisdiction (01).
- CTA and sections (03), to know which clicks to measure.
- Submission and thank-you page or success event (07).
- Site-level, if it already exists: installed tool, banner and event plan of other pages.

## Decide

Order within the phase, because each step conditions the next: decisions the measurement will inform, tool and consent, event plan, implementation, validation and tracking view. If a data point does not change a decision, do not measure it.

Ask the user:

- **Ads**: will there be Google or Meta with remarketing or conversion optimization? It is the factor that weighs most in the tool choice.
- **Jurisdiction** (01) and **who will look at** the data and how often.
- **Tool**:
  - Cookieless analytics (Plausible, Fathom, Umami and similar, or self-hosted alternatives): less data and, if local law and configuration allow it, no banner.
  - GA4: powerful, free and essential if conversions are imported into Google Ads; requires consent in the EU/UK and Consent Mode management.
  - Default (skill hypothesis, not a rule): with no paid ads and a simple goal (contact/signup), cookieless analytics; with Google ads in the EEA, GA4 with Consent Mode v2 and a CMP.
  - Do not install both just in case: each tool adds weight, consent and maintenance.
- **Conversion value**: assign an estimated value per lead only if you will optimize ads or compare sources; otherwise do not invent it.

## Do

### Consent and analytics (bridge to 09)

- No tag that writes or reads device storage loads before consent where the law requires it. Check with the banner untouched, in the Network and Application tabs.
- **"Cookieless" is not "consent-free"**. Claims that a tool needs no consent come from vendors or blogs, not from a regulator; no EU authority has certified them in general (the CNIL has approved one specific Matomo configuration, with conditions). Verify in the guide of the country's authority (AEPD, CNIL, ICO) before stating it, and mention the tool in the privacy policy even if it is exempt. No official source from the AEPD or Cloudflare was found on Cloudflare Web Analytics: treat it as not verified.
- **Consent Mode v2** (Google), if there are ads or measurement with Google products for EEA/UK users. The enforcement dates (March 2024, stricter enforcement in 2025) come from vendor sources: open Google's documentation and check the current status.
  - **It does not collect consent**: the banner (CMP) collects it; the mode only passes the answer on.
  - Four signals: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`. **Denied** by default for EEA/UK visitors, set **before** any Google tag loads; if set afterwards, the first visit is measured without respecting the choice.
  - **Basic**: tags do not load until consent and there is no modeling. **Advanced**: tags load with denied signals and send cookieless pings, which allows conversion modeling; its legal basis is disputed, so decide it with legal advice and reflect it in the policy.
  - A Google-certified CMP emits the signals correctly and is recommended for ads in the EEA (how strict the requirement is varies by source).
  - Single-source data, not verified: changes in June 2026 to Google Signals and `ad_storage`. Check before implementing.
- No personal data (email, name, phone) in event properties or URLs: it ends up with a third party and is hard to delete. Configure retention and user deletion if the tool allows it.

### Event plan

Format: `event | description | properties | trigger | notes`. Lowercase names with underscores, object_action and specific (`cta_hero_clicked`, not `button_clicked`); context goes in properties. Keep the names the vendor defines for recommended events (`generate_lead`, `purchase`). Document the plan: it is what whoever maintains the page reads.

| Event | When | Properties |
|---|---|---|
| `page_view` | load (automatic) | page_location, page_referrer |
| `cta_clicked` | click on primary or secondary CTA | cta_location (hero/middle/final/sticky), button_text |
| `form_started` | first focus in the form | form_name |
| `form_error` (optional) | failed validation | form_name, error_type |
| `form_submitted` / `contact_submitted` / `signup_completed` / `demo_requested` | server-confirmed success or thank-you page load (07) | form_name, source |
| `scroll_depth` (optional) | 50 / 90% | depth |
| `outbound_link_clicked` (optional) | WhatsApp, phone, email, calendar | link_type |

- **The conversion is the confirmed success, not the button click**: a click that fails validation or the antispam would inflate the figure and misalign the campaigns that optimize on it.
- Direct contact (phone, WhatsApp, `mailto`) is measured as its own click event; it is an approximate conversion, because the click does not guarantee the call.
- For a marketing page, drop onboarding, product usage, subscription and cart events.

### Visitor source (UTM as hidden fields)

- On the first visit, capture `utm_source/medium/campaign/content/term`, `gclid`/`fbclid` if there are ads, the `referrer` and the landing page, and **send them as hidden fields with the form** (07), so the lead reaches the CRM with its source. Without this, the source is lost between the visit and the submission. If you store it in your own storage, it is subject to consent where applicable.
- UTM convention: lowercase, consistent separator, specific names (`blog_footer_cta`, not `cta1`) and a documented sheet. Do not put UTMs on the site's own internal links: they restart the session and falsify the source.
- **Self-reported attribution**: optional "How did you hear about us?" field (free text or list with "other"). It is the strongest signal for word of mouth, podcasts and communities, which tracking does not see; weigh it.
- Do not add up the conversions each ad platform reports: the source of truth is the real number of submissions or sales on the server, and platforms are checked against it.
- "Direct" and branded search are not channels: they are where demand created elsewhere gets collected.
- With low volume, multi-touch attribution is not reliable: UTMs, self-reported attribution and the CRM as the truth are enough.

### Implementation (points an AI usually gets wrong)

- Load the script after consent where applicable and without blocking render (it affects LCP; see 10). A single container or tag; avoid GTM with 3-5 events (more weight and surface) and use it if there are several pixels and a non-technical marketing team.
- **Duplicate events**: typical with client-side navigation (SPA), re-renders or two containers. Each submission must count once.
- **GA4**: custom parameters do not appear in reports until you create the custom dimension (data after 24-48 h); mark the event as a key conversion and choose the counting (once per session for leads); enable enhanced measurement with judgment, because it can fire unwanted events; exclude internal and development traffic; do not measure pre-production in the same property.
- Blockers and browsers with built-in protection hide part of the traffic (indicative: 10-30%, depending on the audience). That is why the source of truth for leads is the server. Server-side tagging only if it pays off, not by default.
- Link GA4 with Search Console and, if there are ads, with Google Ads (auto-tagging and conversion import).

## Deliverable

- Chosen tool and its consent impact, documented for 09.
- Approved event plan, with the conversion defined as confirmed success.
- Source capture (UTM, `gclid`, referrer) traveling all the way to the lead.
- Minimum tracking dashboard: visits by source/medium/campaign, conversion rate (confirmed submissions divided by visits) by source and device, form abandonment (start versus submission), clicks by CTA and location, field CWV on mobile, Search Console organic queries and lead quality in the CRM.
- Review cadence: weekly the first month, monthly after that. Do not change the page based on a few days of data: with low traffic the rates are noise (iteration decisions in 11).

## Verify

- Each event fires on its trigger, with correct properties and exactly once; on real mobile and several browsers.
- The conversion is recorded after a real submission, and not after a rejected one.
- No personal data in properties or URLs.
- With the banner untouched, no analytics or advertising cookie written and no tracking request to third parties (where required).
- With consent denied, Consent Mode sends what is expected.
- Tools: GA4 DebugView (`?debug_mode=true`), Tag Assistant or GTM preview, Network and Application tabs, real-time report (up to ~30 min delay), Search Console.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Without an accepted banner, no analytics or advertising is written | Cookies and storage in the Application tab, and third-party requests in Network, after loading with the banner untouched (EU/UK) | Blocking |
| The conversion is counted on confirmed success | Valid submission and rejected submission in DebugView/Network: only the valid one fires the event | High |
| There are no duplicate events | One submission in DebugView or Network: a single event; a single container in the served HTML | High |
| Consent Mode with denied default state (if Google is used) | `gtag('consent','default',…)` before the tags in the HTML; signals in Tag Assistant | High |
| The source reaches the lead | Visit with a test UTM, submission and check of the hidden fields in the CRM/database record | High |
| There is no personal data in events or URLs | Payloads in Network and thank-you page URLs | High |
| Event plan documented | Plan document with names, properties and triggers | Medium |
| A single tool and no internal traffic | Tags present in the served HTML; internal-traffic filter in the configuration | Medium |
| UTMs follow a convention and there are no internal UTMs | UTM sheet and internal links in the served HTML | Low |
| Self-reported attribution exists | "How did you hear about us?" field in the form | Low |
| "No consent needed" claims are verified | Reference to the authority's official guide, or the tool is listed in the policy as not verified | Medium |
| A tracking dashboard exists | Report view with the minimum metrics | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to 09 without: chosen tool and its consent impact documented, approved event plan, conversion defined as confirmed success, UTM and source traveling to the lead, and completed validation (including the test with the banner untouched).

Sources: Google documentation (GA4, Consent Mode, Tag Assistant); CNIL, AEPD and ICO guides on audience measurement; own judgment. Adapted in part from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT: analytics, attribution).
