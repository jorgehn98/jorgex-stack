# 09 — Legal and consent

Decide which documents and which consent mechanics the site needs depending on where the users are and what it collects and loads, and implement them. It is almost all site-level (privacy policy, legal notice, banner, contracts with providers: done once and reused; on the second page you only check they are still current and cover what is new). Page-level items are the short notice next to the form, the marketing checkbox and the terms of sale if that page sells. It applies to every public marketing page.

This phase guides which documents and which technical mechanics are needed; it is not legal advice and does not replace a lawyer. The texts it generates are drafts for legal review.

Index: Input · Decide (input questions and document matrix) · Do (how to use volatile data; global baseline; European block; US block; other markets; technical consent mechanics) · Deliverable · Verify · Audit · Not verified / to confirm · Gate.

## Input

- Jurisdiction, language and page type (01); if there is a sale, the offer and price (02).
- Chosen analytics tool and its consent impact (08): it determines whether there is a banner.
- What is collected and where it goes (07): fields, data processors, marketing checkbox.
- Site-level, if it already exists: policy, legal notice, banner and contracts with data processors.

## Decide

### Input questions (before generating anything)

Ask them because the rule that matters is usually that of the place where the users reside, not the site owner's (GDPR (RGPD) art. 3(2) and the Brazilian LGPD art. 3 apply by their terms to people located there, and Chile and Peru have express clauses; the CCPA applies by thresholds and doing business in California). That is why you ask about the audience, not only the headquarters.

1. Where are the target users? (EU/UK, US, LatAm, global.)
2. Who is the data controller: individual/sole trader or company? Country and registration details.
3. Does the site sell or charge, or does it only capture contacts?
4. Which cookies or tags will there be? (analytics, ads, pixels, chat, maps, embedded video, remote fonts.)
5. Is there a newsletter or commercial email/SMS?
6. Are minors' or sensitive data processed?
7. Which data processors are used? (hosting, email, CRM, analytics, forms.)
8. Are there transfers outside the EU?

### Document and mechanism matrix

| Mechanism | When | Block |
|---|---|---|
| Privacy policy (layered: short notice next to the form and full policy) | Whenever personal data is collected (form, analytics with identifiers) | Global |
| Site owner details (legal notice (imprint) or "about us") | Whenever there is economic activity; the content depends on the country | Global; mandatory in EU/UK and in LatAm if there is a sale |
| Cookie policy and banner/CMP | Only if there are cookies or storage that are not strictly necessary | EU/UK yes; US depends on the state; LatAm no binding rule found |
| Marketing consent (separate checkbox, not pre-checked) and unsubscribe | If there is a newsletter or commercial email | Global; strong rule in EU/UK |
| Terms of sale and withdrawal | Only if the site sells or contracts; not needed on pure lead capture (agent interpretation: confirm) | EU/UK/LatAm, deadlines per country |
| Accessibility | Depends on the block | EU (e-commerce); US, litigation risk |
| Collection notice and opt-out link | If the CCPA or state threshold is met | US |

## Do

### How to use volatile data

- This file carries what is stable and the decisions. Figures, amounts, rates, thresholds, deadlines and effective dates are **not copied as fact**: open the source linked in each block, check it and state the date you checked. If you cannot open it, say so and do not assert it.
- Each block states "Verified: 2026-10-12", the date its sources were cross-checked. If today's date is later, treat it as a starting point and reopen the sources before delivering.

### Global baseline (always; stable)

Verified: 2026-10-12.

1. **One privacy policy** in plain language: controller and contact; what data, for what purpose and on what legal basis; who it is shared with (data processors, third parties); international transfers; retention; rights (access, rectification, erasure, objection, portability, restriction) and how to exercise them; right to complain to the authority; cookies. Visible link in the footer and next to the form.
2. **Short notice next to the form** (first layer): controller, purpose, basis, recipients, rights and a link to the policy. Ticking "I accept the policy" only proves the person was informed; if the basis is consent, it is requested separately (AEPD, FAQ-0248).
3. **Consent per purpose**: a distinct checkbox for marketing, optional and never pre-checked, not bundled with the policy. Keep the proof: date and time, text shown, policy version, origin (URL/IP or equivalent) and address.
4. **Unsubscribe in every commercial email**, honored promptly, and a visible channel to exercise rights. The deadlines for answering rights requests and for notifying breaches are volatile by law: check them in the block's sources.
5. **Site owner details** visible: name or company name, address, contact, and registration and VAT number if they exist.
6. **Cookies**: nothing non-essential before consent where it is required. A banner where "reject" is as easy as "accept" is the global safe standard: it meets the strictest requirement and avoids redoing it per market.
7. **Price and terms before contracting**, if there is a sale: taxes where applicable and withdrawal or cancellation right with each country's deadline (check each country's source).
8. **Truthful advertising**: testimonials, reviews and results that are real and attributed, with material connections disclosed. Links to the rule of not inventing proof (04).
9. **Minimum internal records**: list of processing activities and data processors, contracts with data processors, procedure for rights requests and breaches. Formal obligation depends on size and country; the habit is cheap.
10. **Minors**: do not target minors or collect their data without valid consent; the minimum age varies by country (in Spain, LOPDGDD art. 7; check the source). If the audience may include them, address it expressly.

### European block (EU, Spain as the case, and United Kingdom)

**EU and Spain.** Verified: 2026-10-12.

- **Legal notice** (LSSI (Information Society Services and E-Commerce Law) art. 10): name or company name, address, email, tax ID (NIF), registries or professional membership, and price including taxes. It applies to anyone carrying out economic activity online, including sole traders.
- **Privacy** (GDPR (RGPD) arts. 12-14): the AEPD (Spanish Data Protection Agency) recommends layered information and publishes a model information clause. Typical basis for a contact form: pre-contractual measures or legitimate interest; newsletter: consent (usual interpretation; the AEPD does not state it expressly).
- **Cookies** (LSSI art. 22.2 and the AEPD cookie guide): prior consent for non-exempt ones; accept and reject at the same level; per-purpose panel; continuing to browse or scrolling does not count; no cookie walls without an alternative; withdrawing as easy as accepting; remember the choice (the AEPD suggests 24 months as good practice, not a mandate). The AEPD announced a review of its guides: check whether the cookie one has changed.
- **Consent-exempt analytics**: the AEPD (audience measurement guide) and the CNIL (French data protection authority) accept an exemption if it is only anonymous statistics, with no reuse or cross-site identifiers, with a data processor contract and a documented assessment, and with maximum durations. No authority certifies tools and Plausible/Umami are not listed: it depends on the configuration. The CNIL publishes a Matomo configuration guide to qualify for the exemption. Even if exempt, it is disclosed in the policy.
- **Newsletter** (LSSI art. 21): prior and express consent, and unsubscribe in every send.
- **Sales to consumers** (TRLGDCU (consumer protection consolidated text) arts. 97-98 and 102): pre-contractual information, total price, complaints and withdrawal (deadline: see the text). Lead capture without contracting does not trigger those articles (agent interpretation: confirm).
- **Accessibility** (Ley 11/2023): applies to e-commerce services to consumers, with an exemption for service microenterprises (thresholds: see the text). Lead capture falls outside according to the agent's interpretation: confirm. Check the application date.
- **Online dispute resolution**: the European ODR platform was abolished (Regulation (EU) 2024/3228); do not link or cite it. Complaint forms (hojas de reclamaciones) depend on regional regulations: check the consumer authority of the autonomous community.
- **Transfers to the US**: check that the provider is certified under the EU-US Data Privacy Framework or that standard contractual clauses are in place. The framework's status is subject to court challenges: verify it.
- **DPO and record of processing activities**: only in the cases set by the GDPR (RGPD) (arts. 37 and 30.5); for a small website the DPO is usually not mandatory and the record is worth having.

**United Kingdom.** Verified: 2026-10-12.

- UK GDPR art. 13 (notice) and PECR (cookies and electronic marketing).
- **Data (Use and Access) Act 2025, Schedule 12**: creates a consent exception for statistical analytics (only to improve the service, clear information, a simple and free way to object; it does not cover advertising, ad measurement or profiling). The effective date was given by the research agent and is not confirmed. The ICO (UK Information Commissioner's Office) guidance does not make clear whether Google Analytics qualifies. Verify the current status.
- Banner: reject as easy as accept, no pre-checked boxes, continuing to browse is not consent and it is not bundled with terms.
- Newsletter: prior consent (PECR reg. 22) for individuals and sole traders; the "soft opt-in" only covers customers who already bought and similar products, and a signup without a purchase does not trigger it.
- Business details (E-Commerce Regs 2002 reg. 6; SI 2015/17 reg. 24 for companies): name, address, email, registration, VAT. The ICO data protection fee is payable if personal data is processed unless exempt: check amounts and exemptions with the ICO.

**Sources to open before asserting:**
- AEPD: `https://www.aepd.es/guias/guia-cookies.pdf`, `https://www.aepd.es/guias/guia-cookies-analiticas-externas.pdf`, `https://www.aepd.es/guias/guia-modelo-clausula-informativa.pdf`
- LSSI: `https://www.boe.es/buscar/act.php?id=BOE-A-2002-13758`
- RGPD (GDPR): `https://www.boe.es/doue/2016/119/L00001-00088.pdf`
- LOPDGDD (Spanish data protection and digital rights law): `https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673`
- TRLGDCU: `https://www.boe.es/buscar/act.php?id=BOE-A-2007-20555`
- Ley 11/2023: `https://www.boe.es/eli/es/l/2023/05/08/11/con`
- CNIL, audience measurement: `https://www.cnil.fr/fr/cookies-solutions-pour-les-outils-de-mesure-daudience`
- ICO, storage and access: `https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/`; fee: `https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/`
- DUAA Schedule 12: `https://www.legislation.gov.uk/ukpga/2025/18/schedule/12`

### US block (US, California as the main case)

Verified: 2026-10-12. **There is no general federal privacy law**: the model revolves around communication opt-outs, truthful advertising and notice at collection, rather than prior consent for cookies.

- **CAN-SPAM** (commercial emails, B2B too): identify the message as an ad, physical postal address, truthful sender and subject, and a clear, honored unsubscribe. The unsubscribe deadline and the penalty per violating email are volatile: check them with the FTC.
- **SMS and calls (TCPA)**: written consent for automated marketing. Could not be verified at an official source: treat it as "to check" before sending SMS.
- **FTC**: non-deceptive advertising; the reviews and testimonials rule (16 CFR 465), which bans fake reviews and buying them, and the Endorsement Guides (disclose material connections). The "junk fees" rule (16 CFR 464) only covers event tickets and short-term lodging.
- **COPPA** (children) and **other states** (Virginia, Colorado, Connecticut, Texas, etc., with their own laws and thresholds; third-party source only): check whether there is a relevant audience.
- **California**: CCPA/CPRA applies if one of its thresholds is exceeded (revenue, volume of consumers or households, percentage of revenue from selling or sharing data); the monetary threshold is adjusted periodically. If it applies: notice at collection, a policy with minimum content and periodic review, a "Do Not Sell or Share" link and honoring Global Privacy Control, the latter only if data is sold or shared (advertising pixels usually count as "sharing"). **CalOPPA**: visible policy and a statement of how Do Not Track is handled (disclose it, not obey it); not verified at an official source.
- **Tracking litigation risk** (CIPA, pixels, chat, session replay): lawsuits for interception or "wiretapping". The SB 690 bill and its application dates come from a third-party source: verify. Practical mitigation: minimize pixels and session replay, require prior consent for them and review provider contracts.
- **Accessibility**: there is no explicit technical standard for private websites (DOJ guidance); WCAG is the reference and the risk is litigation.

**Sources to open:** CAN-SPAM `https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business`; reviews `https://www.ftc.gov/business-guidance/resources/consumer-reviews-testimonials-rule-questions-answers`; endorsements `https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking`; COPPA `https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions`; CCPA `https://oag.ca.gov/privacy/ccpa` and threshold adjustment `https://www.cppa.ca.gov/regulations/cpi_adjustment.html`; ADA `https://www.ada.gov/resources/web-guidance/`.

### Other markets (Latin America; brief, built on the global baseline)

Verified: 2026-10-12. No specific binding cookie rule was found in Mexico, Argentina, Colombia, Chile or Peru: the global banner standard applies if there are non-essential tags. Privacy notice, consent and consumer rules do exist.

- **Mexico**: data protection law (LFPDPPP) recently renewed; the regulator changed (it is no longer INAI): check which one it is today. Privacy notice, simplified for electronic media with a link to the full one; implied consent in general and express consent for sensitive data. LFPC art. 76 Bis for e-commerce (with recent reforms on recurring charges). Status of the regulations and guidelines: not confirmed.
- **Brazil**: the LGPD (General Data Protection Law) applies to anyone offering goods or services to people in Brazil (art. 3); legal bases (art. 7), consent (art. 8), information (art. 9); small entities have a simplified regime but must provide a contact channel (ANPD Res. 2/2022); ANPD (national data protection authority) cookie guide (indicative: reject button, no pre-checked boxes); CDC (Consumer Protection Code) art. 49 on withdrawal and Decree 7.962/2013 on supplier details.
- **Argentina**: Ley 25.326; Decree 1558/2001 art. 27 (in all advertising, state how to request removal or blocking); revocation in distance purchases (Ley 24.240 art. 34); withdrawal button (Res. 424/2020).
- **Colombia**: processing policy and privacy notice (Decree 1377/2013); silence is not consent; Ley 2300/2023 limits hours and requires easy unsubscribe in commercial messages; withdrawal right (Ley 1480 art. 47).
- **Chile**: Ley 21.719 with its entry into force under discussion (an Executive bill proposes postponing it): check the status. Withdrawal right in distance purchases (SERNAC).
- **Peru**: new regulation (D.S. 016-2024-JUS) that applies to anyone offering to people in Peru; marketing with direct consent; Complaints Book (Libro de Reclamaciones) mandatory. Uruguay, Ecuador and Panama: not analyzed; check the local authority. Deadlines and dates for all countries: see the source.

**Sources to open:** Mexico `https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf`; Brazil `https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm`; Argentina `https://www.argentina.gob.ar/normativa/nacional/ley-25326-64790/texto` and consumer `https://servicios.infoleg.gob.ar/`; Colombia `http://www.secretariasenado.gov.co/senado/basedoc/ley_1581_2012.html`; Chile `https://www.diariooficial.interior.gob.cl/publicaciones/2024/12/13/44023/01/2583630.pdf` and `https://www.economia.gob.cl/2026/09/01/gobierno-propone-ampliar-plazo-para-implementar-nueva-ley-de-proteccion-de-datos-y-institucionalidad.htm`; Peru `https://www.smv.gob.pe/Uploads/Ley_29733_vigente_2025.pdf`.

### Technical consent mechanics (stable)

- **Real inventory of cookies and storage** before drafting: the browser's Network and Application tabs or a CMP scanner. The policy describes what exists, not what is expected.
- **Real prior blocking**: non-essential scripts are neither loaded nor executed until consent. Hiding the banner or loading and "asking permission" afterwards does not comply. With the banner untouched, there must be no non-essential cookies or tracking requests to third parties.
- **Banner**: accept and reject at the same level and effort (the reject button as prominent as the accept one, no preselection), second level per purpose, link to the policy, accessible by keyboard and screen reader, not covering the CTA or the content (it counts for CWV, 10, and for 03), and changing one's mind in one click from the footer.
- **Consent record** (cookies and marketing): date and time, text version and decision per purpose; ask again when the purposes change or after a set period.
- **CMP or hand-built**: with cookieless analytics and no third parties, a simple custom banner may suffice or not be needed; with Google ads or pixels in the EEA, a Google-certified CMP and Consent Mode v2 (08). A certified CMP does not remove the need to review what the scripts load.
- **Global Privacy Control and similar signals**: honor them where the law requires it (California) and, if simple, in general.
- **External fonts, CDNs, video and maps** send the user's IP to third parties: self-host fonts and use click-to-load embeds or tracking-free versions (reduces the banner and transfers).
- **Providers**: data processor contract (GDPR (RGPD) art. 28 or equivalent) with hosting, email, CRM, analytics and forms; check the data location and the transfer mechanism.
- **Texts**: write drafts from the input answers, in the page's language, with pending fields `[NEED: …]` and the legal review warning. Do not invent site owner details, registrations or deadlines.

## Deliverable

- Input answers and decided document matrix.
- Drafts of the privacy policy, legal notice, cookie policy and short form notice, with `[NEED: …]` fields and the legal review warning.
- Working banner or CMP (or a justified decision not to have one) and cookie inventory.
- Cookie and marketing consent record; complete site owner details.
- Terms of sale and withdrawal only if the site sells.
- List of volatile data used, with source and date checked.

## Verify

- Load the page with the banner untouched and compare cookies, storage and network requests against the inventory and the policy.
- Accept, reject and revoke from the footer: the state persists and the scripts load or not according to the choice.
- Rejecting takes the same number of clicks as accepting; the banner works by keyboard and does not cover the CTA.
- Submit the form with and without the marketing checkbox and check that the consent record stores date, text and version.
- Open each official source used and note the date; check every footer link and that no links to the ODR platform or `[NEED]` placeholders remain in the served HTML.

## Audit

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Without consent nothing non-essential is written (EU/UK) | Cookies and storage in the Application tab and requests in Network after loading with the banner untouched | Blocking |
| Rejecting is as easy as accepting | Screenshot of the banner's first level: equivalent buttons and clicks needed to reject | High |
| A full, linked privacy policy exists | Link in the footer and next to the form; content against the global baseline list | Blocking |
| The policy matches what is actually loaded | Inventory of cookies and third parties against the policy text | High |
| There is a short notice next to the form | Screenshot of the form with controller, purpose and link | High |
| The marketing checkbox is separate, optional and not pre-checked | Form HTML (`checked` attribute absent) and screenshot | High |
| Proof of consent is stored | Record of a test submission with date, text and version | Medium |
| Site owner details are complete | Legal notice with identification, address and contact, with no pending `[NEED]` placeholders | High |
| Every commercial email has an unsubscribe | Test email with a working unsubscribe link | High |
| If the site sells, there are terms and withdrawal | Pages linked from the checkout or the offer | High |
| Volatile data used has a source and a date | List of sources with check date in the deliverable | Medium |
| No abolished resources are linked and no legislation is cited unverified | Search the HTML for the ODR platform and for legal figures without a source | Low |
| External embeds are controlled | Network requests to fonts, maps and video before interacting | Medium |
| Providers have a data processor contract | Contracts or processing terms accepted with each provider | Medium |

Verdict per item: Pass / Improvable / Missing / N/A.

## Not verified / to confirm

State these points in the delivery; do not present them as facts:

- Complaint forms outside Andalusia and Madrid.
- Whether Plausible, Umami or Cloudflare Web Analytics meet the exemption (depends on the configuration; no official AEPD or Cloudflare source found).
- Status of the AEPD cookie guide after its announced review.
- Double opt-in as a requirement: it is a practice for proving consent, not an obligation found.
- CalOPPA, Shine the Light and TCPA at an official source.
- SB 690 and effective dates in the US.
- Effective date of the DUAA analytics exception in the UK.
- Status of the Chilean law's postponement, the Mexican regulations and the cookie rules in LatAm.
- Thresholds, amounts and deadlines (CCPA, ICO, CAN-SPAM, withdrawal, breaches) at their official source.
- Whether a pure lead-capture page falls outside terms of sale and accessibility (agent interpretation: confirm).

This guide orients but does not replace a lawyer: the drafts and decisions in this file must go through legal review before publication.

## Gate

Do not move to 10 without: complete input answers, decided document matrix, generated texts as drafts with the legal review warning, real cookie inventory checked against the banner (test with the banner untouched), marketing consent with a record, complete site owner details and every volatile data point used verified at its official source on the delivery day.

Sources: AEPD, CNIL, ICO, BOE (LSSI, RGPD, LOPDGDD, TRLGDCU, Ley 11/2023), legislation.gov.uk (DUAA 2025), FTC, California Attorney General (CCPA), CPPA, ADA.gov, and the official texts of Mexico, Brazil, Argentina, Colombia, Chile and Peru linked in each block; verified 2026-10-12.
