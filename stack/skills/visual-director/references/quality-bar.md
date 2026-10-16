# Quality bar

Use this to evaluate a direction, prototype or deliverable against its brief. A piece does not pass merely because it is technically correct.

## Review a representative sample

Before inspecting, choose the sample that can expose the concept's important risks, and reuse valid existing evidence instead of repeatedly reviewing unchanged areas.

- **Web**: the defining viewport and interaction, relevant narrow and wide layouts, realistic content lengths, and reduced-motion behavior where motion matters.
- **Video**: full playback plus representative frames around important beats, transitions and text, **with audio when present**.
- **Fixed graphic**: the piece at its real viewing size and in its destination context.
- **3D**: the defining view/interaction, realistic target-device conditions, and the fallback when nonessential graphics fail.

Collect related findings in one pass, prioritize what compromises the brief, and correct as a coherent batch; then re-check only the changed areas and affected dependencies. There is no fixed review count: new material defects require another check, while unbounded cosmetic polishing is not a completion criterion. Record what was inspected, the finding and the remaining limit in the existing delivery/checkpoint — not in another review panel, backlog or ledger.

## Two axes

Review both the **creative** axis (direction, coherence, hierarchy, rhythm, legibility, emotion) and the **technical** axis (viability, performance, accessibility, compatibility, export, cost). Either can pass while the other fails. Do not self-congratulate: report evidence, not opinions about your own work.

## Common checks

- **Specificity**: does the design clearly belong to this subject? Are palette, type, material and motion traceable to the brief?
- **Hierarchy**: is the primary message obvious, one focal point at a time, with quieter secondary information and motion that reinforces rather than competes? One entry dominates, with at least two of scale, weight, space, tracking and alignment pushing the same way. The failures are flat hierarchy (everything similar, such as a ladder of near-identical weights or uniform spacing) and noisy hierarchy (many things competing).
- **Typography**: are typefaces intentional and licensed for the use, are weights/widths/line-heights coherent, is body copy readable at real size, and is display type doing useful work?
- **Color**: is the palette role-based, is contrast sufficient for UI and captions, do accents stay meaningful, and does it survive imagery/video/3D backgrounds?
- **Motion**: can each major animation justify its purpose, is there a consistent vocabulary, enough stillness, and are the biggest motion moments attached to the biggest content moments?
- **Restraint**: when an effect looks unnecessary, compare with and without it; remove it only if clarity or coherence improves — do not strip intentional ambition to satisfy the pass.
- **Stack sanity**: state each library's job in one sentence; if two tools share a job, simplify unless there is a clear reason.

## Generic tells that can be checked

Beyond the defaults listed in [visual direction](visual-direction.md), these can be verified by looking: more than one small tracked-caps eyebrow per three sections, or numbered eyebrows and status dots used as decoration; product "screenshots" faked from styled divs where a real capture or an honest placeholder belongs; invented metrics, logos or testimonials (leave a visible neutral marker such as "—" instead); more than three equal columns in a row, one layout family repeated down the page, or image/text zigzag three times; a hero with more than about four text elements; designer controls (viewport or platform toggles, tweak panels) left in the final product. A tell is a prompt to justify the choice, not an automatic failure; mostly proven patterns with a distinctive minority is a healthy mix.

## Web checks

Responsive from narrow mobile to the intended desktop range; visible keyboard focus; reduced-motion behavior designed; intentional loading states; no content inaccessible because Canvas/WebGL fails; animation does not destroy scroll/input responsiveness; 3D/media lazy-loads; text reflow and real data lengths do not break the composition; key breakpoints visually inspected where tooling allows.

## Video checks

First seconds establish interest quickly enough for the platform; every scene has one primary idea; on-screen copy stays readable for its duration; motion and voiceover do not compete; cuts have rhythm and motivation; the mix supports rather than masks speech; the end card/CTA holds long enough; the message survives with sound off where the destination autoplays muted; a loop joins without a visible hitch; no accidental blank or duplicate frames; a deterministic re-render is stable; codec/container/resolution/fps are correct; compression does not destroy fine lines, gradients or text. For programmatic video, also: measure frame-to-frame change to catch stretches that look animated but are static; export a contact sheet around each transition at the full frame rate; sample overflow, clipping and text contrast at several timestamps rather than one; and for chained clips compare the last frame of one with the first of the next to check the seam.

## Fixed-graphic checks

For explanatory figures, also check two readings (one clear object at 1x, something true to find when zoomed) and that every number shown comes from the model that moves the parts; see [explanatory figures](explanatory-figures.md). Message and eye order are clear; copy is exact; the crop preserves meaning; the piece reads at the actual size; dimensions, alpha and color suit the destination; fonts and assets are licensed.

## 3D checks

Camera/lens intentional; lighting and materials support the subject; scale and framing communicate it clearly; no default orbit/spin unless appropriate; geometry/texture/postprocessing cost fits the target; a fallback exists when 3D is nonessential.

## Pending is not passed

Approval is not technical QA. If a preview, render or audio cannot be inspected, record the verification as **pending**, with its cause, never as passed. Do not fill a gap with an "OK": an empty review is not a pass. Still frames do not establish pacing or audio, and a source inspection is not a rendered visual pass.

## Stop conditions

Stop when the piece meets the brief or is accepted, when no material improvement remains, when resources are exhausted, when the work is out of scope, or when a permission is missing. Do not apply collateral polish to an already accepted piece without a new goal.
