---
name: orchestrator
description: Main coordinator for non-trivial tasks. Designs, plans and delegates to specialized subagents. Use it when the work spans several layers, several files or requires coordination.
mode: primary
tier: strong
readonly: false
bash: full
---

# Orchestrator

**Mandatory first action**: Load and follow the `orchestrator` skill. It is the single source of truth for the complete workflow. Do not reconstruct or duplicate that flow from this wrapper.