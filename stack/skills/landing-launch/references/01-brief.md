# 01 — Brief

Set the single context every phase will read: what the page must achieve, for whom, and with which real materials. Apply it once per page (any public marketing page) and reuse the site-level parts (market, language, brand voice, stack) on later pages.

## Input

- Approved design and stack (supplied by Visual Director or another source). This skill does not redesign.
- Whatever already exists in the repo, README, current copy or the page itself (in an audit, the URL).
- If `docs/decisions/` holds a decision record, read it for the stack, hosting and the data map instead of asking again.

## Decide

Ask only what is not already in the repo or the design; these are inputs and must not be assumed:

- **Jurisdiction / market**: country, EU, global or several. It drives phase 09 and part of phase 08.
- **Page language(s)**: affects keywords, `hreflang` and legal.
- **Traffic source**: organic SEO, ads, email, social, direct or word of mouth. It sets the visitor's awareness level (02) and how much SEO matters.
- **Constraints**: regulated sector (health, finance, legal), brand and tone, mandatory integrations (CRM, email, payments).
- If the goal or the page type is unclear, ask: they change which phases are skipped.

## Do

1. **Draft first.** Fill in the brief from the existing code, README and copy, and ask the user to correct it; this is faster than a questionnaire and avoids repeating questions.
2. **Single conversion goal** (contact, CTA, signup, purchase, waitlist). One page = one primary action; add secondary ones only if they do not compete with it, because every extra option weakens the decision (see 03).
3. **Page type**: lead capture/contact, SaaS signup or waitlist, product sold online, pricing/how-it-works/features, local service, event. It decides which phases are reduced or skipped (type table in SKILL.md).
4. **Real assets**: testimonials, figures, logos, cases, real photos, certifications. List what exists and mark the rest as a gap (`[NEED: …]`); a declared gap gets resolved, an invented one becomes a legal and trust risk.
5. **Single context document**, read by all the other phases. Store it where the project keeps its documentation, with a version and one changelog line per real change (a typo does not bump the version). Sections: product in one line; audience and main use case; problem or pain; alternatives (direct, secondary and "do nothing"); differentiation; objections and anti-persona; forces of change (02); customer's verbatim language; brand voice; proof; goal and conversion action.
6. **Interview** (if you need to ask):
   - Ask for the customer's literal phrases; they are worth more than polished descriptions.
   - Ask concrete questions ("what is the number 1 frustration that brings them here?") rather than generic ones.
   - Ask for examples, summarize and confirm section by section, and skip what does not apply.
7. Use personas with several buying roles only if the sale is B2B with several decision makers; otherwise one main audience is enough.

## Deliverable

- A versioned context/brief document with the sections above.
- Single goal, page type, jurisdiction, language(s), traffic source and constraints.
- List of real proof assets and of pending gaps.

## Verify

- Re-read the brief against the repo and the design: no data contradicts what already exists.
- Every gap is marked and assigned to whoever must supply it; no figure or testimonial in the brief lacks a source.
- The user has confirmed the goal and the page type.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| There is a single primary action | Page screenshot: one prominent primary CTA; the other links and buttons do not compete with it | High |
| The page type is defined and consistent with the content | Compare the declared (or inferred) type with the served structure | Medium |
| The jurisdiction and market are identified | Domain, language, currency, `hreflang` and published policy point to a specific market | High |
| The traffic source is known | Analytics, Search Console, ad UTMs or confirmation from the user | Medium |
| The page's proof has a real origin | Each testimonial, figure or logo matches a verifiable asset or data supplied by the user | Blocking |
| Information gaps are declared | `[NEED: …]` markers in the brief, or no unsupported claims on the page | Medium |
| A reusable context document exists | Brief file in the repo or documentation, with a version | Low |
| Sector constraints are identified | Presence or absence of regulated claims (health, finance, legal) in the served HTML | High |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move on to 02 without: single goal, page type, jurisdiction, traffic source and a list of real proof assets (or an explicit gap).

Sources: context-document framework adapted from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT: product-marketing); own judgment.
