# 06 — AI Search Visibility

Make agents and answer engines (ChatGPT, Claude, Perplexity, Copilot, AI Overviews) able to reach the page, read it, extract its claims and cite them accurately. It is a layer on top of 05, not a substitute. Site-level, once: crawler policy, `robots.txt`, sitemap, `llms.txt`, external profiles. Page-level: extractable blocks, readable price, paste test. It applies to any public marketing page; it weighs more on pricing and on signup or product pages.

Index: Input · Decide · Do (stance, A access, B extraction, visibility audit) · Deliverable · Verify · Audit · Gate

## Input
- Indexable page, with content in the served HTML, canonical and valid schema (phase 05).
- Copy with visible FAQ (04) and, if there is a price, the price decision from 02-G.
- Positioning and category "shelf" (02-A).

## Decide
- **Stance on model training:** allow or block `GPTBot`, `ClaudeBot` and similar? It is the publisher's decision; ask it. Blocking training does not imply blocking citations.
- **Appearing in AI answers:** does the user want to be cited in AI search engines? If so, allow the search and retrieval crawlers (see the policy below).
- **`llms.txt` and `/pricing.md`:** optional; only if someone will keep them up to date.

## Do

### Stance (verified in Google Search Central)
- For AI Overviews and AI Mode, Google says SEO practices still apply: it requires no special markup, AI text files, Markdown, chunking the content or writing separate content for AI. Creating many pages per query variant to manipulate results may violate its scaled content policy. `llms.txt` is harmless, but Google Search ignores it. Distrust "AEO/GEO" tools that promise rankings.
- The other engines and the agents that compare or buy do reward extractable structure and machine-readable pages.
- Rule: write for people and organize clearly. Good organic ranking remains the best predictor of AI visibility.
- Do not use figures such as "+30-40% visibility" (GEO study, 2023) or per-platform shares as a promise: they are dated data from a specific sample.

### A. Can an agent reach and read the page?
- **Access:** headline, price, CTA and FAQ are in the initial HTML, because most agents do not run JS. Real HTTP status codes, no soft 404s, stable canonicals. Check that no bot challenge, WAF or CDN blocks legitimate AI crawlers by default: many sites block them without having decided to, and `robots.txt` does not reveal it.
- **Crawler policy by purpose** (site-level; do not paste a permissive list wholesale):
  - Discovery and search, allow if you want to appear in answers: `Googlebot`, `Bingbot`, `OAI-SearchBot`, `PerplexityBot`, `Claude-SearchBot`.
  - Retrieval on user request: `ChatGPT-User`, `Claude-User`, `Perplexity-User`. Behavior with respect to `robots.txt` varies by provider; to manage ChatGPT Search use `OAI-SearchBot`, not `ChatGPT-User`.
  - Training (publisher's decision): `GPTBot`, `ClaudeBot`.
  - `Google-Extended` controls certain Gemini uses (training and grounding); it does not affect inclusion or ranking in Google Search.
  - Names and their consequences change: verify in each provider's current documentation (OpenAI, Anthropic, Perplexity, Google) before writing `robots.txt` and state the verification date.
  - Reflect the same decision in the WAF or CDN rule, not only in `robots.txt`.
- **Discovery:** a sitemap that loads and parses. `llms.txt` is optional and cheap (it does not help Google, it does help some agents); `llms-full.txt` is emerging.
- **Parseability:** valid JSON-LD (05), one H1, headings that answer sub-questions, extractable answer blocks (B). Use semantic markup (`main`, `nav`, `article`, `button`) and accessibility (labels, `alt`): agents read the accessibility tree like a screen reader.
- **Emerging, do not promise it:** Markdown representation via content negotiation (`Accept: text/markdown`) or a `Link` header; WebMCP (form actions or CTAs as tools). Useful today: the primary CTA and the form work without JS-only flows, with labeled fields and a machine-readable confirmation (07).
- **Quick measurement:** free "agent readiness" tools (e.g. `npx is-agentic domain`, Frase's checker) come from vendors; the checks are worth it, not the pitch.

### B. Can a model extract and cite the content?
- **Every key claim stands on its own:** models extract passages, not pages. Define what the product is in the first sentence of the hero or right below it, using the category's words.
- **Extractable blocks:** definition ("what is it"), steps (how it works), comparison table only if it applies and is honest, pros and cons, FAQ with natural-language questions, a figures block with source and date. Short answers (~40-60 words) at the start of each section.
- **Citable credibility:** figures with a named source and date, quotes with name and title, an identifiable company or author with contact details, a visible and real last-updated date. Keyword stuffing worsens visibility.
- **Freshness:** review the page at intervals and show the real date; changing the date without changing the content deceives the reader and the models.
- **Readable price** (from 02-G): numbers in HTML text, limits per tier in words, FAQ on cancellation, trial and limits, `Offer` in schema, no "Contact us" on every tier. Paste test: ask an AI with browsing "what plans and prices does [URL] have?"; if it fails, agents cannot read it either. Optional: `/pricing.md` with prices in a simple format, consistent with the page; if it falls out of date it is worse than not having it.
- **Consensus and entity** (off the page, but decisive): third-party profiles (reviews, directories, social networks, Crunchbase, LinkedIn, Google Business Profile if applicable) describe the business with the same segment and positioning as the page; models look for consistency. If the AI describes the product wrongly, the page that should say it does not say it clearly: fix it first.
- **Bing:** register the site in Bing Webmaster Tools (it feeds Copilot; that ChatGPT Search relies on a Bing-like index is a claim from the source repo, not verified) and consider IndexNow for fast indexing.

### Visibility audit (post-launch, lightweight)
List 10-20 queries that change revenue (not a glossary), worded the way a person types them: problem queries, solution or category queries ("best X for Y"), product queries ("[brand] vs [competitor]", "is [brand] good for…?") and decision queries ("[brand] price", integrations). Test them in Google (AI Overview), ChatGPT with search and Perplexity. Note whether you are cited, what they say about you and whether it is correct, and which sources they cite. Repeat each query several times, because results vary. If they say something wrong or something is missing, fix the page that should explain it; if you do not appear, the cited sources are your list of presence targets. Search Console has a generative AI performance report (according to Google's guide): it uses standard metrics.

## Deliverable
- Crawler policy decided, written in `robots.txt` and in the WAF/CDN rule, with the verification date of the names.
- Correct sitemap; `llms.txt` if decided.
- Extractable blocks and visible FAQ on the page.
- Price readable in text (if any) and the paste test result.
- Query list for the later visibility audit.

## Verify
- `curl -A "<agent>"` or the equivalent tool against the URL and `/robots.txt` with the policy's user agents: 200 response with the content, no bot challenge.
- `view-source`: headline, price, CTA and FAQ present without JS.
- Paste test with an AI with browsing on the public URL.
- Review the WAF/CDN rule against the list of allowed crawlers.
- Validate the sitemap and the JSON-LD (05).

## Audit
| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Key content (headline, price, CTA, FAQ) in the served HTML | `curl` of the URL: the texts appear without running JS | Blocking |
| The crawler policy exists and is deliberate | Downloaded `robots.txt` against the stance declared by the user; no list pasted wholesale | High |
| The WAF/CDN does not block allowed crawlers | Request with each allowed crawler's user agent: 200 status, no challenge | High |
| Crawler names verified in current documentation | Link to each provider's documentation and verification date | Medium |
| Sitemap loads, parses and is referenced in `robots.txt` | Sitemap download and `Sitemap:` line in `robots.txt` | Medium |
| Extractable blocks exist: opening definition, steps, visible FAQ | Screenshot or quote of each block in the served page | Medium |
| Price readable in text and paste test passed (if there is a price) | An AI with browsing's answer to "what plans and prices does [URL] have?" against the real price | High |
| Real update date and figures with source and date | Visible date against the change history; figures with a named source | Medium |
| External profiles consistent with the page's positioning | Comparison of the descriptions on LinkedIn, directories and reviews with the hero | Low |
| Site registered in Bing Webmaster Tools | Screenshot of the verified property | Low |
| No promises of markup or files "for AI" as a Google factor | Review of what was implemented against Google's guide; `llms.txt` marked as optional | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate
Move on to 07 only with: key content in the served HTML, crawler policy decided and reflected in `robots.txt` and WAF/CDN, correct sitemap, extractable blocks and FAQ visible, price (if any) readable in text, and the paste test passed or its limitation declared.

Sources: Google Search Central guide on AI features in Search (AI Overviews and AI Mode); adapted in part from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT): ai-seo with agent-readiness and platform-ranking-factors, and the pricing-page teardown; current OpenAI, Anthropic, Perplexity and Google documentation on their crawlers (consult before fixing names).
