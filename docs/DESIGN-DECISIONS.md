# Design Decisions

Architecture Decision Records (ADR-style) for baton. Each one captures
the context, the decision, and the consequences, including the trade-offs we
accepted and the defects we chose to handle elsewhere. The code follows from
these decisions.

---

## ADR-1 — One PiperFlow DSL, three consumers

**Context.** A business-process description can be consumed by very different
audiences: stakeholders want a picture, BPM suites want interchange XML, and
engineers (or agents) want an executable. Naively each is a separate artifact
that drifts.

**Decision.** Make a single text format (PiperFlow) the source of truth, parse
it once into a `ProcessAST`, and have three independent consumers of that AST:
`renderDiagram` (PNG/SVG), `renderDiagram(bpmn)` (BPMN 2.0 XML), and
`emitFlueWorkflow` (runnable Flue code).

**Consequences.** (+) No drift: change the DSL, all three update. (+) The AST
is a clean validation boundary (orphans, dangling refs caught before any
render). (+) Adding a fourth consumer (e.g. a docs generator) is easy.
(-) Consumers must agree on the grammar; a parser change ripples to all three.
That's the point.

---

## ADR-2 — Build-time resolution with a lockfile (online discovery, offline runtime)

**Context.** The project is self-hosted by design: it runs on a local vLLM
with no per-token cost and no data egress. But open-ecosystem skill discovery
(skills.sh) needs the network. Wiring discovery into runtime directly would
break the offline guarantee and couple execution to network availability.

**Decision.** Discovery is **build-time only**. `resolve:skills` writes a
reviewable `skills.manifest.json`; `lock:skills` installs skill files into the
repo via `npx skills add` + `skills-lock.json`; codegen reads the *locked*
wiring. Runtime never touches the network.

**Consequences.** (+) Offline runtime preserved. (+) Reproducible: the lockfile
restores the exact skills (`npx skills experimental_install`). (+) Reviewable:
humans see what was discovered before it ships. (-) Skills go stale until you
re-resolve. That's an acceptable, explicit trade for determinism.

---

## ADR-3 — Self-healing generation (recover, don't fail)

**Context.** The model authors the DSL from natural language, and its output is
occasionally imperfect: orphan elements, dangling edge references, semantically
inverted gateways. A pipeline that dies on the first imperfect output isn't
useful in practice.

**Decision.** `design-process` runs a bounded retry loop: parse + render → on
failure, summarise the precise error and feed it back to the model as a repair
instruction, up to 3 attempts.

**Consequences.** (+) Vague/complex prompts succeed that previously crashed (a
"self healing agent harness" prompt failed attempt 1, succeeded attempt 2,
observed). (+) The error fed back is *precise* (orphan detection gives element
ids, not a Python traceback). (-) Costs extra model calls on failure, bounded
at 3. (-) The loop can't fix defects the model can't recognise, but it surfaces
those as a clear final error instead of a cryptic one.

---

## ADR-4 — Graceful-degradation rendering (valid input never dies)

**Context.** `processpiper` renders the BPMN swimlane picture, but its
grid-layout engine has a known limit: large, wide, interconnected processes
throw `KeyError` from an internal grid (reproduced on a 41-element, 5-pool
AIOps process). The process is *valid*; the renderer has a bug. Crashing on
valid input is unacceptable.

**Decision.** `renderDiagram` wraps processpiper in try/catch; on layout
failure it falls back to a Graphviz structural rendering of the same AST
(lanes as clusters, gateways as diamonds). The result carries `fallback: true`.

**Consequences.** (+) Every valid process produces a diagram. (+) The fallback
is faithful (same nodes/edges/labels), just not BPMN swimlane geometry.
(-) BPMN XML export is also lost on fallback (it runs inside processpiper's
`draw()`). ADR-7 proposes the fix.

---

## ADR-5 — The DSL is the structured-output contract (not JSON mode)

**Context.** We need the model's output to be machine-parseable. The obvious
choice is JSON-mode / tool-call structured output. But the local vLLM model is
a hybrid thinking model, and the output *is* also the diagram source, so we'd
be generating JSON and then translating it into PiperFlow anyway.

**Decision.** The model emits PiperFlow text directly; our parser is the
validator. The DSL *is* the contract.

**Consequences.** (+) One artifact serves both rendering and validation, no
redundant translation. (+) More robust to thinking-model noise than JSON
(our `extractDsl` tolerates prose/fences). (+) The DSL spec doubles as the
prompt contract (it tells the model the exact grammar). (-) Parser must be
lenient about whitespace/indentation but strict about structure. We've tuned
this: orphans/dangling refs throw, indentation is tolerated.

---

## ADR-6 — One named session per lane (not dynamic subagents)

**Context.** The natural mental model is "each lane is a sub-agent." But Flue
requires sub-agents to be *declared* (discovered from `src/agents/`), and lanes
are dynamic per process, they can't be pre-declared as files. Passing agent
objects to `session.task` throws `SubagentNotDeclaredError`.

**Decision.** Codegen declares lane sub-agents via `defineAgentProfile` on a
coordinator (so `session.task(label, { agent: 'lane_name' })` works), **and**
the runtime executor uses one named Flue *session* per lane
(`harness.session(laneName)`) for live execution. A lane is genuinely a
persistent actor with its own conversation context.

**Consequences.** (+) Both the generated workflow and the executor work with
Flue's declaration model. (+) Per-lane context isolation is real. (+) Each lane
session is independently observable (telemetry `session` field = lane name).
(-) Two slightly different mechanisms (profiles for codegen, sessions for the
executor). Acceptable because they serve different phases (compile-time vs
runtime).

---

## ADR-7 — Prevent skill-format defects at generation, don't catch them after

**Context.** Community agent skills use the same `SKILL.md` + YAML frontmatter
convention as Flue, but Flue requires frontmatter to be a **flat
string-to-string** mapping. Many community skills add nested `metadata:` maps
or numeric `version:` fields that Flue rejects at *build time*. Silently
importing one breaks the whole build. (Reproduced: two popular logistics
skills.)

**Decision.** A Flue-compatibility **gate** pre-parses every skill's frontmatter
before wiring; incompatible ones are recorded as *recommendations*, not imports.
For *synthesized* skills (ADR: skill synthesis), the generation prompt enforces
a strict `name`+`description`-only contract, and a `normalize()` step strips
anything else before install.

**Consequences.** (+) One bad skill can never break the build. (+) Prevention
(generation contract) + detection (compat gate) layered: defense in depth.
(+) Incompatible skills still surface to the user as actionable recommendations.
(-) Some legitimate skill metadata (e.g. `license:`) is dropped. Acceptable
trade for build safety.

---

## ADR-8 — Layered observability: local sink first, OTel opt-in

**Context.** The project runs self-hosted. Mandating an OpenTelemetry collector
+ Grafana would violate the zero-infra ethos and block anyone who just wants to
try it. But the headline dashboard (per-lane latency, gateway branch rates,
token cost) is exactly the kind of observability a platform engineer expects.

**Decision.** Two layers. A **local JSONL sink** is always on (zero infra:
`observe()` → `telemetry/events.jsonl`, read via `npm run metrics` or
`/metrics`). The **OpenTelemetry → Grafana/Tempo** path is opt-in via
`OTEL_EXPORTER_OTLP_ENDPOINT`, with a provisioned dashboard.

**Consequences.** (+) Works out of the box with nothing installed. (+) Same
event contract feeds both; upgrading to Grafana is configuration, not rework.
(+) The sink captures the *full* Flue event contract (so the aggregator can
compute anything a dashboard would). (-) Token/cost totals must sum `turn`
leaf values, not operation roll-ups (per Flue docs). The aggregator respects
this.

---

## ADR-9 — Gateway-semantics detection, not auto-correction

**Context.** Generated exclusive gateways can be semantically inverted (e.g.
`<Payment Failed?>` with the recovery step on the "no" branch). Auto-correcting
is impossible: only the model knows its intent, and "fixing" a branch
arbitrarily could silently change business logic.

**Decision.** Don't auto-correct. Instead: (a) strengthen the DSL spec with
explicit gateway-semantics guidance so the model gets it right; (b) the
compiler detects the *smell* (recovery term on the negative branch) and emits a
visible `!!` comment + a runtime `log.warn`; (c) the branch map is always
emitted as a readable comment so a human can verify at a glance.

**Consequences.** (+) Never silently changes intended logic. (+) Defects
surface in both the code and telemetry before shipping. (+) The smell detector
is conservative (it warned on `Payment Failed?` but correctly stayed quiet on
`Retry Failed?`). (-) A genuinely intended-but-unusual gateway could produce a
false warning. Acceptable; it's a prompt to review, not a block.

---

## ADR-10 — Bounded execution (per-step timeout + degenerate-output detection)

**Context.** The local model is a hybrid thinking model (Qwen3.6). Its reasoning
can collapse into a degenerate repetition loop — the same sentence emitted
hundreds of times (observed: a "Peer Review" step looped indefinitely). With no
guard, one bad response hangs the whole pipeline until an external timeout kills
it. That's unacceptable for anything production-shaped.

**Decision.** Two guards, applied to every model call in both generation and
execution:
1. **Per-step timeout** via `AbortSignal.timeout(STEP_TIMEOUT_MS)` (default
   120s/step for execution, 180s for generation). A stuck step aborts and is
   recorded — activities get a `[step aborted: timed out]` note, gateways
   default to `no` — instead of hanging forever.
2. **Degenerate-output detection** — a 40-char window repeated 8+ times is
   treated as a loop; the output is replaced with a termination marker and
   logged as a warning.

**Consequences.** ✅ A looping model can no longer hang the pipeline — every run
terminates in bounded time. ✅ Partial results survive a stuck step (the trace
shows where it failed). ✅ Both guards are observable (logged as warnings).
⚠️ A legitimately long step could hit the timeout — mitigated by a generous
default and `STEP_TIMEOUT_MS` override. ⚠️ The repetition heuristic could miss
a slow-drift loop, but the timeout is the hard backstop regardless.

---

## Known limitation — Parallel-join traversal duplicates the post-join flow (codegen)

**Context.** When the Flue codegen emitter walks a process with a parallel
split/join, it emits the flow *after* the join once per parallel branch. For a
split into N branches, every step downstream of the matching join is generated
N times.

**Why it's surfaced now.** Most showcases (onboarding, order-fulfilment) have a
simple linear chain after their join, so the duplication is *silently* wrong
(the post-join tasks just run N times) but typechecks cleanly. The RFP showcase
exposes it because its post-join flow contains an exclusive gateway, whose
generated `const <gateway>_decision` gets redeclared across branches — a
hard type error.

**Status.** The generated workflows (`src/workflows/gen-*.ts`) are build
artifacts (gitignored) and are excluded from the source typecheck via
`tsconfig.json`, so this does not break CI or the shipped CLI. The
**soundness/reliability analysis — the actual product wedge — is unaffected**;
it operates on the AST/Petri net directly, not on generated code.

**Fix direction (when the runnable-workflow path becomes the focus).** The
emitter's traversal must treat a parallel join as a convergence point: emit
each branch body up to the join, then emit the shared post-join flow exactly
once after all branches. This is a focused change in `src/compiler/emit.ts`
guarded by the compiler test suite.
