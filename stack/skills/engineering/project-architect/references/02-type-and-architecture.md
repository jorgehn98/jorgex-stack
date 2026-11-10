# 02 — Project type and architecture

Scope note: This phase decides the project type and target platform (A), the rendering model per zone (B) and the system architecture style (C), each justified by the brief from phase 01. It gives criteria, not recipes. Versions, limits, prices and store rules change: link the official source and verify it on the day of the decision.

## Input

- Brief from `01-brief.md`: type, users, scale, data, functions that force architecture, team, constraints, and the existing stack or "none".

## Decide

Take A, B and C in order. Each decision needs a brief requirement that justifies it; if none does, drop it.

### A. Project type and platform

Answer these questions in order:

1. Who consumes the result: anonymous public, customers with accounts, internal staff, or machines?
2. Who changes the content, and how often? This decides files, CMS or database.
3. What forces leaving the browser: hardware without a reliable web API, Bluetooth, NFC or USB on iOS, guaranteed background work, store presence?
4. What forces a server: accounts, payments, shared data, real-time, scheduled jobs, secrets?
5. Where must it be found: a search engine, an app store, or both?

Recognized types: informational or marketing site, editorial site with CMS, online store, app with accounts (SaaS), internal tool, API or service, mobile app, browser extension, automation or bot. A project often combines several; a SaaS usually has a public landing plus an app behind login.

**Platform rule:** choose the most web option that covers the hard requirements, in this order: responsive web, PWA, web wrapper in a native shell, cross-platform, native. Move one step up only for a hard requirement.

- **Mobile:** leave the web only for a hard requirement, such as reliable iOS push, Bluetooth, NFC or USB, recent system APIs or widgets, or store presence with real native value. Apple's guideline 4.2 expects more than a repackaged website (verify). If an app is justified, a small team usually does better with a cross-platform category (for example Expo / React Native or Flutter) and goes native when the platform dominates [criterion]. Digital goods sold inside a mobile app are subject to the store's billing rules, and store review and testing requirements change: verify the Apple App Review Guidelines and the Google Play payments and testing policies on the day (volatile). Flutter's web FAQ advises against Flutter web for SEO and content sites (verify). A single person with content or forms: web before mobile [criterion].
- **Extension:** Manifest V3 structure, all logic in the package, no remote code (verify the store policy). **Bot:** a scheduled script with logs, not an application [criterion].

### B. Rendering model per zone (if there is a web interface)

Assess, in order: who must see the content without JavaScript (search engines, AI agents, social previews); whether the content is the same for every user; how often it changes and how stale it may be; how many URLs there are; how much interactivity exists and where; and whether there is operational capacity to run a server.

Default order, simplest first: **static (SSG) > regeneration or cache with invalidation (ISR) > per-request server rendering (SSR) > SPA**. Use an SPA only where public SEO does not apply, such as areas behind login.

### C. System architecture style

Default: a **modular monolith** with one database and managed services (database, auth, queues, storage) from day 1, until a measured signal justifies splitting something.

- "Modular" counts only when a tool enforces the boundaries in CI. Otherwise it is an ordinary monolith.
- Five axes decide any split: real need for independent deployment; team size and structure; a measured, different scale profile; operational maturity (CI/CD, tracing, on-call); domain clarity. No verified team-size threshold exists.
- Cheap and almost always valid: a queue with a worker for long tasks. Events with several consumers are a bigger commitment; use them only with real consumers.
- A backend-for-frontend only with several clients whose needs diverge. A managed backend (BaaS) suits an MVP with a standard database and your own API layer in front; check plan limits on the provider's pricing page. Serverless suits occasional tasks and peaks; check execution limits and lock-in.

## Do

### Content strategy

Ask who edits and how often before naming a tool.

| Editors and frequency | Approach | Watch out for |
|---|---|---|
| Developer, few changes | Markdown, MDX or JSON in Git | Non-technical editors cannot publish alone |
| Small non-technical team, weekly | Files in Git with a CMS interface on top of Git | Each publish triggers a build; Git-based login; limited editorial workflow |
| Non-technical editors, daily, many documents, roles, scheduling | Headless CMS with a database | Operating a database and backend; frontend must rebuild or revalidate |
| User-generated or highly relational data | Application database, not a CMS | A CMS duplicates the data model |
| One editor who wants an all-in-one CMS | Traditional coupled CMS | Continuous security updates; less control of frontend and performance |

- If content has relations, search, per-document permissions or high volume, use a database. If people read whole documents, use files.
- Define from the start how an update is triggered (webhook or schedule), how editors preview drafts, and what happens if the CMS is down during a build.

### Online store (occasional case)

Cart, payment and tax details are out of scope here. Ask what kind of store it is (catalog size, physical or digital goods, subscriptions, marketplace, atypical requirements), then offer two paths with their costs:

- **Existing commerce platform** (hosted or open): the default in most cases, because payments, taxes, stock and orders are already handled. For a handful of products, a payment-provider link on a static site can be enough.
- **Custom build:** only when the business model fits no platform. It takes on server-side payments and webhooks, taxes, stock, transactional email and compliance.

This recommendation comes from the skill's own criteria, not official documentation. Do not call any platform "the best". If the user chooses a custom build, continue with phases 04 and 05.

### Rendering checks

- Mix models per route, not per project. Isolate the dynamic part (static shell plus dynamic zone, or islands) before turning a whole route into SSR.
- Public content that must be indexed or cited by AI tools belongs in the first HTML response. Google recommends SSR or prerendering and calls dynamic rendering a workaround. Whether other AI crawlers run JavaScript rests on one 2024 third-party study: an indicator, not a guarantee. Verify with curl or JavaScript disabled.
- Edge is a deployment decision, not a content model (phase 6). Some frameworks have deprecated edge runtimes (Next.js; volatile, verified 2026-10-12): check status before proposing it.
- ISR depends on framework and hosting: check in the current docs whether it needs a server runtime, a shared cache across instances, and whether it works with static export.
- With streaming, check what a client without JavaScript receives. Measure before optimizing; Core Web Vitals (volatile, verified 2026-10-12): LCP up to 2.5 s, INP up to 200 ms, CLS up to 0.1, at the 75th percentile.

### Migration signals and usable evidence

Signals must be measured and repeated over several weeks or releases, never forecast.

- **Extract a service** when teams block each other on releases, a module has measured and different scale or availability needs, a regulation requires isolated data or process, or a component needs a technology the monolith cannot use. Prerequisites: CI/CD, correlated observability, versioned contracts, an owner on call. Method: strangle gradually from the edges.
- **Consolidate** when services almost always deploy together, one team operates them all, shared libraries force simultaneous updates, or most engineering time goes to plumbing rather than product.
- **Diagnose a distributed monolith** when one change touches several services and needs coordinated deploys, services share a database, schema or domain library, call chains are long and synchronous, or no service can be tested alone. Redesign boundaries with asynchronous coupling and owned data, or consolidate. Never solve it by adding services.
- **Move from BaaS to an own backend** when business logic must be hidden from the client, secrets or integrations are needed, declarative security rules become hard to test, costs grow non-linearly, or portability or residency is required. First step: your own API layer in front, not a rewrite.
- Usable evidence (primary sources): Segment, 2018, more than 140 services consolidated into one (read as a distributed-monolith case); Istio, 2020, control-plane components merged because they always shipped together; Shopify, 2020, a large modular monolith with boundaries enforced by tooling, with the caveat that its own analysis acknowledged many cyclic dependencies and only partial boundary coverage. Not used: the Prime Video case (primary source not opened) and blog team-size thresholds.

## Deliverable

A section of the decision record (phase 08) with:

- Project type or types and their brief reasons; target platform; content strategy.
- Rendering model per zone; architecture style and reason, with the default or the measured signal that overrides it.
- Alternatives discarded, and "signals that would reopen this decision".
- Volatile data with link and check date; `[NEED: …]` for anything that depends on a pending answer.

## Verify

- Each decision cites the brief requirement that justifies it; if there is none, drop it.
- Public content: check the HTML without JavaScript if something already exists; otherwise state that the check happens in phase 08.
- Volatile statements: open the current official documentation of the chosen framework or platform, and record version and date.

## Audit

Review mode: compare what was built with the brief. Check whether the rendering model fits the SEO and freshness required, whether an SPA serves public content, whether microservices lack independent deployment, teams or operational maturity, whether a mobile app replaced a web that would have sufficed, and whether a CMS or database has an editor and whether "modular" is enforced.

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Public content is visible without JavaScript when SEO is a goal | Load public routes with curl or JavaScript disabled; compare with the rendered page | Blocking |
| The chosen platform covers every hard requirement | Brief's hard requirements against the platform rule in A | Blocking |
| No microservices without independent deployment, team need and operational maturity | Deployment pipelines, team map, CI/CD and observability evidence | High |
| No unaddressed distributed-monolith signs | Coordinated deploys per change, shared database or libraries, long synchronous chains | High |
| A mobile app is justified by a hard requirement | Requirement list checked against the web option | High |
| "Modular" is enforced by a tool in CI | CI configuration with a dependency rule | Medium |
| Each CMS or database has a named editor and a preview path | Named editor; preview works for drafts | Medium |
| Volatile facts have a link and a check date | Record lists sources and dates | Medium |

Verdict per item: Pass / Improvable / Missing / N/A. Severity rule [criterion]: Blocking for invisible public content with an SEO goal or an impossible platform; High for over-engineering with real operating cost; Medium or Low for the rest.

## Gate

Do not move to phase 03 without:

- Project type or types and target platform, decided and justified by the brief.
- Content strategy and rendering model per zone.
- Default architecture style, or a measured signal that overrides it.
- Volatile data verified with a date, or marked as not verified.

## Not verified / to confirm

- Astro live content collections (status and version) and its route-caching guide; Nuxt edge presets; ISR with Cache Components in Next.js; Remix's own docs.
- Google Cloud and AWS or Azure Well-Architected pillars: not opened, not used as criteria.
- Safari Web Extensions and the wrapper-app requirement: not confirmed at the source.
- iOS PWA support beyond WebKit's 2023 article, and the EU status of home-screen web apps: only press reports.
- Chrome Web Store MV3 and Google Play payment policies: only search summaries were read.
- Commerce platform recommendation: own criteria, not checked against official platform sources.
- Fowler and Azure wording is paraphrased; re-check before quoting. The web.dev PWA capabilities page dates from 2022; use MDN or current browser tables instead.

Sources: web.dev, Rendering on the Web (https://web.dev/articles/rendering-on-the-web) and Core Web Vitals (https://web.dev/articles/vitals); WebKit, Web Push for web apps on iOS and iPadOS (https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/); Google Search Central, JavaScript SEO basics (https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics), dynamic rendering (https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering) and AI features (https://developers.google.com/search/docs/appearance/ai-features); Vercel, The rise of the AI crawler, third-party 2024 study (https://vercel.com/blog/the-rise-of-the-ai-crawler); Next.js, caching (https://nextjs.org/docs/app/getting-started/caching), ISR (https://nextjs.org/docs/app/guides/incremental-static-regeneration) and static exports (https://nextjs.org/docs/app/guides/static-exports); Astro, islands (https://docs.astro.build/en/concepts/islands/) and on-demand rendering (https://docs.astro.build/en/guides/on-demand-rendering/); SvelteKit, page options (https://svelte.dev/docs/kit/page-options); React Router, rendering strategies (https://reactrouter.com/start/framework/rendering); Microsoft, Azure Architecture Center, architecture styles (https://learn.microsoft.com/en-us/azure/architecture/guide/architecture-styles/) and Backends for Frontends (https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends); Martin Fowler, Monolith First (https://martinfowler.com/bliki/MonolithFirst.html), Microservice Premium (https://martinfowler.com/bliki/MicroservicePremium.html) and Microservice Trade-Offs (https://martinfowler.com/articles/microservice-trade-offs.html); Twilio, Goodbye Microservices (https://www.twilio.com/en-us/blog/developers/best-practices/goodbye-microservices/); Istio, Introducing istiod (https://istio.io/latest/blog/2020/istiod/); Shopify Engineering, Shopify monolith (https://shopify.engineering/shopify-monolith); Apple, App Review Guidelines (https://developer.apple.com/app-store/review/guidelines/); MDN, Making PWAs installable (https://developer.mozilla.org/en/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable); Flutter, supported platforms (https://docs.flutter.dev/reference/supported-platforms) and web FAQ (https://docs.flutter.dev/platform-integration/web/faq); React Native, environment setup (https://reactnative.dev/docs/environment-setup); Expo, workflow overview (https://docs.expo.dev/workflow/overview/); Google Play, target API level (https://support.google.com/googleplay/android-developer/answer/11926878); AWS, Lambda quotas (https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html); Supabase, pricing (https://supabase.com/pricing); Firebase, pricing (https://firebase.google.com/pricing).
