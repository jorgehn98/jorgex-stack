---
name: skill-creator
description: Create, edit and evaluate skills for agents. Use when the user wants a new skill, wants an existing one improved or diagnosed, or wants its behaviour tested with test prompts, assertions, benchmarks or run-to-run variance.
compatibility: "For agents with a filesystem; parallel subagents and a browser when available, with the fallbacks below. Packaging needs Python 3 and PyYAML."
---

# Skill Creator

A skill for creating new skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run them with the skill available
- Help the user evaluate the results both qualitatively and quantitatively
  - While the runs happen in the background, draft some quantitative evals if there aren't any (if there are some, you can either use as is or modify if you feel something needs to change about them). Then explain them to the user (or if they already existed, explain the ones that already exist)
  - Use the `eval-viewer/generate_review.py` script to show the user the results for them to look at, and also let them look at the quantitative metrics
- Rewrite the skill based on feedback from the user's evaluation of the results (and also if there are any glaring flaws that become apparent from the quantitative benchmarks)
- Repeat until you're satisfied
- Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

## Scope

- Two separate activities: **create or edit** a skill, and **evaluate** it. Only the first is the default; run the evaluation when the user asks for it.
- Use what the current runtime provides. Parallel subagents and a graphical browser may be missing: use the fallbacks described below or skip that step and say so. Do not build wrappers to replace them.
- Evaluations spend model calls. Those, installations and external effects need explicit authorization; do not run them to verify an edit.

## Communicating with the user

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. Plenty of users are opening a terminal for the first time to build something for their own job; the bulk of them are probably fairly computer-literate.

So please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from assertions on the output. Skills with subjective outputs (writing style, art) still benefit from test cases, but grade the process — which references it read, which steps it took — instead of the taste of the result. Suggest the appropriate default based on the skill type, but let the user decide.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check available MCPs - if useful for research (searching docs, finding similar skills, looking up best practices), research in parallel via subagents if available, otherwise inline. Come prepared with context to reduce burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier
- **description**: The branches that should trigger it, plus one clause for when another skill needs it. This is the primary triggering mechanism and it sits in context every turn, so it earns harder pruning than the body: front-load the leading word, keep one trigger per branch — synonyms that rename a single branch are duplication — and do not restate what the body already says. Models tend to "undertrigger" skills, so make the branches concrete and say them directly, but cut everything that is identity rather than a trigger.
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill :)**

Decide the invocation mode before writing (see Invocation): it changes what the description has to do. That mechanism is declared in `compatibility`, not in a frontmatter field of its own, because not every runtime supports one.

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### The Information Ladder

Rank material by how immediately the agent needs it:

- **In-skill step** — an ordered action in SKILL.md. Each step ends on a **completion criterion**: the condition that says the work is done. Make it checkable — can the agent tell done from not-done? — and, where it matters, exhaustive ("every modified model accounted for", not "produce a change list"). A vague criterion invites finishing early.
- **In-skill reference** — a definition, rule or fact consulted on demand. A flat peer-set is a fine arrangement, not a smell: every rule of a review on one rung is still reference.
- **External reference** — reference moved into a linked file (`references/`, `agents/`), reached by a pointer and loaded only when the pointer fires.

A demanding completion criterion drives the legwork, whether the skill has steps or not: "every rule applied" binds a flat reference as "every step done" binds a sequence.

#### Progressive Disclosure

Moving material down the ladder keeps SKILL.md legible; moving too much hides what the agent needs. The test is **branching**: a branch is one path a run can take through the skill. Inline what every branch needs; point at what only some branches reach. A pointer's wording, not its target, decides whether the agent gets there — name the condition, not the file ("read this before grading a run that used scripts").

Keep 500 lines as a warning, not as the criterion. Keep a concept's definition, rules and caveats under one heading, so reading one part brings its neighbours. When a reference file is long enough that a run reads it in parts, give it a table of contents.

When a skill supports several domains, the branches are often the domains themselves:

```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

#### Invocation

A model-invoked skill appears in the agent's skill list with its description, which costs context every turn. A user-invoked skill fires only when someone types its name: no context load, but the person becomes the index that has to remember it exists. Default to model-invoked when the agent must reach the skill on its own or another skill must point at it; make it user-invoked only when it never fires on its own.

When hand-invoked skills multiply past what you can remember, write a router: one user-invoked skill that names the others and when to reach for each.

How a skill is marked user-invoked belongs to the runtime, not to the skill. State the mechanism in `compatibility` and do not assume the field exists everywhere.

#### Splitting

Split only when the cut pays for itself. Split by **invocation** when a distinct leading word should trigger a piece on its own, or another skill must reach it. Split by **sequence** when the steps still ahead tempt the agent to rush the one in front of it: keeping them out of view encourages the legwork on the current task.

#### Leading Words

A leading word is a compact concept the model already holds from pretraining — `red`, `tight`, `tracer bullets` — that the agent thinks with while running the skill. Repeated through the text it accumulates a definition in a few tokens and anchors a whole region of behaviour; in the description it links the user's own language to the skill.

Use one only when the prior it recruits matches the process you want. A near-synonym with the wrong associations steers execution, and an eval that only looks at the output will not show it.

#### Pruning

- One meaning, one authoritative place: changing the behaviour is a one-place edit.
- Check every line for relevance: does it still bear on what the skill does?
- Run the no-op test per sentence, not per line: does it change behaviour against the default? A line the model already obeys pays load to say nothing. Delete the whole sentence rather than trimming words from it.
- Prune, then re-run the evaluations once the user has agreed to the run. A sentence that looks redundant can be the one holding the hit rate.

#### Failure Modes

| Failure | Symptom | Defence |
|---|---|---|
| Premature completion | The step ends before it is done; attention slips to being done | Sharpen the completion criterion first; hide the post-completion steps only if the rush survives that |
| Duplication | The same meaning in two places | Keep it in one and point at it from the other |
| Sediment | Stale layers nobody dares remove | Prune with the tests above |
| Sprawl | Every line live and unique, and still too long | Move reference down the ladder, or split by branch |
| No-op | A line the model already obeys | Replace it with a stronger leading word, or delete it |
| Negation | Steering by prohibition, which names the banned thing | State the target behaviour; keep a prohibition only as a hard guardrail, paired with what to do instead |

#### Principle of Lack of Surprise

This goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
```markdown
## Report structure
Use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save test cases to `evals/evals.json`. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

See `references/schemas.md` for the full schema (including the `assertions` field, which you'll add later).

## Running and evaluating test cases

This section is one continuous sequence — don't stop partway through. Run the steps here rather than handing the job to another testing skill.

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.) and within that, each test case gets a directory (`eval-0/`, `eval-1/`, etc.). Don't create all of this upfront — just create directories as you go.

### Step 1: Spawn all runs (with-skill AND baseline) in the same turn

For each test case, spawn two subagents in the same turn — one with the skill, one without. This is important: don't spawn the with-skill runs first and then come back for baselines later. Launch everything at once so it all finishes around the same time.

**With-skill run:**

```
Execute this task:
- Skill path: <path-to-skill>
- Task: <eval prompt>
- Input files: <eval files if any, or "none">
- Save outputs to: <workspace>/iteration-<N>/eval-<ID>/with_skill/outputs/
- Outputs to save: <what the user cares about — e.g., "the .docx file", "the final CSV">
```

**Baseline run** (same prompt, but the baseline depends on context):
- **Creating a new skill**: no skill at all. Same prompt, no skill path, save to `without_skill/outputs/`.
- **Improving an existing skill**: the old version. Before editing, snapshot the skill (`cp -r <skill-path> <workspace>/skill-snapshot/`), then point the baseline subagent at the snapshot. Save to `old_skill/outputs/`.

Write an `eval_metadata.json` for each test case (assertions can be empty for now). Give each eval a descriptive name based on what it's testing — not just "eval-0". Use this name for the directory too. If this iteration uses new or modified eval prompts, create these files for each new eval directory — don't assume they carry over from previous iterations.

The step is done when every eval has a with-skill run and a baseline run in flight, each with its `eval_metadata.json` written. Launching them all together is the point: baselines that start later measure a different session.

```json
{
  "eval_id": 0,
  "eval_name": "descriptive-name-here",
  "prompt": "The user's task prompt",
  "assertions": []
}
```

### Step 2: While runs are in progress, draft assertions

Don't just wait for the runs to finish — you can use this time productively. Draft quantitative assertions for each test case and explain them to the user. If assertions already exist in `evals/evals.json`, review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Update the `eval_metadata.json` files and `evals/evals.json` with the assertions once drafted. Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

The step is done when every eval carries either assertions or an explicit decision to grade it only qualitatively.

### Step 3: As runs complete, capture timing and the path

When each subagent task completes, you receive a notification containing `total_tokens` and `duration_ms`. Save this data immediately to `timing.json` in the run directory:

```json
{
  "total_tokens": 84852,
  "duration_ms": 23332,
  "total_duration_seconds": 23.3
}
```

This is the only opportunity to capture this data — it comes through the task notification and isn't persisted elsewhere. Process each notification as it arrives rather than trying to batch them.

**Capture the path as well.** Two runs that reach the same output by different routes are not the same skill: the route is what you are fixing. Save `path.json` in the run directory with the ordered steps, the tools called and the skill files read:

```json
{
  "steps": ["read SKILL.md", "read references/checklist.md", "write run.py", "run tests"],
  "tools": ["read", "write", "shell"],
  "references_read": ["references/checklist.md"]
}
```

Take it from the transcript, not from the final output. If the runtime exposes no transcript, say so and record only what you observed.

The step is done when every completed run has both `timing.json` and `path.json`.

**Check variance when the numbers look unstable.** Before improving anything, rerun the same eval two more times and compare the three paths against their assertions. Passing by three different routes means the skill is not holding the process, even when every assertion passes. Save each repeat in `eval-<ID>/variance-<N>/`, outside the benchmark: the aggregator only reads `<config>/run-*`, so repeats kept that way stay diagnostic. The check is finished when each path is recorded and either they match step by step or the divergence is explained — in the skill, if the wording caused it, or in the eval, if the prompt allowed it. This is also the substitute for the baseline when the runtime has no subagents.

### Step 4: Grade, aggregate, and launch the viewer

Once all runs are done:

1. **Grade each run** — spawn a grader subagent (or grade inline) that reads `agents/grader.md` and evaluates each assertion against the outputs. Save results to `grading.json` in each run directory. The grading.json expectations array must use the fields `text`, `passed`, and `evidence` (not `name`/`met`/`details` or other variants) — the viewer depends on these exact field names. For assertions that can be checked programmatically, write and run a script rather than eyeballing it — scripts are faster, more reliable, and can be reused across iterations.

2. **Aggregate into benchmark** — run the aggregation script from the skill-creator directory:
   ```bash
   python -m scripts.aggregate_benchmark <workspace>/iteration-N --skill-name <name>
   ```
   This produces `benchmark.json` and `benchmark.md` with pass_rate, time, and tokens for each configuration, with mean ± stddev and the delta. If generating benchmark.json manually, see `references/schemas.md` for the exact schema the viewer expects.
Put each with_skill version before its baseline counterpart.

3. **Do an analyst pass** — read the benchmark data and surface patterns the aggregate stats might hide. See `agents/analyzer.md` (the "Analyzing Benchmark Results" section) for what to look for — things like assertions that always pass regardless of skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs. Compare the paths from Step 3 yourself: the analyst reads benchmark data, not run paths.

4. **Launch the viewer** with both qualitative outputs and quantitative data:
   ```bash
   nohup python <skill-creator-path>/eval-viewer/generate_review.py \
     <workspace>/iteration-N \
     --skill-name "my-skill" \
     --benchmark <workspace>/iteration-N/benchmark.json \
     > /dev/null 2>&1 &
   VIEWER_PID=$!
   ```
   For iteration 2+, also pass `--previous-workspace <workspace>/iteration-<N-1>`.

   **Headless environments:** If `webbrowser.open()` is not available or the environment has no display, use `--static <output_path>` to write a standalone HTML file instead of starting a server. Feedback will be downloaded as a `feedback.json` file when the user clicks "Submit All Reviews". After download, copy `feedback.json` into the workspace directory for the next iteration to pick up.

Note: please use generate_review.py to create the viewer; there's no need to write custom HTML.

5. **Tell the user** something like: "I've opened the results in your browser. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, come back here and let me know."

The step is done when every run has its `grading.json`, the benchmark exists and the viewer is open.

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json`.

### Step 5: Read the feedback

When the user tells you they're done, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "eval-0-with_skill", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "eval-1-with_skill", "feedback": "", "timestamp": "..."},
    {"run_id": "eval-2-with_skill", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

Kill the viewer server when you're done with it:

```bash
kill $VIEWER_PID 2>/dev/null
```

The step is done when every non-empty feedback line maps to a change, or to a reasoned decision not to change.

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** The tests in Pruning are the tool; here they come with an experiment attached. Read the transcripts, not just the final outputs, and remove whatever is making the model waste a bunch of time on things that are unproductive, then watch what the next iteration does.

3. **Explain the why.** Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the subagents all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the subagent writing a `create_docx.py` or a `build_chart.py`, that's a strong signal the skill should bundle that script. Write it once, put it in `scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases into a new `iteration-<N+1>/` directory, including baseline runs. If you're creating a new skill, the baseline is always `without_skill` (no skill) — that stays the same across iterations. If you're improving an existing skill, use your judgment on what makes sense as the baseline: the original version the user came in with, or the previous iteration.
3. Launch the reviewer with `--previous-workspace` pointing at the previous iteration
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

This is optional, requires subagents, and most users won't need it. The human review loop is usually sufficient.

---

## Package and present

Package the skill so the user can install it wherever they need it. Run the command from the skill-creator directory, which is where the `scripts` package resolves:

```bash
python -m scripts.package_skill <path/to/skill-folder>
```

After packaging, give the user the resulting `.skill` file path.

---

## Adapting to the runtime

The workflow above assumes parallel subagents and a graphical browser. Adapt when the runtime lacks them instead of skipping the whole evaluation, and keep the human review: it is the part that catches what the numbers miss.

**No subagents.** Run the test cases yourself, one at a time, following the skill's instructions. It is less rigorous — you wrote the skill and you run it with full context — but it is a useful sanity check. Skip the baseline runs, the quantitative benchmarking (a comparison without an independent baseline is not meaningful) and the blind comparison. Organize the results in iteration directories anyway, so the feedback stays traceable.

**No browser, display or `webbrowser.open()`.** Write the viewer with `--static <output_path>` and hand the user the file. If a browser is not an option at all, present each prompt and its output inline in the conversation and ask for feedback there: "How does this look? Anything you'd change?" Save the files the user needs to inspect to a writable path and tell them where.

**Read-only skill directory.** Copy the skill to a writable directory the runtime provides, edit there, and package from the copy. Keep the skill's directory name and its `name` frontmatter unchanged, so the installed skill is replaced rather than duplicated.

---

## Reference files

The agents/ directory contains instructions for specialized subagents. Read them when you need to spawn the relevant subagent.

- `agents/grader.md` — How to evaluate assertions against outputs
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The references/ directory has additional documentation:
- `references/schemas.md` — JSON structures for evals.json, grading.json, timing.json, path.json, benchmark.json and the rest

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Run the test prompts with the skill available
- With the user, evaluate the outputs:
  - Create benchmark.json and run `eval-viewer/generate_review.py` to help the user review them
  - Run quantitative evals
- Repeat until you and the user are satisfied
- Package the final skill and return it to the user.

If your runtime has a todo list, add these steps to it so you don't forget them.

Good luck!
