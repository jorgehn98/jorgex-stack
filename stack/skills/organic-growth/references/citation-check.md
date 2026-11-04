# Citation check

Whether assistants name the brand can be measured. How precisely is the honest part.

Model versions change under the same name, answers vary between runs, and locale and personalization shift results. So the output is a **log of what happened** — prompt, model, date, verbatim answer — never a single "visibility score" that implies precision the data does not support. A score that moves because the model was updated, not because the site changed, is worse than no score.

## The ladder

Appearing is not one outcome but five rungs. Each has different selection criteria and a different business meaning:

| Rung | What it means | What governs it |
|---|---|---|
| **Read** | The model retrieved the page while building the answer, without citing it | Crawlability, parseable structure, relevance |
| **Cited** | The page appears as a source in the answer | Usefulness of the content: structure, facts, clarity, freshness |
| **Mentioned** | The brand is named in the answer text | Entity recognition and how the web talks about it |
| **Recommended** | The brand is on the shortlist the buyer would consider | What reviews, press, communities and profiles say, mostly off the site |
| **Recommended against** | The model names the product as one to avoid for that use case | Weak or contradictory third-party consensus, a real limitation, a stale claim |

Record the **tone** of the mention too: favorable, neutral, hedged or negative. A recommendation with a caveat is not the same outcome as a clean one, and being recommended against is an explicit rule-out, not an absence.

## Prompts

Choose questions a buyer would actually type, never questions written to smuggle in the brand:

- **Category**: "best CRM for small law firms"
- **Comparison**: "Acme vs Rival"
- **Problem**: "how do I invoice clients in euros as a freelancer"
- **Language and market variants**: the same intent in each locale the site serves

Keep 10–20 core prompts. More prompts do not fix noise; repeated runs do. Store them in a file beside the log so later runs stay comparable, and **version the set**: a version number plus a dated log of every addition, removal or reweighting. Never compare two periods that used different sets; recalculate on the prompts both share.

Add two **controls**, which show whether the measurement itself drifted:

- The brand name alone must always name the brand.
- An unrelated category must never name it.

If a control moves, the engine or the prompt set changed, not the site.

Read results **by topic, not prompt by prompt**. "Best auth API", "SSO for a SaaS" and "SAML providers" are one topic; count how often the brand and each competitor appear across the topic. A competitor in 18 of 25 runs while the brand is in 4 is the finding; one prompt where both appeared once is noise.

Include **multi-turn buying conversations**, not only single prompts. Commercial conversations rarely end after one turn: the opening prompt decides which sources get pulled, and the later turns decide who stays on the shortlist. Write one opening prompt and two or three realistic follow-ups (define the need, build a shortlist, compare, validate with "what do users complain about with X?", resolve migration risk, choose). Run the conversation in one session and record per turn whether the brand was mentioned, recommended, cited or dropped. The turn where it falls off is the gap.

## Running

Ask each question exactly as written, in a fresh context, in the target locale and language. Run each prompt 3–5 times per platform and report the rate with its sample size ("cited in 3 of 5 runs"), never a yes/no from one run. For every run record:

| Field | Why |
|---|---|
| date | runs are only comparable over time |
| prompt and portfolio version | verbatim, matching the prompt file |
| model and version, if shown | the model changing is the main confounder |
| level: read / cited / mentioned / recommended / recommended against | the rung, not a yes/no |
| tone of the mention: favorable / neutral / hedged / negative | a caveat changes the outcome |
| competitors named | shows who occupies the answer |
| exact sentence mentioning the brand | the quote is the evidence |

Save as JSONL or a table beside the prompt file. Do not summarize away the quote.

## Where the cited sources come from

Classify the sources the answer cites, not only whether the brand appears. The mix decides where the next hour goes:

| Class | Examples | Where to act |
|---|---|---|
| Owned | The brand's site, docs, pricing, blog | The page that should own the fact |
| Editorial | Trade press, independent reviews, newsletters, analysts, PR | Earned coverage, analyst and directory listings |
| Community | Reddit, YouTube, LinkedIn, forums, review platforms, marketplaces | Profiles, reviews and participation in your own name |

If owned sources dominate and the site lacks the fact, fix the page. If editorial dominates, pursue coverage. If community dominates, work the profiles. Do not average engines: they disagree, and a blended number hides opposite behaviour. Treat any citation-share figure as a dated snapshot; in Profound's July 2026 analysis of 11.84 billion citations, about 57% went to company-operated sites overall, 47% on ChatGPT and 69% on Gemini (vendor research from one setup).

## Wrong answers

Visibility counts whether the brand appears. Accuracy checks what the answer says when it does. Log the wrong claim instead of arguing with the answer:

| Field | What goes in it |
|---|---|
| Claim | The sentence as the model wrote it |
| Engine, prompt, date | So it can be reproduced |
| Verdict | Accurate and current / accurate but incomplete / ambiguous / stale / false / subjective framing / unverifiable |
| Severity | Critical (price, availability, compatibility, safety), high, medium, low |
| Likely source | The page the claim probably came from: own page, docs, profile, forum, third party |
| Fix | The owned page or profile that should state the truth |

**Fix the source first.** State the correct fact, plainly and with a date, on the page that should own it (pricing, docs, changelog, comparison, help centre), then on the profiles (LinkedIn, directories, review platforms). Ask third parties only for factual corrections, with the correct fact and a source; never for removing fair criticism. Retest the same prompts with the same portfolio version after 4–8 weeks. Never promise that fixing a source changes the answer: models retrain and re-retrieve on their own schedule.

Off limits: fabricated corrections, editing your own Wikipedia entry, and seeded forum posts.

## Interpreting

- **One run proves nothing.** Report the ratio over N runs and state N. If N is one, say one.
- **"Mentioned" is not "recommended".** Being listed among ten tools and being the first suggestion are different business outcomes, and being recommended against is a third.
- **Absence is the useful signal.** It points at the entity fact the assistant is missing: no pricing page, no integrations page, no clear statement of who the product is for. Cross-check the absence against the inventory before writing anything.
- **Separate the causes before writing.** Not being cited is technical (the page cannot be crawled or parsed: see `technical.md`), comprehension (it reaches the page and describes it vaguely or wrongly: fix the page) or trust (it understands the product and does not pick it: that is external reputation, and more content does not fix it).
- **Do not chase every absence.** Fix the ones that match a real buyer question. An assistant not naming the brand for an irrelevant query is not a gap.

## What not to build yet

A dashboard with a composite score. Start with the log file. Automate it when a second person needs the data or when run history is long enough that a trend means something — not before.

A deliberately deferred provider script: when a runner is added, it should support whichever model APIs the project already has keys for, write one JSONL line per run, and never compute a score.

Sources: adapted and condensed from Marketing Skills by Corey Haines (MIT, revision 88c79f6): the `ai-seo` references on citations versus recommendations, answer accuracy, prompt portfolio and format volatility. The visibility ladder and the claim ledger are their framework, re-expressed. The Profound figure is vendor research and dated; verify it against your own log.
