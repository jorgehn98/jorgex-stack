# Motion language and graphics

Use this to design motion deliberately rather than adding effects after layout. It applies to web and to programmatic video; [video routing](video-routing.md) owns the production method and timeline model.

## Six jobs of motion

1. **Orientation** — show where something came from or went.
2. **Causality** — connect an action to its result.
3. **Hierarchy** — control what is noticed first.
4. **Continuity** — preserve identity through state or scene changes.
5. **Explanation** — reveal structure, sequence or data relationships.
6. **Emotion/rhythm** — make an important moment feel calm, urgent, playful, luxurious or physical.

Every major animation should have at least one job. Motion without a job is noise.

## Motion vocabulary

Define a project-specific vocabulary rather than animating ad hoc: entry/reveal behavior, exit behavior, emphasis behavior, transform origin, depth/parallax policy, overshoot policy, blur policy, mask/clip policy, camera-movement policy, transition family and idle-motion policy. Do not mix unrelated easing personalities without reason. Feed these into the motion tokens in [design system](design-system.md).

## Choose the tool by the motion problem

| Problem | Prefer |
| --- | --- |
| Simple hover/focus/state transition | CSS |
| Browser-native scripted keyframes | WAAPI |
| React presence/layout/gesture | Motion |
| Choreographed multi-layer timeline | GSAP |
| Scroll narrative/pinning/scrubbing | GSAP ScrollTrigger (only when scroll drives the story) |
| Standalone timeline/SVG engine | Anime.js |
| Interactive vector state machine | Rive |
| Preauthored AE vector playback | Lottie |
| Data-driven chart geometry | D3 + SVG/Canvas |
| Dense particles/sprites/2D filters | PixiJS |
| Custom procedural material/effect | Three.js/Pixi shader layer |
| Technical/vector explainer | Motion Canvas |

Do not add an engine that duplicates one already serving the project. Keep one owner per property and one primary clock.

## Easing and timing

Avoid linear timing for everything; match easing to physical and semantic behavior. UI confirmation should feel quick and decisive; large spatial movement can take longer because the eye must track it. Spring/overshoot implies elasticity or play, not every luxury or enterprise context. Constant speed suits scanners, progress and technical sweeps, not general UI. Treat durations as a system, not isolated guesses, and test at real scale and frame rate.

## Choreography and transitions

For important sequences: identify the focal element; decide what prepares attention; reveal/transform the focal element; let supporting elements follow; give the result a moment to register; transition out with a relationship to what comes next. This creates a sentence rather than a pile of simultaneous tweens.

Prefer motivated transitions: match shape, match color, object continuation, camera continuation, mask from existing geometry, typographic transformation, depth/focus shift, data transformation or material transformation. Generic crossfades are fine when continuity does not matter; do not force a spectacle between every scene.

## Kinetic typography

Typography can animate by whole block, line, word, character, variable-font axis, mask/window, path, 3D depth or replacement/morph. Choose granularity from reading: character-level motion is visually expensive and can destroy legibility.

## Particles and procedural effects

Before adding particles, define their semantic role: data points, atmosphere, energy, disintegration, network, dust/material or audio response. Choose PixiJS for dense 2D, Three.js for spatial/3D, and custom shaders when behavior is fundamentally per-pixel or procedural. See [3D and shaders](3d-shaders.md).

## Sound and motion

For video, sound shapes motion timing: music establishes macro rhythm, SFX sell contact, impact and transitions, and voiceover defines information pacing. Do not cut every visual on every beat; use sync selectively so the strongest accents stay meaningful.

## Reduced motion for web

When users request reduced motion: remove or flatten large parallax/camera moves; replace zoom/scale travel with opacity or immediate state changes where appropriate; preserve state feedback and hierarchy; keep essential explanatory transitions if they remain comfortable, simplifying them. The reduced version should remain designed, not merely disabled animation.
