# Web page craft

Concrete craft for marketing and expressive pages, once the direction and system exist. Technology choice stays in [frontend routing](frontend-routing.md), system values in [design system](design-system.md), product screens in [product UI](product-ui.md).

Numbers are starting points from a gallery study (see [good design](good-design.md) §6). Brand and brief override them. Some of the strongest sites break usability on purpose; do not copy their preloaders, gates, tiny text or hidden navigation.

## The first screen

Within five seconds a stranger can say what this is, who it is for and what to do next. In one test of 97 first screens, 15 did not say what the thing was and lost on usability and content.

- One `h1` on the first screen that says what this is, at about 32 px or more. If it is a name or a figure of speech, the line below says plainly what the thing is.
- One supporting sentence directly under it, shown with it, not docked at the foot of the screen or held back by animation.
- One dominant element: a large headline or a leading picture (see [imagery](imagery.md)). Under about a third of the screen, a picture cannot dominate.
- No preloader or gate: the message is legible in the first frame. Most award sites studied opened with a loading screen, half were unreadable 2.5 s after load, the preloaders did not cover slower pages and only usability moved, downward.

## Headlines that fit

A headline is held in one glance: aim for two lines or fewer at every width, or justify more. A sentence set large over three or more lines reads as a long headline whatever its markup. Keep it as a statement instead: a `<p>` of about 25 words at no more than about 36 px on desktop and 24 px on a phone.

Do the arithmetic before committing to a sentence:

`characters per line ≈ line width ÷ (font size × k)`, with k ≈ 0.40 for condensed faces, 0.50 for most grotesks and serifs at display size, 0.58 for wide faces and all caps.

About 32 characters survives every width at a confident size, for example 44 px on a 350 px phone line. Past about 42 you are writing a sentence: move the rest into the supporting line. Never fix a long headline only by shrinking it.

Author the break where it matters, set `max-width` in `ch`, add `text-wrap: balance`, and check the phone. A line meant to fill the width is sized by measurement at 390 and 1440, not by eye: a name that starts on the margin and overruns the other side by a few pixels looks like a mistake.

## The frame

- Equal left and right margins at every width. Navigation uses the same inset as the content; a header on a different inset is the commonest small failure.
- Asymmetry lives inside the frame, never in it. A bleed starts from the margin and does not move it.
- Choose an anchor line and reuse it (headline, price, footer links): two or three left edges per page. Six means nothing was decided. Centring is a decision: one axis, generous flanks, one element per screen.
- Keep more distance between sections than inside them: about 120-240 px on desktop and 72-112 px on a phone.
- `min-height: 100vh` is only for sections that fill the screen. Prefer `svh` or `dvh`. For holes, see [good design](good-design.md) §4.

## Sections

- The order of the argument is the order of the page. List each section as a claim with its proof; a section with no claim is filler. On a conversion page this belongs to `landing-launch`.
- Neighbouring sections do not share a layout. Write one word per section (split, list, full-bleed, statement); the same word three times is the template showing. A repeated module is only for archives: work, menu, agenda.
- Keep the idea to the last pixel: if the page is a menu, its prices are menu lines. Break the system once, on purpose.
- Sections with running text open with a heading that names them. Short pages are fine.
- The footer is a designed close, not a sitemap.

## Navigation

Small furniture, no more than about a tenth of the first screen on desktop and one row on a phone. A fixed bar must not cover content at any scroll position; floating pills are where this failed most. On a phone: brand and one action, with links in a full-screen sheet. In tests, a navigation that took over the hero cost a full usability point. Links reach other pages or sections, and the current location is clear.

## The phone is a second composition

Rewrite line breaks, re-crop pictures to portrait with `object-position` per breakpoint, and keep irregularity through alternating widths. Margins of 16-20 px, body at 16-18 px, touch targets of 44 px or more. A row that scrolls sideways reads as cut off unless a partial card clearly shows the cut is deliberate, and the only copy of an action never lives inside it.

## Typesetting

Scale, tracking and measure are in [design system](design-system.md). On the web, also:

- Real quotation marks, ellipses and en dashes for ranges; a non-breaking space between number and unit and before a short last word in a headline.
- `tabular-nums` for prices, tables and dates; `hyphens: none` in titles; `text-wrap: pretty` in paragraphs.
- More space above a heading than below it, about twice as much.
- Optical alignment: round or diagonal initials (O, C, A, T, W) look indented, so pull large headlines about 0.04-0.06 em left.
- Under about 1.0 leading, check that descenders and ascenders do not collide.
- Do not change weight on hover (it reflows). Style `:focus-visible` and `::selection`.
- Load only the weights used, with a fallback of the same class, and confirm the face really loaded. Otherwise the screenshots you are judging are not the design.

## Motion implementation

The language of motion is in [motion graphics](motion-graphics.md). Craft that is easy to get wrong:

- Animate `transform`, `opacity` and `clip-path`. Use `will-change` only while animating. Name properties instead of `transition: all`.
- Hide content for a reveal only under `html.js` and `prefers-reduced-motion: no-preference`, so a script failure leaves it visible. Fire once with `IntersectionObserver` and `unobserve`, not a scroll listener.
- Hover goes behind `(hover: hover) and (pointer: fine)`.
- Menus and dialogs grow from their trigger, starting at a scale of about 0.95-0.98, never 0.
- Accordions: `grid-template-rows` from `0fr` to `1fr`.
- Line masks: add `padding-bottom: .08em` with a matching negative margin so descenders are not clipped.
- `animation-timeline: view()` takes the nearest scroller, and `overflow: hidden` creates one, so a framed image with hidden overflow never animates. Use `overflow: clip` or name the timeline on the section.
- Scroll-linked motion is linear: the scroll is the easing.
- A figure that counts up keeps the real number in the text for readers.
- Page transitions with View Transitions stay under about 480 ms and off under reduced motion.
- Load sequence: finish in about 1.2 s with four elements at most, preloading the display face and giving the hero image `fetchpriority="high"` with a sampled background colour.

Measured values, useful as tokens: expo-out `(.16,1,.3,1)` from about 800 ms up; `(.22,1,.36,1)` below 600 ms; in-out `(.76,0,.24,1)` for wipes and things that travel; `(.33,1,.68,1)` for photo drift. Stagger about 75-120 ms per line, 50-100 ms per item, and 20-40 ms per character only on headlines of one to three words. Overshoot was present in many stylesheets and rarely ran.

## Scroll scenes

A scene is a tall section with a `position: sticky` stage and a timeline tied to scroll. It does not capture the wheel, the scrollbar tells the truth, and it ends. It changes the whole screen; a fade-up, a small parallax or a sticky footer is not a scene. Use one only when scroll genuinely carries the story.

- **Fill it from the subject:** pictures from one family, phrases of 4-12 words, one at a time. If it could show anything, it is a gimmick. If pictures are missing, do not pad.
- **Legible at progress 0:** title, phrase and action are there from the first frame, with a real section heading.
- **A finished still** is what reduced motion, a script failure and some phones see. Each scene has a phone plan: the same with other numbers, a simpler version, or the rest state.
- **Costs:** pinned pages ran twice as long with fewer words per screen. Scroll hijacking lowered usability. A held sequence of more than two steps needs a plain count ("2 of 4"), and inactive items stay at 40% opacity or more, since 10-15% read as text that vanished. Put a quiet section between two scenes.
- **Check** contact frames at 0, 10 … 100% of the hold on desktop, phone and reduced motion: is there one clear thing to look at, does the phrase read, does anything jump, blank, clip or cross the text?
