# 3D and shaders

Use when a required visual idea depends on spatial, material or procedural graphics. 3D is a method and an asset source, not a mandatory route and not a separate deliverable category.

## Method before renderer

Build fidelity only where the idea needs it. A common conditional path: **previz / blocking / camera** in a lightweight scene, then a **proxy or reference image**, then **compatible generation control** where the interface and model accept it. Control conditioning is not a copy of exact geometry, and cross-clip identity is not guaranteed; promise appearance and control, not exact geometry or identity. Bring in a complex offline renderer only when its role in the piece justifies the project and runtime cost.

## Choose the layer

- **Three.js** for web 3D scenes, product/model rendering, procedural geometry, particles, postprocessing and custom materials.
- **React Three Fiber (+ Drei)** when 3D must live inside a React tree; it does not remove the need to understand cameras, geometry, lighting and performance.
- **PixiJS** when the problem is fundamentally 2D: sprites, particles, filters, textures, compositing.
- **Blender** when 3D must be authored or rendered rather than only displayed: modeling, UV/material work, lighting, Geometry Nodes, simulation, camera animation, offline quality, or Python-driven batch generation. Its outputs can feed GLB/glTF, image sequences, textures or finished video.
- **Unreal Engine** only for a production-scale cinematic target where the environment can realistically be operated; its project footprint is much heavier than Three.js or Blender scripting.

## WebGL vs WebGPU, shader routing

Treat both as platform APIs, not design tools. WebGL/WebGL2 is mature and broadly compatible; WebGPU is newer with an evolving browser ecosystem. Prefer engine abstractions unless direct GPU control is necessary. Evaluate `WebGPURenderer`/TSL compatibility before migrating an existing shader or material stack.

For shader language: **GLSL** for WebGL-oriented custom vertex/fragment shaders; **TSL** for Three.js's node/material ecosystem and `WebGPURenderer`; **WGSL** only for direct WebGPU or frameworks that require it. Do not drop to raw shader code when engine materials express the effect cleanly.

## Effects that justify shaders

Procedural noise/materials, distortion/displacement, liquid/refraction, dissolve, holographic/interference, raymarching/SDF, custom particle simulation, depth-aware post effects, and pixel-based transitions. If a CSS mask, gradient or filter achieves the effect at the required quality, use the simpler layer.

## Web asset pipeline

Prefer glTF/GLB for delivery. Reduce polygon count, pack/resize textures, use compressed formats, compress geometry where supported, keep animation clips intentional, and separate static from animated assets. Measure GPU memory, load time and frame rate on representative hardware.

## Camera, lighting and postprocessing are design decisions

A premium 3D result depends as much on camera/lens, framing, light direction, roughness, color management and motion as on model complexity. Do not make a default orbit-camera product spin the universal 3D answer. Bloom, chromatic aberration, grain, depth of field, vignette, glitch and motion blur are strong stylistic signals: use them only when they support the concept and do not damage legibility or product fidelity.

## Choose 3D only when it does work

Do not add 3D because an engine is available. A default orbit-spin or a floating object in the hero is not a concept. When 3D is decorative or nonessential, provide a static or 2D fallback and keep essential content in accessible DOM/text. When it is interactive, give it real controls and a fallback rather than a decorative canvas that competes with navigation.

## Generative 3D and references

When generation is involved, choose inputs from the actual interface and checkpoint rather than from a model name: image initial/last, proxy video, pose, tracks, cameras. Each model declares its own contract, and seed reuse does not guarantee cross-platform or cross-version determinism. See [generative media](generative-media.md) and [official docs](official-docs.md).
