# 07 — Security, privacy and cost

Short cross-cutting review of the security, personal data and cost decisions already taken in phases 01-06. It is not a long phase: it checks what was decided, fills the gaps and sets the rigor level for the project. Legal analysis is out of scope; regulatory questions are marked `[NEED: legal review]`. For a landing page or static site without personal data, the review reduces to one line: HTTPS, basic headers, no secrets in the repository and a cost alert.

## Input

- Partial decision record from 01-06: project type, data sensitivity, services, deployment, observability and the data map (`04-data.md`).
- Consequence of a failure: who is affected and how badly.

## Decide

### Rigor by project type `[criterion]`

Rigor follows data sensitivity and failure impact, not team size.

| Project | Rigor | Do | Can skip |
|---|---|---|---|
| Landing or static site without accounts or personal data | Minimum | HTTPS with HSTS, basic headers, no secrets in the repository, dependencies and hosting up to date, budget with alert | Formal modeling, full ASVS, `security.txt`, dedicated secrets manager |
| Site with forms, newsletter or analytics | Low | Everything above, plus decide which data is collected and how long it is kept, review the form provider, reasonable CSP, anti-spam | Full ASVS level 2, penetration testing |
| SaaS or app with accounts | Standard (ASVS level 2 as reference) | Threat modeling of about 30 minutes, OWASP Top 10 as review checklist, deny-by-default access control, secrets management, security logs, backups with tested restore, `security.txt`, cost tags and alerts | Level 3, bug bounty programs, dedicated security modules |
| Public API or API with integrations | Standard + | Everything above, plus per-resource authentication and authorization, rate limits, input validation at the edge, CORS with explicit origins | Level 3, unless the data is critical |
| Highly sensitive data (health, finance) or severe impact | High (ASVS level 3) | Formal modeling, independent review, automatic secret rotation, audit; legal review beforehand | No shortcuts |

ASVS levels: level 1 for every project; level 2 for sensitive data (recommended for most); level 3 for critical systems. ASVS version 5.0.0 (volatile, verified 2026-10-12). The level descriptions were read in the OWASP Developer Guide, which cites ASVS 4.0.3, so check them against the 5.0 text before relying on them.

## Do

### Principles

1. Model before listing: answer four questions (what are we building, what can go wrong, what do we do about it, did we do a good enough job?). Everything else follows from the answers.
2. Platform defaults come first: HTTPS, headers and the provider's secrets manager. Writing your own security controls is the last resort.
3. In small projects the best return comes from correct access control, secrets outside the code, up-to-date dependencies, tested backups and minimal useful logs.
4. Privacy is an architecture decision: collect less, keep data for less time, restrict access and use private defaults. Minimization and retention are required fields of the decision record.
5. Cost: assign tags and an owner before optimizing; alert before cutting.

### Lightweight threat modeling

The four questions of the Threat Modeling Manifesto are enough. Split the half hour as follows `[criterion]` (an own adaptation, not an official method):

- 10 minutes: draw the data flow and the trust boundaries.
- 10 minutes: walk STRIDE over each flow and each store.
- 10 minutes: choose a response (mitigate, eliminate, transfer or accept) and record the top 3 to 5 risks as tasks.

Repeat it when the design changes. It is not a one-time exercise.

### Before launch

1. Simple system diagram and a list of threats, each with a response.
2. The ten categories of the OWASP Top 10:2025 (volatile, verified 2026-10-12) reviewed against the design, with focus on access control and misconfiguration. The 2025 edition includes supply chain failures and mishandling of exceptional conditions as categories.
3. Access control: deny by default, enforced on the server per resource, not only in the interface.
4. No secret in the repository or in the image; active secret scanning; a revocation and rotation plan if one leaks.
5. Least-privilege credentials, separated by environment; the CI/CD pipeline is treated as production.
6. Everything over HTTPS with HSTS; `nosniff`, `Referrer-Policy`, `Permissions-Policy`, and CSP or `frame-ancestors`; no version headers; obsolete headers (`X-XSS-Protection`, `Expect-CT`, HPKP) are not used.
7. Dependencies and supply chain as decided in `03-language-and-framework.md` and `05-identity-and-services.md`: pinned versions, updates, scanning.
8. Controlled errors: no stack traces or internal data shown to users; fail closed on an exception.
9. Security event logs (access, authentication failures, permission changes) with minimal alerting and no unnecessary personal data.
10. Personal data inventory with defined retention and deletion (`04-data.md`). Data that is not needed is not collected.
11. Encrypted backups, and a restore tested at least once (`04-data.md`).
12. Vulnerability reporting channel if there are external users and someone reads the mailbox: `security.txt` with `Contact` and `Expires` (RFC 9116, Informational, 2022; volatile, verified 2026-10-12), or a documented address. An expired file is worse than none: it increases report volume, including spam. It does not grant permission to test.
13. Cost: tags and an owner; budget with alerts (for example at 80% and 100%, a FinOps example, not a rule); a limit or quota on pay-per-use services; a monthly review on the calendar `[criterion]` (common practice, no official citation).

### Out of scope: legal

Legal analysis is not part of this review. Mark regulatory questions `[NEED: legal review]` and resolve them when the public pages are built (legal phase of the `landing-launch` skill; data map in `04-data.md`).

### Cost

The FinOps Framework in one line: Inform (measure and allocate costs), Optimize (reduce usage and improve rates), Operate (apply changes continuously). At small scale: tags defined before the first production resource, a budget with alerts, daily anomaly alerts and a monthly cost review. The concrete steps are a synthesis of several FinOps pages, verified only through search summaries of those pages; the Foundation has no guide for small teams.

## Deliverable

- Section "Security, privacy and cost" at the end of the decision record (see `08-decision-record-and-skeleton.md`), with:
  - rigor level chosen and why;
  - main threats with their response;
  - status of each before-launch item: done, pending, or not applicable with reason;
  - reporting channel, or the reason there is none;
  - minimization and retention policy;
  - budget and alerts;
  - `[NEED: legal review]` markers.

## Verify

- Each before-launch item is marked line by line, with evidence (where it is visible) or the reason it does not apply.
- Each main threat has a decided response and an associated task.
- Headers are checked on the real response, not only in the configuration.
- Volatile data (OWASP edition, ASVS version) has the date it was read.

## Audit

Evidence that needs another user's session, live endpoints or provider consoles requires the user's permission first; use a non-production environment where possible.

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Secrets in the repository or in the image | Secret scan of the repository and image layers | Blocking |
| Access control only in the interface | Call protected endpoints directly, without a session or with another user's session; expect denial | Blocking |
| No HTTPS or no HSTS in production | Response headers of the production URL | High |
| Personal data without defined retention | Data map against stored fields and deletion jobs | High |
| Backups without a tested restore | Log of the last restore test | High (Blocking for customer or critical data) |
| No threat model in a SaaS or API | Threat list with responses and tasks | High |
| Before-launch list without evidence | Line-by-line list with evidence or reason | High |
| Version headers visible or obsolete headers sent | Response headers of the production URL | Low |
| `security.txt` expired or mailbox unattended | Expiry date in the file; named mailbox owner | Medium |
| No cost alerts | Budget and alert configuration in the provider console | Medium |
| Rigor far above the need (for example, ASVS level 3 on a landing) | Rigor table against project type | Low |
| Volatile data without a date | Sources list with read date | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to `08-decision-record-and-skeleton.md` without the items below. For a landing page or static site without data, this phase is light and its gate is its one-line entry in the record (HTTPS and headers, no secrets in the repository, a cost alert).

Items:

- rigor level chosen and justified;
- threat modeling done, or skipped with a reason;
- before-launch list with status per line;
- minimization and retention policy written;
- budget with alerts;
- reporting channel decided, or the reason for not having one;
- volatile data verified with a date, or marked as not verified.

## Not verified / to confirm

- OWASP Top 10:2025 publication date: the official page gives none. Secondary sources mention November 2025 (candidate) and January 2026 (final). The category list is verified.
- ASVS 5.0 level text: the "Using the ASVS" chapter could not be opened. The level descriptions come from the Developer Guide, which cites 4.0.3.
- Not cited here: Privacy by Design (the official URL returned 404 on 2026-10-12; the text was read in a copy) and EDPB Guidelines 4/2019 (search summary only).
- RFC 9116 publication month: not extracted.
- FinOps: the monthly review is not a Foundation rule, and the 80% and 100% alerts are an example.
- The 30-minute modeling split and the size-based rigor are own adaptations.

Sources: OWASP Top 10:2025 (https://top10.owasp.org/2025); OWASP ASVS (https://github.com/OWASP/ASVS); OWASP Developer Guide, ASVS (https://devguide.owasp.org/en/03-requirements/05-asvs/); OWASP Threat Modeling Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html); Threat Modeling Manifesto (https://www.threatmodelingmanifesto.org/); RFC 9116 (https://www.rfc-editor.org/rfc/rfc9116); OWASP Secrets Management Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html); OWASP HTTP Headers Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html); FinOps Framework (https://www.finops.org/framework/ and https://www.finops.org/framework/phases/); FinOps cost allocation (https://www.finops.org/wg/cloud-cost-allocation/); FinOps cost anomalies (https://www.finops.org/wg/managing-cloud-cost-anomalies/); FinOps token economics, budget example (https://www.finops.org/wg/token-economics-saas/); read 2026-10-12.
