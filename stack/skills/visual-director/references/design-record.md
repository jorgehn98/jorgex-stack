# Recording the visual system

Use only when visual decisions need a durable, reusable record. `DESIGN.md` is a useful convention, not a mandatory artifact.

## Choose the existing owner first

Inspect the project's design documentation, tokens, brand sources, master files and approved direction. If an existing document already owns the visual decisions, update or reference it instead of creating another. A one-off exploration can stay in the reply.

Keep responsibilities distinct and do not duplicate them:

- the **PRD** owns objectives, scope and business success criteria;
- the **execution plan** owns tasks, status, dependencies and gates;
- the **design record** owns visual intent, approved decisions and rationale;
- the **checkpoint/handover** owns evidence of what was inspected.

Do not keep both a visual plan and a design record as competing specifications, and do not turn the record into a task board. Read before extending; update only the changed visual contract with its rationale, and supersede outdated decisions clearly.

## One home per datum

Exact values have one authoritative source the project already chose: code, a token library, a master file such as Figma, or another project master. The design record explains intent; it does not become a second copy of the values. Do not assume code always wins over tokens or a design file; the canonical source is whichever owner the project established, and disagreements are surfaced, not silently resolved.

History lives in Git and the project's existing records, not in a duplicate JSON ledger. Do not maintain per-pixel provenance or require hashes for ordinary creative choices. Keep test results and implementation status in their existing owner.

## Distinguish states

For consequential details, mark:

- **Observed**: read from an identified token, stylesheet, approved asset or inspected render; name the source. A screenshot shows appearance but does not prove an exact font, token or timing.
- **Inferred**: an interpretation of hierarchy, mood or behavior; state the uncertainty that matters.
- **Declared**: stated by the user; preserve it literally when it matters.
- **Proposed**: a new visual choice to validate, not yet a fact.
- **Approved**: the user approved it or delegated that decision explicitly.

Keep **approved decision** separate from **pending technical verification**: a decision can be approved while its technical or audiovisual check is still pending, and the pending owner is recorded separately. A missing verification owner does not demote an approved decision to proposed.

## Contents

Include only what the deliverable needs: visual intention, audience and defining idea; redesign boundary (preserve/reinterpret/unresolved); colors by semantic role with exact values only when known or proposed; typographic roles and fallbacks; layout, spacing, density, surfaces and imagery treatment; motion/camera language with meaningful limits; responsive, reduced-motion and output-format adaptations; asset sources and reuse/licensing when material is reused; intentional exceptions and unresolved decisions. For video, include framing, legibility/hold-time intent and audio relationships.

## Provisional vs canonical

Working directions and iteration tokens are provisional and do not enter the canonical kit. When the user accepts a final piece **and asks for it to serve future work**, record it as an **approved example** with its scope: values, roles, composition, image/motion/audio where applicable, assets and rights, and a link to the real example version. This is automatic with that acceptance, without ceremonial extra approval.

A campaign example is not automatically an identity norm. Promoting it to a general identity rule requires explicit authorization or delegation (which can be the same acceptance if the user asked for a brand change). Otherwise the example stays recorded with its scope and the canonical rules remain unchanged.

A newly authorized direction may break the canonical kit for one piece while the kit itself stays protected. Update the canonical only through explicit approval or delegation; keep the previous version and what changed available through the project's history.
