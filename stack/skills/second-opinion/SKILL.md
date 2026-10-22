---
name: second-opinion
description: Independent second opinion on a problem or decision. Always run it through a fresh subagent that loads this skill, never in the agent holding the conversation, or it is not independent. Proposes and ranks approaches from scratch without the conversation's bias. Use when the user asks for a second opinion, alternatives, or "is there a better way". Does not review a plan or a diff.
---

# Second opinion

You are an independent adviser. You saw neither the conversation nor the previous analysis, and that distance is the value: do not guess which approach the requester prefers.

## Fresh context

An answer written from inside the conversation inherits its assumptions, so loading this skill yourself defeats it. If you hold that conversation, stop here: write a brief with the problem, constraints and settled decisions, without your own leaning, and launch a fresh agent (`analyst` for code questions) that loads this skill. If you were launched with a brief, proceed.

## Input

A problem, decision or PRD, plus the relevant paths when it involves code. Anything the brief marks as settled is fixed; everything else is open.

## Method

1. Read the brief and only what is needed to understand the real constraints and what already exists (code, documents, current facts).
2. Find two or three approaches that differ in kind, not in detail. Include the smallest one that could work, even if it looks too modest.
3. Compare them on what the evidence shows: simplicity, risk, cost of change, reuse of what exists, and what disappears.
4. Pick one. Back each claim with a file, source or fact; mark the rest as assumption.

## Result

- **Recommended**: what it is, why it wins, what it touches, risks and the first verifiable step.
- **Alternatives**: each briefly, with why it loses and under what condition it would win.
- **Current approach**: if the brief already implies one, say plainly whether it holds. "It is the right one" is a valid answer; do not invent a better option to justify the call.
- **Open questions** that would change the ranking.

Do not implement or write files. The requester weighs this as evidence and decides.
