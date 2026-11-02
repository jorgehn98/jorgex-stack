# Citation check

Whether assistants name the brand can be measured. How precisely is the honest part.

Model versions change under the same name, answers vary between runs, and locale and personalization shift results. So the output is a **log of what happened** — prompt, model, date, verbatim answer — never a single "visibility score" that implies precision the data does not support. A score that moves because the model was updated, not because the site changed, is worse than no score.

## Prompts

Choose questions a buyer would actually type, never questions written to smuggle in the brand:

- **Category**: "best CRM for small law firms"
- **Comparison**: "Acme vs Rival"
- **Problem**: "how do I invoice clients in euros as a freelancer"
- **Language and market variants**: the same intent in each locale the site serves

Keep 10–20. More prompts do not fix noise; repeated runs do. Store them in a file beside the log so later runs stay comparable.

## Running

Ask each question exactly as written, in a fresh context, in the target locale and language. For every run record:

| Field | Why |
|---|---|
| date | runs are only comparable over time |
| prompt | verbatim, matching the prompt file |
| model and version, if shown | the model changing is the main confounder |
| brand appears: yes/no | the headline datum |
| recommended or merely listed | different outcomes, tracked separately |
| competitors named | shows who occupies the answer |
| exact sentence mentioning the brand | the quote is the evidence |

Save as JSONL or a table beside the prompt file. Do not summarize away the quote.

## Interpreting

- **One run proves nothing.** Report the ratio over N runs and state N. If N is one, say one.
- **"Mentioned" is not "recommended".** Being listed among ten tools and being the first suggestion are different business outcomes.
- **Absence is the useful signal.** It points at the entity fact the assistant is missing: no pricing page, no integrations page, no clear statement of who the product is for. Cross-check the absence against the inventory before writing anything.
- **Do not chase every absence.** Fix the ones that match a real buyer question. An assistant not naming the brand for an irrelevant query is not a gap.

## What not to build yet

A dashboard with a composite score. Start with the log file. Automate it when a second person needs the data or when run history is long enough that a trend means something — not before.

A deliberately deferred provider script: when a runner is added, it should support whichever model APIs the project already has keys for, write one JSONL line per run, and never compute a score.
