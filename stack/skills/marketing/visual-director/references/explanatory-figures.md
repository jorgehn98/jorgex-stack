# Explanatory figures

Use when the piece must make a technical or abstract idea understandable through a crafted, often interactive illustration: an explainer figure for docs, an article, a landing section or a talk. It is a method, not a style: the figure may be isometric, flat, cutaway or typographic. If a plain diagram, chart or screenshot answers the question, use it instead; a metaphor earns its cost only when the idea is hard to see.

## The object is the explanation

Do not draw boxes, arrows and labels. Invent a real, well-made physical object whose working **is** the concept, and say in one sentence what moves and what that motion means.

| Concept | Object |
| --- | --- |
| A cache key that skips work when nothing changed | A pin-tumbler lock: the plug turns only when every pin matches |
| Seven render targets with different bytes per texel | A chest of drawers, each as deep as its bytes |
| One shared resource serving many consumers | A gantry whose single head visits many wells |
| Light that depends on facing | A small studio: key and fill lamps around a turntable |

Two failures to avoid: **too abstract** (stacked plates or labelled boxes that read as nothing) and **too flat** (one slab with a few lines, no parts, nothing to discover). Take a reference's finish, never its object.

## Truth first

Collect the real numbers and behavior before drawing: sizes, counts, thresholds, curves. Every readout, motion and caption must be true. Keep the model in one small pure module and drive the readout and the moving parts from it, so the figure cannot show a number its mechanism does not produce.

## Size it before building

State the size and cost before starting, and propose a reduced version instead of silently starting something huge.

- **Figure**: one mechanism, a few dozen parts, SVG, at most one shader layer. Build it.
- **Hero**: a dense object, several shader layers or one 3D subject. Say it is a long job, then build it unless the user wants something quick.
- **Epic**: a whole vehicle, plant or system with many moving parts. Give the estimate, propose a Hero that keeps the core of the idea, and build the Epic only if the user chooses it.

Have something viewable early and deepen it, rather than perfecting parts blind.

## Method

- Author it as code that writes SVG (or the project's component framework) from a parts list, with the geometry computed once and only changing shapes rebuilt per frame. Start from the existing stack; no kit or generator is mandatory.
- Group the parts (base, structure, mechanism, controls, the one subject) and give each a reason to exist. Detail must belong to the mechanism, never be noise.
- Draw back to front so nearer parts hide farther ones; split anything that wraps another part. Filled solids, not see-through wireframes.
- Tone carries hierarchy: base quiet, structure mid, subject strongest, and exactly one lit accent for the part the reader should watch. Use color only when color is the subject.
- Frame it: figure number, short title, interaction hint and live readout, with words kept out of the drawing.
- Motion is calm and time-based (eased follow or springs), responds to pointer and keyboard, pauses offscreen and stills under reduced motion.
- Add a shader (fire, water, light, steam) only for what lines cannot draw. Keep the drawing readable without it, ease every uniform with an attack and a decay so nothing pops, and design the light theme for paper instead of darkening the dark-theme colors.

## Verify

Judge it at two readings: at 1x it reads as one clear object; zoomed in, every region still has something true to find, and a bare face is unfinished work. Also check the narrow viewport (about 390 px), both themes, reduced motion, the no-WebGL fallback, and that every line ends on a surface, another line or a terminal dot. Inspect real renders; a source read is not a visual pass. See [quality bar](quality-bar.md).

## Tools and limits

Do not depend on a third-party kit or install one. If the user already has the open-source [Anatomy](https://github.com/wheresryan22/anatomy) skill (MIT), it can serve as technical help for dense isometric figures within the approved scope; its gallery publishing is an upload and needs explicit authorization. This reference summarizes its approach in our own words and is not a copy of its material.

Not for exact data charts, people or maps; for those see [graphic routing](graphic-routing.md).
