# 04 — Data

Decide whether the project needs a database and which family, where and how the data is operated, and which auxiliary stores hold copies of it. This is the hardest decision to reverse, so decide it from the brief's requirements, not from familiarity with a product. If a database already exists, start from it and check its operation and fit. This phase records a data map in the decision record. It does not do legal analysis.

Labels: `[criterion]` marks the skill's own rule, which has no official source. Unlabeled statements on engines, consistency, backups and migrations come from the sources in the last line; the decision rules and defaults are the skill's own synthesis unless a source is named.

Index: Input · Decide (A database, B operation, C auxiliary stores) · Do · Deliverable · Verify · Audit · Gate · Not verified / to confirm

## Input

- Brief (01-brief.md): data stored, sensitivity, who writes it, scale, criticality, residency, minors or special categories of data.
- Decisions from 02-type-and-architecture.md and 03-language-and-framework.md; planned provider from 06-deployment-and-infrastructure.md.
- Existing database, if any: engine, version, backups, migration tool.
- `[NEED: expected volume, write rate and number of concurrent writers]`

## Decide

### A. Is a database needed, and which family

Ask which data changes, who writes it, how many writers act at once, and what happens if it is lost. Do not start from "which database do I use".

- **Files in Git** (JSON, Markdown): fine for content changed by deploys and edited by the team. Stops being enough when users write in production, writes are concurrent, or content changes without a redeploy.
- **Third-party service** (forms, CMS, CRM, payments, auth): fine when the data belongs to a solved domain. Stops being enough when it must be joined with your data, exported with guarantees, or when lock-in or cost exceeds operating a database.
- **Spreadsheet**: small volume, few editors, no critical integrity.
- **Object storage**: binaries and whole-object reads by key. Consistency is per object; there are no atomic updates across keys and no locking for concurrent writers (documented for Amazon S3; check other providers).

Rule [criterion]: once users write in production, more than one process writes, or corruption would cost money or trust, it is no longer a file.

**Default rule** `[criterion]`: start with a general-purpose relational database unless a requirement rules it out. No official source states this. PostgreSQL covers JSON (`jsonb`), full-text search and, with an extension, vectors; MongoDB documents that good modelling reduces the need for transactions. It does not apply when the team already runs another technology that meets the requirements.

**Families** (apply each engine's documented limits):

- **Relational**: accounts, orders, permissions, integrity, joins. Weak for very large analytics or deep graph traversal as the main query.
- **Document**: nested structures read as one unit. Weak for many cross-entity queries or frequent multi-document transactions.
- **Key-value** (Redis, Valkey): sessions, cache, rate limits, counters. Not the sole source of truth, unless losing the latest minutes (snapshots) or about a second of writes (per-second fsync) is acceptable.
- **Columnar**: large-volume analytics. Weak for small transactional writes.
- **Graph**: relationship-centred traversals of variable depth.
- **Search**: ranking, typo tolerance, facets. Try the primary database's full-text search first; a search engine is a secondary index `[criterion]`.
- **Time series and vector**: database extensions first; a dedicated engine only with a measured need. Approximate vector indexes trade some recall for speed.

**SQLite** fits low to medium traffic sites on one machine, low write concurrency, local tools, and replacing ad hoc files. It does not fit a network between application and data, several writers, several servers, or a network file system (WAL does not work there).

**Consistency** is set per operation, not fixed by the engine (isolation levels, read concern, per-object reads). The "pick two of CAP" idea does not help choose an engine (Brewer, 2012; Kleppmann, 2015). If stale reads are unacceptable, as with money or inventory, raise the isolation level and design retries.

**Multi-tenancy (SaaS)**: a shared database with a tenant column, plus row-level security where used, is the cheapest. Stronger isolation only for per-tenant keys, per-tenant restore, residency, or noisy-neighbour load. PostgreSQL row-level security denies by default, but superusers, `BYPASSRLS` roles and the table owner bypass it; the application must not connect with those roles. Schema-per-tenant and database-per-tenant trade-offs have no official source reviewed `[criterion]`.

**Licenses** `[volatile: verify on the day]`: if the product is offered as a service or redistributed, read the current engine license. Several engines (Redis, MongoDB, Elasticsearch) have changed license over time.

**Change signals**: SQLite to client/server when several instances or writers appear; files to a database when users write or filtering by field is needed; third-party service to own database when data must be joined, exports are limited, or cost and lock-in grow; another family only with a measurement; stronger isolation for one tenant when per-tenant keys, restore or residency require it.

### B. Operating model

- **Managed**: the provider patches, backs up and fails over; you choose size and network.
- **Self-hosted**: full control; you operate everything.
- **Serverless**: near-zero idle cost; cold starts and connection limits.
- **BaaS**: fastest start; lock-in extends to auth, policies, storage and generated APIs.

Ask: who responds if it fails; the cost profile (constant or intermittent; backups, egress and replicas count); control needed (extensions, version, superuser); lock-in; plan limits (size, connections, backup retention, free-plan pauses); residency (the region is fixed at creation, backups and replicas have their own region, and a list of regions is not a legal guarantee); latency to the application; criticality, which sets RPO and RTO.

Rules: a small project with little data does not justify operating its own database `[criterion]`. Self-host only for a concrete reason and with someone who owns backups and tested restores [criterion]. Choose BaaS knowing the exit path. Do not put data that cannot be lost on a free plan before checking its backup and pause rules.

### C. Auxiliary stores and personal data

**Rule**: the simplest store that covers the requirement. Each extra store (cache, search, analytics, queue, bucket, backups, logs) is a copy of data that may be personal. Prefer the existing database, then a managed function, then a separate service. Move up only with a measurement.

**Sensitivity** is classified per field, and a copy inherits the level of its source:

- **Public**: CDN and long cache are acceptable.
- **Internal**: behind authentication; secrets in a manager.
- **Personal**: minimize; document purpose and retention per field and store; check authorization per object; make the data locatable per user in every store.
- **Sensitive or regulated** (for example health, biometrics, minors, payment data): isolated store with restricted, logged access; application-level encryption with separate keys; no copies to cache, search, analytics or logs. `[NEED: legal review]`

**Retention and deletion**: decide at the start how long each category lives and how it is purged from every store. Keep a map of where each personal data item lives. Backups are not rewritten: define their expiry and reapply deletions after a restore.

**Region**: set the region of the database, objects, backups and logs from the brief; default to the main market's region `[criterion]`.

## Do

1. **Data map.** One row per store: store, data, sensitivity, retention, region. Write `[NEED: ...]` where a value is unknown.
2. **Recovery.** Write RPO and RTO. Schedule the first restore test with a date and record the measured RTO.
3. **Store choice.** Apply decisions A and C to each requirement in 01. Record the discarded options.
4. **Operations.** Set up the migration pipeline and the connection plan (below).
5. **Volatile facts.** Open each linked page on the day of the decision and record the value with its date: engine versions and support windows, licenses, backup retention, pricing, free-plan limits, region lists.

### Operating details

- **Backups**: a logical copy is portable and selective but has no point-in-time recovery (PITR); a physical copy restores fast but is tied to the engine version. PITR is needed against human error when RPO is minutes. A backup that has not been restored is an assumption: restore periodically in a separate environment and measure the RTO. Keep at least one encrypted copy outside the failure domain, with separate credentials; some providers delete automatic backups with the instance. The 3-2-1 rule is common practice, not verified against an official source `[criterion]`.
- **Migrations**: versioned in the repository; immutable once applied to a shared environment; reviewed in pull requests, including generated SQL; applied by the pipeline with a user other than the application's; one run at a time; backup before destructive operations; roll forward by default. Incompatible changes use expand/contract (add, dual-write and backfill, switch reads, then remove; do not skip the last step). In PostgreSQL, `ALTER TABLE` takes `ACCESS EXCLUSIVE` by default, so check locks and test on realistic volume.
- **Connections**: serverless applications use a pooler; migrations and admin tasks use a direct connection. Transaction-mode poolers break session state and some prepared statements. Planned connections (instances times pool size) stay below the server limit with headroom.
- **Encryption and secrets**: TLS in transit with certificate verification (in libpq, `sslmode=require` does not protect against man-in-the-middle; `verify-full` does). Some providers allow at-rest encryption only at creation; check before creating. Secrets live in a manager, never in the repository or images; least privilege per service and environment; the application account is neither owner nor superuser; the database is not exposed to the internet without need.
- **Portability**: own the schema through migrations, run a periodic logical dump and restore it elsewhere, inventory what does not export (auth, policies, storage, functions), and write the exit plan.
- **Auxiliary stores**: files, objects and cache. Binaries go to a private bucket with metadata in the database; access by short-lived signed URL (a signed URL is a bearer credential) or a per-object permission check. Cache public, identical responses only; personalized responses need `Cache-Control: private` or a per-user key, since a cookie does not make a response private; use a full cache key and purge on revocation. Background jobs start as a table in the database (atomic with the data; `FOR UPDATE SKIP LOCKED` in PostgreSQL), with idempotency, capped retries and payloads that carry IDs rather than personal data; use a managed broker only at high volume. Search stays in the database until typo tolerance, autocomplete, facets at scale or fine relevance are required; search terms always go as bound parameters. Analytics gets its own tables or a read replica, with opaque IDs and no email or free text. Payments are delegated to the gateway; hosted pages or redirects have a smaller PCI scope than an embedded iframe. Logs carry no secrets or card data. Authorization denies by default and checks each object centrally. Encryption uses an authenticated AES mode with keys separate from data, held in a manager and rotated; passwords use a password hashing function.

## Deliverable

Decision-record section (08-decision-record-and-skeleton.md):

- Data map by store, with sensitivity, retention, region and any `[NEED: legal review]`.
- Engine, operating model and region; RPO and RTO.
- Backup policy and restore-test status (done, or scheduled with a date).
- Migration strategy; auxiliary stores chosen and discarded; exit plan.
- Discarded alternatives and signals that would trigger a review.
- `[NEED: ...]` where a team answer is missing (volume, RPO, residency).

### Relation to legal matters

This phase does not do legal analysis and does not invoke the legal phase of the landing-launch skill. It records the data map (personal data, store, retention, region) in the decision record and marks `[NEED: legal review]` where sensitive data, minors or transfers require it. When public pages are built later, the legal phase of landing-launch reads that map to decide which documents and consents are needed. The handoff is a read of the record, not a back-and-forth.

## Verify

- Each store traces to a requirement in 01; each personal data item has a decided retention and location.
- A restore has been tested or is scheduled with a date, and the measured RTO is recorded.
- The engine version has active support on its official page, opened that day.
- The engine license was reviewed if the product is offered as a service.

## Audit

Evidence that needs another user's session, live endpoints or provider consoles requires the user's permission first; use a non-production environment where possible.

| Check | How to verify (evidence) | Severity if it fails |
|---|---|---|
| Database exposed to the internet or without TLS | Network rules; server TLS setting; client certificate verification | Blocking |
| Database credentials in the repository | Search of the repository and images | Blocking |
| Shared cache serves personalized responses | Cache headers and cache key on personalized routes | Blocking |
| Paying-customer data without a copy outside the failure domain | Copy location and separate credentials | Blocking |
| Backups never restored | Restore record with date and measured RTO | High (Blocking if the data is customer or critical data) |
| No copy outside the failure domain (other data) | Copy location and separate credentials | High |
| Free plan used for data that cannot be lost | Plan's backup and pause rules, dated | High |
| Destructive migration without a prior backup | Migration review and backup timestamp | High |
| Sensitive data copied to cache, search, analytics or logs | Inventory of stores against the data map | High |
| No data map or retention policy | Data map and retention table in the record | High |
| Schema changed by hand in production | Production schema against migration history | Medium |
| Incompatible change without expand/contract | Migration review | Medium |
| Auxiliary store without measured justification | Store list with the measurement behind each one | Medium |
| Engine, version or license not reviewed | Record entries with page and date | Medium |

Verdict per item: Pass / Improvable / Missing / N/A.

## Gate

Do not move to 05-identity-and-services.md without: database need decided and justified; operating model and region chosen; RPO and RTO written; backup policy with a tested or scheduled restore; migration strategy; data map with retention and location; volatile data verified with a date, or marked as not verified. For a phase marked light in the triage, the gate is its one-line entry in the record.

## Not verified / to confirm

- Legal requirements: not analysed in this phase; see "Relation to legal matters".
- PCI DSS text not opened; the questionnaire-eligibility FAQ was seen only in search results. Ask the acquirer.
- Prices: Cloud SQL and Azure not verified; AWS RDS only pricing dimensions. The RDS backup retention range was not visible on the page read.
- pgroll (only the title seen) and `CREATE INDEX CONCURRENTLY` (official page not opened).
- Exporting auth users and password hashes from BaaS providers: not verified for any provider.
- Residency: only region lists were read; no legal guarantee was assessed. Transfer rules for the chosen region and providers: `[NEED: legal review]`.
- TimescaleDB, ClickHouse (transactions), Neo4j (ACID), MariaDB (dates, license), pgvector (license), dedicated search and vector engines: not verified.
- Prisma: the docs page and Context7 describe different commands; check against the project's version.
- Provider retention windows, plan limits, webhook retry periods and signed-URL limits for other SDKs: volatile or not verified; read the linked pages on the day.

Sources: SQLite, When To Use (https://www.sqlite.org/whentouse.html); SQLite WAL (https://www.sqlite.org/wal.html); PostgreSQL versioning (https://www.postgresql.org/support/versioning/); PostgreSQL licence (https://www.postgresql.org/about/licence/); PostgreSQL transaction isolation (https://www.postgresql.org/docs/current/transaction-iso.html); PostgreSQL JSON types (https://www.postgresql.org/docs/current/datatype-json.html); PostgreSQL full-text search (https://www.postgresql.org/docs/current/textsearch-intro.html); PostgreSQL row security (https://www.postgresql.org/docs/current/ddl-rowsecurity.html); PostgreSQL schemas (https://www.postgresql.org/docs/current/ddl-schemas.html); PostgreSQL SELECT locking (https://www.postgresql.org/docs/current/sql-select.html); PostgreSQL backup (https://www.postgresql.org/docs/current/backup.html), dump (https://www.postgresql.org/docs/current/backup-dump.html) and continuous archiving (https://www.postgresql.org/docs/current/continuous-archiving.html); PostgreSQL ALTER TABLE (https://www.postgresql.org/docs/current/sql-altertable.html); PostgreSQL connection settings (https://www.postgresql.org/docs/current/runtime-config-connection.html); PostgreSQL libpq SSL (https://www.postgresql.org/docs/current/libpq-ssl.html); PgBouncer features (https://www.pgbouncer.org/features.html); pgvector (https://github.com/pgvector/pgvector); MySQL 8.4 InnoDB (https://dev.mysql.com/doc/refman/8.4/en/innodb-introduction.html); MongoDB transactions (https://www.mongodb.com/docs/manual/core/transactions/); MongoDB read concern (https://www.mongodb.com/docs/manual/reference/read-concern/); MongoDB server-side public license (https://www.mongodb.com/legal/licensing/server-side-public-license); Redis persistence (https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/); Redis licenses (https://redis.io/legal/licenses/); Valkey (https://valkey.io/); Elastic, open source again (https://www.elastic.co/blog/elasticsearch-is-open-source-again); Amazon S3 consistency (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html); Amazon S3 presigned URLs (https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html); Microsoft, multitenant storage (https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/approaches/storage-data); Brewer, CAP twelve years later (https://www.infoq.com/articles/cap-twelve-years-later-how-the-rules-have-changed/); Kleppmann, A Critique of the CAP Theorem (https://arxiv.org/abs/1509.05393); Fowler, ParallelChange (https://martinfowler.com/bliki/ParallelChange.html); MDN, HTTP caching (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching); Stripe, idempotent requests (https://docs.stripe.com/api/idempotent_requests), webhooks (https://docs.stripe.com/webhooks) and security guide (https://docs.stripe.com/security/guide); OWASP Database Security (https://cheatsheetseries.owasp.org/cheatsheets/Database_Security_Cheat_Sheet.html), Secrets Management (https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html), Cryptographic Storage (https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html), Authorization (https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), Logging (https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) and SQL Injection Prevention (https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html); Supabase backups (https://supabase.com/docs/guides/platform/backups) and pricing (https://supabase.com/pricing); Neon pricing (https://neon.com/pricing); AWS RDS automated backups (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html); Azure Database for PostgreSQL backup and restore (https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore).
