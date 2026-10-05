# Official documentation index

Curated entry points. Open a topic when you actually select that technology; do not preload the whole list. This file is not a frozen API reference: follow the links and verify current behavior, versions and licensing at the moment of use.

## Documentation-use rule

When a technology is selected:

1. Open its official docs.
2. Verify installation, version and API names rather than guessing.
3. Verify compatibility with the chosen renderer/framework.
4. For render/video tools, verify deterministic timing requirements.
5. For 3D/GPU tools, verify current browser/runtime support.
6. For commercial delivery, verify current licensing where it may affect the user.

Prefer the official source. If a documentation lookup service or its quota is unavailable, read the official docs directly; give current-API advice only from what you actually read, and do not run unverified setup scripts. Verify rather than treating an older catalog entry as current.

## Skill format / authoring

- Anthropic skill creator: https://github.com/anthropics/skills/tree/main/skills/skill-creator
- Agent Skills specification: https://agentskills.io/specification

## Video orchestration

- Remotion README: https://raw.githubusercontent.com/remotion-dev/remotion/main/README.md — new projects scaffold with `npx create-video@latest`; for an existing project, add `remotion` and `@remotion/cli` with the project's package manager and **compatible versions only, with approval**. Do not force a React migration.
- HyperFrames CLI README: https://raw.githubusercontent.com/heygen-com/hyperframes/main/packages/cli/README.md — `npm install -g hyperframes` requires Node >= 22 and FFmpeg. Its `init` may refresh global skills and its skip flag has been reported temporarily ignored, so treat init as a deliberate action, never an innocuous check; prefer the installed executable's `--help` and avoid re-downloading for validation.
- HyperFrames lifecycle reference: https://raw.githubusercontent.com/heygen-com/hyperframes/main/skills/hyperframes/references/skill-lifecycle.md
- HyperFrames composition schema: https://github.com/heygen-com/hyperframes/blob/main/packages/core/docs/core.md

## Web motion

- GSAP docs: https://gsap.com/docs/v3/ — ScrollTrigger: https://gsap.com/docs/v3/Plugins/ScrollTrigger/
- Motion docs: https://motion.dev/docs — React: https://motion.dev/docs/react
- Anime.js: https://animejs.com/documentation/
- Native: CSS animations https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_animations, Web Animations API https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API, View Transitions https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API, `prefers-reduced-motion` https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion

## Styling, color, typography

- CSS `oklch()`: https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch
- `font-display`: https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display
- Google Fonts variable fonts: https://developers.google.com/fonts/docs/css2

## Vector, 2D and data

- Rive runtimes: https://rive.app/docs/runtimes/getting-started
- Lottie web: https://github.com/airbnb/lottie-web
- PixiJS: https://pixijs.com/8.x/guides/
- D3: https://d3js.org/
- Motion Canvas: https://motioncanvas.io/docs/
- SVG guides: https://developer.mozilla.org/en-US/docs/Web/SVG/Guides

## 3D, shaders, GPU

- Three.js: https://threejs.org/docs/ — WebGPU renderer: https://threejs.org/manual/en/webgpurenderer — TSL: https://threejs.org/docs/pages/TSL.html
- React Three Fiber: https://docs.pmnd.rs/
- WebGL: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API — WebGPU: https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API — WGSL: https://www.w3.org/TR/WGSL/

## 3D authoring / cinematic

- Blender manual: https://docs.blender.org/manual/en/latest/ — Python API: https://docs.blender.org/api/current/ — Geometry Nodes: https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/
- Unreal Engine: https://dev.epicgames.com/documentation/unreal-engine/

Installing FFmpeg or Blender depends on the operating system and distribution; follow the official installation documentation for that system. Do not assume a universal `sudo`/`pip` command works everywhere.

## Media pipeline

- FFmpeg: https://ffmpeg.org/ffmpeg.html — filters: https://ffmpeg.org/ffmpeg-filters.html

## Design / authoring platforms

- Figma developer docs: https://developers.figma.com/ — Variables API: https://developers.figma.com/docs/rest-api/variables/
- Framer developer docs: https://www.framer.com/developers/

## Generative media

- Diffusers reusing seeds: https://huggingface.co/docs/diffusers/using-diffusers/reusing_seeds
- Per-model cards and interface docs from the installed source take precedence over a model name; verify supported inputs, checkpoints and licenses per version.

A large-GPU example is not a universal hardware minimum, and CPU offload is not CPU-only execution. Weights and models carry their own licenses; verify them for the intended use instead of assuming a soft license.

## Copyright and reuse

Do not copy upstream skills/code/assets wholesale by default; summarise methods and cite sources. Where reuse is authorised, check the applicable licence and preserve required copyright/licence/NOTICE text. A software license does not automatically license assets or model weights.
