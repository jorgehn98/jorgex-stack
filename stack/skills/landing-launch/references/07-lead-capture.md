# 07 — Lead capture

Solve how the page collects the contact, signup or lead and delivers it without losses or spam. This is page-level (form, channel and copy); the sending infrastructure, the email domain and the antispam are set up once at site level and reused. It applies to lead capture, signup/waitlist, event and sales pages (where it includes payment); on a page without a form, only the direct contact channel counts.

## Input

- Single conversion goal and page type (01).
- Structure and primary CTA (03) and form copy (04).
- Jurisdiction (01), which determines the privacy notice and the marketing consent (09).
- Site-level, if it already exists: submission endpoint, authenticated email domain, configured Turnstile.

## Decide

Ask the user; do not assume:

- **Capture channel**, one per goal: contact/quote form, appointment booking, signup/waitlist, lead magnet in exchange for an email, or direct contact (phone/WhatsApp/email). A second channel competes with the single CTA (03): keep it subordinate.
- **Fields**: which are essential before you can help the visitor. Every extra field lowers conversion (indicative, from the source: 3 fields is the baseline, 4-6 costs 10-25%, 7+ costs 25-50% or more); ask what the follow-up actually uses.
- **Destination and owner** of the lead (database, CRM, email) and the response time you can truthfully promise.
- **Commercial communications**: if there will be a newsletter or marketing follow-up, it requires separate consent (09).
- **Popup**: not by default. Only with a free resource and enough traffic.
- **Antispam**: Turnstile or hCaptcha (skill hypothesis: better than reCAPTCHA for EU traffic because they do not profile across sites; confirm it in the privacy notice).

## Do

### Form

- Single email field without a repeat, with inline validation and typo suggestions. Name in one field. Phone optional (if required, explain why). Infer the company or ask for it later.
- One column; easy fields first and sensitive ones (phone, company size) last. Multi-step only with more than 5-6 fields or branches, with progress and a way back.
- Always-visible labels: the placeholder disappears as the user types; use it only as an example.
- Button with action and outcome ("Obtener mi presupuesto"), with loading, success and error states.
- Next to the form: short privacy notice (09), expected response time and an alternative (phone/chat).
- Mobile: touch targets of 44 px or more, `type="email"`/`tel`, correct `autocomplete`.
- Specific errors, next to the field, without clearing what was typed and with focus on the first one.
- Signup/waitlist: ask only for the email; defer role, company and phone. If there is email verification, delay it or use a magic link, with easy resend.
- Direct contact: show it as text or a real link (`tel:`, `mailto:`), not only in an image.

### Lead magnet (only if the goal is to capture an email)

- Solve one concrete problem, make it consumable in under 30 minutes, with a single format; start with cheap formats (checklist, template).
- Deliver with a thank-you page and an email with a copy: immediate access and a check that the email is valid. The thank-you page proposes a next step.
- The source's conversion rates (20-40% warm traffic, 5-15% cold) are not verified: do not use them as a promise.

### Popups (guardrails)

- Prefer click-triggered. Otherwise, 25-50% scroll or exit intent (mobile has no exit intent); avoid triggering at 5 s.
- Once per session, remember the dismissal for 7-30 days and exclude people who already converted.
- Visible close, a polite "No, gracias", trapped focus and working keyboard; on mobile, a bottom panel, not full screen. Google penalizes intrusive interstitials on mobile; cookie notices are allowed. Do not overlap it with the cookie banner.
- Source reference (not verified): email popup 2-5%, exit 3-10%, click-triggered 10% or more.

### Submission implementation (what an AI usually gets wrong)

1. **Always validate on the server**; browser validation is only UX and a direct POST skips it. Sanitize, limit lengths and reject unexpected fields.
2. **Save before notifying**: persist the valid request, then send the alert, the email or the integration. That way, if the email or the CRM fails, the lead is not lost (retry or queue); an enrichment failure never rejects or deletes a lead.
3. **Idempotency**: stable submission ID, so a double click, a retry or a repeated webhook does not create another contact or another alert.
4. **Layered antispam**, because no single layer is enough:
   - Hidden honeypot, checked on the server. Browser autofill can fill it and block real users: non-obvious field name, `autocomplete="off"`, off-screen (not only `display:none`) and no accessible `tabindex`.
   - Minimum time since load: reject submissions faster than a human.
   - **Turnstile (or hCaptcha) verified on the server** with `siteverify` before saving. The form token proves nothing by itself: a bot that POSTs directly never goes through the widget. Check that the accessible alternative works.
   - **Rate limit** per IP on the server or with CDN/WAF rules (on the order of 3-5 submissions per IP in 10 minutes or an hour; adjust to the case).
   - Suspicious submissions go to **quarantine**, not the trash: keyword filters give false positives and lose leads. If spam continues and is "grammatical", add a context question validated on the server.
   - The effectiveness figures (95%, 99%) from blogs are marketing: measure your own spam.
5. **Secrets** (API keys, Turnstile secret) only on the server, in environment variables, never in the client or the repo. Endpoint with restricted CORS and without exposing recipients.
6. **Authentication of the alert and confirmation email**:
   - SPF and DKIM at minimum; DMARC (`p=none` is enough at first) recommended at any volume; the `From` domain aligned with SPF/DKIM; 2048-bit DKIM (minimum 1024). Transactional emails count too. Sender requirements change: check Google's sender guidelines.
   - Sender on your own domain through a transactional provider; not the server's `mail()` or a personal Gmail as `From`.
   - Confirmation to the user stating what happens now and when (a real timeframe). The internal alert includes the page and source/UTM (08).
7. **Double opt-in** (newsletter or marketing): confirm by email. The GDPR (RGPD) does not require it as such, but it does require being able to **prove consent** (date, text and policy version; see 09). The commercial-communications checkbox is separate, optional and never pre-checked.
8. **States**: loading (button disabled), success (message with next step or thank-you page) and a recoverable error that keeps what was typed and links the alternative (phone/email).
9. **Thank-you page with its own URL**, or an event after server-confirmed success: it is the reliable point to measure conversion in 08. The button click is not a conversion.
10. **Accessibility**: associated labels, announced errors (`aria-live`/`aria-describedby`), focus on the first error, logical tab order, do not rely on color (criteria in 10).

### Routing and follow-up (if there is a sales team or CRM)

- Record the valid submission before depending on a third party; do not reject it because an enrichment provider returns no data. A personal email does not identify a company: ask for the minimum missing data or send it to a human queue.
- Write the rules before implementing, with branches: existing customer; fits and has an owner; fits without an owner (confirmation with honest expectations and a queue with a deadline); missing or ambiguous data ("pending" queue); explicit disqualifier with reliable evidence (alternative resource, record the reason).
- Bound the interactive wait time; slow work completes in the background and must not steal an already assigned lead or duplicate bookings.
- Measure time to first human response: request latency is not the sales response.

## Deliverable

- Capture channel and fields decided, with the privacy notice next to the form.
- Submission endpoint with server-side validation, persistence before notification and idempotency.
- Layered antispam verified on the server and email authentication at PASS.
- Thank-you page or success event defined for 08, and marketing consent resolved with 09.
- Written routing rules (if there is a CRM).

## Verify

- Real end-to-end test submission: it reaches the database or CRM, the alert arrives and the confirmation reaches Gmail and another provider without landing in spam.
- In Gmail, "Show original": SPF, DKIM and DMARC at PASS.
- Submission with the honeypot filled, with an invalid Turnstile token and with a direct POST without a token: all three must be rejected.
- Double submission (double click and retry): a single record.
- Simulated failure of the email provider or the CRM: the request is still saved.
- Keyboard and screen reader; real mobile; form with browser autofill active, to detect honeypot false positives.
- With a CRM: cases of existing customer, new lead that fits, unknown company, duplicate, timeout with late success and unavailable owner; review the visible page and the records, not just the OK.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| The submission arrives end to end | Real test submission: record in database/CRM, alert received and confirmation in the inbox | Blocking |
| Validation is server-side | Direct POST with curl with empty or unexpected fields; it must return an error and not save | Blocking |
| Turnstile/hCaptcha is verified on the server | POST without a token or with an invalid token; it must be rejected. Endpoint code with a `siteverify` call | High |
| It saves before notifying | Simulate failure of the email provider or CRM and check the lead is saved | High |
| The submission is idempotent | Double click and retry with the same ID: a single record and a single alert | Medium |
| Honeypot without false positives | Submission with browser autofill; served HTML without `display:none` as the only hiding method | Medium |
| There is a rate limit and quarantine | Burst of submissions from one IP (blocked after the threshold) and a queue of suspicious submissions exists | Medium |
| The sending email is authenticated | Original headers in Gmail with SPF, DKIM and DMARC at PASS | High |
| No secret reaches the client | Search for keys in the served JS and in the repo | Blocking |
| There is a privacy notice and a correct marketing checkbox | Form screenshot: link to the policy, separate checkbox, not pre-checked | High |
| A reliable conversion point exists | Thank-you URL or event after server success, visible in the browser network tab | High |
| Form states and errors are usable | Screenshots of error, loading and success; the error keeps what was typed and offers an alternative | Medium |
| The form works with keyboard and on mobile | Tab walkthrough and test on a real phone; `type` and `autocomplete` in the HTML | Medium |
| Minimum fields are justified | List of fields against what the follow-up uses | Low |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to 08 without: a passing E2E test submission, antispam verified on the server, email authentication at PASS, a thank-you page or success event defined for measurement, and marketing consent (if any) resolved with 09.

Sources: Google email sender guidelines; Cloudflare Turnstile documentation (`siteverify`); GDPR (RGPD) documentation on consent and proof of consent; own judgment. Adapted in part from Corey Haines, Marketing Skills (https://github.com/coreyhaines31/marketingskills, MIT: cro form guidance, signup, popups, lead-magnets, revops inbound routing).
