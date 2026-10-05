# Generative media

Use when image or video generation is part of the method. Generation is a shared capability across web, audiovisual and fixed graphics, not a medium of its own.

## Appearance is not motion control

The most important distinction: conditioning that supplies **appearance** is not the same as conditioning that controls **motion**. An initial image, a last image, a proxy video, a pose sequence, point tracks or a camera path are different inputs with different contracts. Do not assume a model supports all of them because its name suggests it, and do not assume a "last image" works identically across pipelines.

Choose the input from the **actual interface or checkpoint**, not from a model name or a paper abstract:

- initial image, last image, or first/last pair;
- proxy video with pose/depth/flow/scribble/layout control;
- reference images for subject, content or style;
- pre-processed pose or face video where the interface requires it;
- explicit camera parameters or 3D point tracks where the interface accepts them.

Conditioning **constrains** appearance and coarse movement; it does not copy exact geometry and does not guarantee cross-clip identity. Do not promise Blender-level geometry, exact character consistency or camera continuity that the interface has not demonstrated.

## Inputs are conditional per model

Each pipeline exposes its own control points: a conditioning scale, a pre-processed control video, a required face input, an explicit camera track. Read the installed version's official documentation and the model card for the exact fields, supported tasks and limitations. A generic catalog entry is not proof that a specific control exists. Different engines can coexist; keep one owner per output property.

## Generated footage as a reference for authored graphics

If generated footage guides a later drawing or animation pass, choose the transfer method explicitly: visual reference for manual authoring, tracked poses/contours, masks and occlusion layers, depth/camera estimates, or raster stylization. An RGB video does not automatically supply a rig, vectors, depth or reusable trajectories. Identify what data is available, what must be estimated or authored, and how source time maps to the final timeline.

JavaScript describes an implementation, not a required vector format. Clarify whether the brief accepts stylized source pixels, a hybrid composition or independently drawn graphics; do not silently substitute one for another. Before generating a batch, test the chosen bridge on a representative short clip within the approved scope, including relevant camera changes, occlusions, identity and synchronization. If the bridge fails, revise the method or simplify the shot rather than repeatedly generating bases that cannot be transferred. Until that clip can be inspected, its feasibility remains unverified.

## Asset roles and preparation

Prepare assets for their actual consumer: a still, an opaque loop inside a window, a full-frame plate and a foreground cutout have different needs. Request alpha, depth or tracking work only when it serves selection, inspection or the intended composition, rather than processing every generated clip by default. For cutouts, inspect edges, spill, intended transparency and placement on the target background across a temporal sample; one clean matte still does not establish stable alpha or anchoring.

When collecting batches, associate each selected asset with its actual job/take/candidate identity and available source, not merely its prompt text. Keep requested, submitted, received and validated states distinct in the existing asset record. An acknowledgement or an identical prompt does not prove that the intended media arrived or is ready for its consuming shot.

## Reproducibility

A shared **seed** does not guarantee identical output across platforms, versions or even runs: generators are consumed differently between versions. Record seed, checkpoint version, inputs, outputs and environment only when the case actually needs reproducibility, not as a universal framework. Verify the installed version rather than freezing an older catalog; see [official docs](official-docs.md) and the diffusers guidance on reusing seeds: https://huggingface.co/docs/diffusers/using-diffusers/reusing_seeds

## Evidence and claims

Do not judge a model by paper accuracy numbers on a subset. A benchmark over a fraction of frames is not the whole-output success rate; report what was actually tested and how. Treat reported metrics, environment snapshots and VRAM examples as observations, not universal minimums: a large-GPU example is not a hardware floor, and CPU offload is not CPU-only execution. Weight and model licenses are not soft assumptions; verify the actual license for the intended use.

## Rights before use

Clear rights **before** composing, downloading, generating or rendering:

- A public image is not automatically licensed for use; model-advertising permissions are not the same as a license to use.
- Generated music, fonts and voices still need clearing.
- Do not upload, clone or publish material without explicit authorization, and do not treat a generation step as a license.

## QA and validation

Generated output requires real inspection, not a prompt promise. For UI, labels, exact text, measurements or product geometry, prefer controlled authoring or generation only under explicit authorization, and validate the result at the real size and in the real context; generation does not guarantee legibility or factual fidelity. State limitations concretely instead of implying a capability that was not verified.
