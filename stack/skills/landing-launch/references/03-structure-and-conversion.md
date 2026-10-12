# 03 — Structure and conversion

Decide the order of sections, the CTAs and which conversion models to apply, based on the message from 02, before writing the copy. This phase is page-level (each page has its own map); it applies to landing, home, pricing and how-it-works pages. Multi-page navigation is out of scope: only the minimal navigation of a single page is covered.

Index: Input · Decide · Do (models, structure, CRO rules, CTA data) · Deliverable · Verify · Audit · Gate

## Input

- Message, offer, awareness level, objections and price decision (02).
- Single goal, page type and traffic source (01).
- Approved design: here you only verify that it supports the structure; you do not redesign.

## Decide

- Which CTA is primary and which secondary action, if any, does not compete with it.
- Whether the page has full or minimal navigation (on ad pages, none).
- Where the form goes: above the fold with warm traffic, after the proof with cold paid traffic.
- What social proof really exists and where it goes; if none exists, how the gap is declared.
- If the structure requires a section the design lacks, go back to Visual Director and say so; do not improvise it.

## Do

### Models that change decisions

Of the roughly 80 psychology models in the source, only these change decisions on a marketing page. Treat them as heuristics, not laws.

| Model | Rule for the page |
|---|---|
| Hick's law | Fewer options, more decisions: one primary CTA, forms with the minimum fields, 3 price tiers rather than 7. |
| Fogg (motivation, ability, trigger) | If one is missing, there is no action: high motivation with high effort does not convert; something easy with no visible CTA does not either. |
| Activation energy | Make the first step trivial: prefill, templates, a quick win, a short form. |
| Anchoring | The first number seen conditions the rest: show the high, original or competitor price first. |
| Decoy / good-better-best | The middle tier is the target; the expensive one makes it reasonable and the cheap one anchors. |
| Default effect | Preselect the recommended plan. Never pre-checked consent boxes (09). |
| Paradox of choice | Present one option as "the best for most people". |
| Social proof | Customer counts, named testimonials, logos, reviews; numbers build trust. |
| Authority | Certifications, "as featured in", expert endorsements. |
| Reciprocity | Give value before asking (useful resource, free version). |
| Commitment / foot in the door | Ask for a small step (email, trial) before the big one. |
| Loss aversion | Frame what they lose by not acting, only with real data. |
| Regret aversion | Guarantee, free trial or "no lock-in" next to the CTA. |
| Pratfall effect | Admitting a limitation ("we are not the cheapest, but…") increases trust. |
| Curse of knowledge | What is obvious to you confuses a newcomer: test the copy with someone outside the industry. |
| Contrast / before-after | Show the "before" clearly so the "after" stands out. |
| Framing | "90% success" is not the same as "10% failure": frame positively with the same data. |
| Mental accounting | "$3/day" is perceived differently from "$90/month"; use it only if it is honest. |
| Zero-price effect | Free is psychologically different from cheap; going from 1 to 0 weighs more than from 2 to 1. |
| Hyperbolic discounting | Prioritize the immediate benefit ("start today") over the distant one. |
| Goal gradient / Zeigarnik | Visible progress and open tasks push people to finish (multistep, onboarding). |
| Mere exposure / similarity bias | Brand consistency; founder story, "made by X for X". |
| Pricing | Ending in 9 suggests value and round numbers suggest premium. Rule of 100: under 100 (any currency), "20% off" works better; over 100, "50 off" (an absolute amount) works better. |
| Scarcity | Only genuine (02-F). |
| AIDA | Page structure: attention, interest, desire, action. |

Problem to models:

- Low conversion: Hick, activation energy, Fogg.
- Price objection: anchoring, framing, mental accounting, loss aversion.
- Trust: authority, social proof, reciprocity, pratfall.
- Urgency: real scarcity and loss aversion.
- Decision paralysis: paradox of choice, default, nudge.

**Ethical limit.** Apply them honestly: scarcity and loss only if they are real, and never use defaults or urgency as a dark pattern. Otherwise the page breaks 02-F and may breach the consent part of 09.

### Structure: the order follows the reader's questions

Base sequence (SaaS and lead capture): hero (what it is, for whom, why it matters, plus CTA), brief social proof, problem, solution and features as benefits, how it works, testimonials or cases, price (if it applies), FAQ of 3-7 questions (the real objections from 02) and final CTA.

- The logic is hook, validate, explain, prove, enable, resolve doubts and convert. Putting the price before explaining the value, or the FAQ before the proof, breaks the flow; this claim comes from blogs without test data, so treat it as a heuristic.
- **Social proof**: a line or a logo bar in the hero or just below it, repeated next to the CTAs. Exception: if a recognizable figure carries the hero, the proof can go lower.
- **Length by awareness (02-B)**: more aware = short and offer-oriented; less aware = longer, with problem and education.
- Variants by type (validate them when implementing):
  - Product sold online: hero, purchase block, benefits, social proof, FAQ and upsell.
  - Lead capture with ads: no navigation, mobile first, a single CTA color and a form with the minimum fields.
  - Waitlist or launch: hero, email, proof or expectation and a short FAQ; short page.
  - Local service or SMB: what I do, where, proof (reviews, cases), process, visible contact (phone, map) and FAQ.
  - Pricing and how it works: the price or the process replaces "solution"; objections and the FAQ weigh more.
- Gap: the sources give little reliable guidance for webinars, app downloads and enterprise B2B; if one comes up, research separately and say so.

### Conversion rules (ordered by impact)

1. **Clarity of the value proposition** (highest impact): can someone tell what it is and why it matters in 5 seconds? The main benefit is specific and differentiated, and it is in the customer's words, not the team's. Common failures: feature-centered, too vague or too clever, saying everything instead of the most important thing.
2. **Headline**: communicates the core value, is specific (numbers, timeframes) and matches the traffic source. Patterns: "get [result] without [pain]", specificity and social proof ("10,000+ teams", only if true).
3. **CTA**: one primary action, visible without scrolling at 375 px width, with value copy ("Get my report" beats "Submit" or "Learn more"), repeated in hero, middle and end, with a clear hierarchy between primary and secondary.
4. **Visual hierarchy and scanning**: the message must come across at a glance and images support rather than distract. Visual Director sets the design; here you only verify it.
5. **Proof and trust**: logos, attributed testimonials with photo, cases with real figures, reviews and security seals where relevant; next to the CTAs and after benefit claims.
6. **Objections**: price and value, "will it work for me?", implementation difficulty and "what if it doesn't work?", resolved with FAQ, guarantee, comparison or process transparency.
7. **Friction**: too many fields, unclear steps, confusing navigation, unnecessary data, poor mobile experience, slow loading (measurement is in 10).

### CTA and navigation data (with caution)

- Removing navigation and using a single CTA is the majority advice. Figures cited by third parties: 1 CTA 13.5%, 2 CTAs 11.9%, 3+ CTAs 10.5% (Unbounce analysis of 18,639 pages, not verified at the source). The VWO case going from 3% to 6% after removing navigation comes from a single site and is the best case, not the typical one. Discard figures like "+266%": they contradict everything else.
- Sticky CTA on mobile: a study of 2,000 pages (Q4 2025 to Q1 2026) measured +11% with sticky alone, +6% with above-the-fold alone and +12% with both, so they do not stack. Use sticky only if the page exceeds ~2 screens; on short pages it is unnecessary.
- Mobile versus desktop conversion rates vary widely by source: do not set absolute benchmarks, measure your own (08).

## Deliverable

- Section map: order, function and the reader question each section answers.
- CTA map: primary, secondary and placements.
- List of proof and objections assigned to sections, with gaps marked.
- List of "quick wins" versus "high-impact changes".
- Hypotheses to test: they run only after launch, in phase 11.

## Verify

- 5-second test: show the hero to an outsider and check that they can explain what it is and who it is for.
- Screenshot at 375 px: primary CTA visible without scrolling.
- Count the CTAs and links that compete with the primary action.
- Walk the map against the objections list from 02: each one has a section or an answer.
- Confirm that the design has every section in the map.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| The value is understood in 5 seconds | Hero screenshot and a test with someone outside the industry | High |
| There is a primary CTA visible without scrolling on mobile | Screenshot at 375 px width, no scrolling | High |
| A single primary action; secondary ones do not compete | Count of CTAs and links in the served HTML, and their visual weight | High |
| The CTA copy is value-based, not generic | Button text in the HTML ("Submit", "Learn more" are failures) | Medium |
| The section order follows the reader's questions | Section map extracted from the page versus the base sequence | Medium |
| The main objections are resolved | Compare the objections from 02 with the FAQ, the guarantee and the sections | Medium |
| Social proof near the hero and the CTAs | Screenshot; logos or testimonials present near each CTA | Medium |
| All social proof is real and attributable | Check each testimonial, figure and logo with the user or a public source | Blocking |
| No fake scarcity, urgency or fabricated figures | Reload at different times; check timers and spots against real data | Blocking |
| No pre-checked consent boxes | Inspect the form in the HTML (`checked` on consent boxes) | High |
| The sticky CTA exists only if the page is long | Page height on mobile (over ~2 screens) and presence of the fixed element | Low |
| Length fits the traffic's awareness | Compare page length with the level from 02 | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move on to 04 without an approved section map and a defined primary CTA. If the structure requires sections the design lacks, go back to Visual Director.

Sources: Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT: marketing-psychology, cro, signup, popups); Digital Applied, 2,000-page study (https://www.digitalapplied.com/blog/landing-page-conversion-study-2000-pages-tested-2026); Colorlib (https://colorlib.com/wp/landing-page-statistics/); 21st.dev (https://21st.dev/blog/landing-page-sections); involve.me (https://www.involve.me/blog/landing-page-structure); Unbounce analysis and VWO case, cited via third parties.
