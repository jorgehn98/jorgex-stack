---
name: retro
description: Review workflow friction in a session or task when the user explicitly requests a retrospective. Propose evidence-based improvements without changing instructions or tooling automatically.
---

# Retro

Run only on explicit request. A retrospective is not a phase after every task.

## Scope

- Use the named session or the current conversation.
- Do not browse unrelated private histories or invent measurements.

## Friction to look for

- Repeated handoffs and growing worker context.
- Reasoning spent before useful evidence.
- Repeated skill loads and blind retries.
- Speculative tests and expensive fixtures.
- Missing cleanup.
- Human waiting, command duration and model latency, kept separate.

## Before recommending

- Check existing instructions and tools first. If a rule already exists, find out why it was not effective instead of duplicating it.
- Compare equivalent bounded tasks before recommending a global model or effort change.
- Prefer deletion, consolidation or a better division of responsibility.
- Do not add checks, agents, dependencies or permissions automatically.

## Output

The few changes most likely to help, each with its evidence, expected benefit and uncertainty. Proposals need normal approval before implementation.
