// Runs the real fx binary through the sessions the prompt-cache model covers,
// records every request, and has TLC replay them through the model
// (tests/tla/prompt_context/PromptCache.tla). No model calls: a local fake
// Gateway serves scripted tool calls and replies.
//
// 1. With an Anthropic model the binary must conform to exactly one modeled
//    design, the proposed one, and every design property must hold on the
//    observed requests, as check.sh's exhaustive check of that design says.
// 2. With another model family fx sends no markers of its own: the binary
//    must conform to the current design, with its properties as check.sh says.
// 3. Controls: a planted marker, missing coverage and empty evidence must not
//    be accepted.
//
// Evidence goes to FX_TLA_OUT or a temp folder: activity.jsonl (every driver
// action), requests.jsonl and requests/ (every Gateway request in full),
// observed.json, timeline.md, and one TLC log per check under tlc/.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts, binary, targetHelpers } from "../lib/context";
import {
  PROPERTIES, checkRuntime, observe, simulate, timelineMarkdown,
  type Design, type ObservedRequest, type RuntimeResult,
} from "./bridge";
import { activityLogger, collectObservations } from "./scenarios";

const helpers = await targetHelpers();
const log = activityLogger(artifacts);
const TIMEOUT = 900_000;
const ANTHROPIC = "anthropic/claude-sonnet-5.5";
const OTHER: string = helpers.FAKE_GATEWAY_MODEL;
const slug = (model: string) => model.replace(/[^a-z0-9]+/gi, "-");
const folder = (model: string) => {
  const dir = join(artifacts, slug(model));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

// Property verdicts from check.sh's exhaustive check of each design.
const EXPECTED: Record<Design, Record<string, string>> = {
  current: {
    Budget: "HOLDS", SessionReuse: "HOLDS", CrossRepoReuse: "VIOLATED",
    SameWorktreeReuse: "VIOLATED", ContextChangeKeepsStable: "VIOLATED",
  },
  proposed: {
    Budget: "HOLDS", SessionReuse: "HOLDS", CrossRepoReuse: "HOLDS",
    SameWorktreeReuse: "HOLDS", ContextChangeKeepsStable: "HOLDS",
  },
};

const observedByModel = new Map<string, Promise<ObservedRequest[]>>();
function observations(model: string): Promise<ObservedRequest[]> {
  if (!observedByModel.has(model)) {
    observedByModel.set(model, (async () => {
      const dir = folder(model);
      log("run_start", { binary, model, artifacts: dir });
      const capture = await collectObservations({ binary, helpers, artifacts: dir, model });
      for (const session of capture.sessions) {
        assert.equal(session.exitCode, 0, `session ${session.session} exited ${session.exitCode}; see ${session.stderrFile}`);
        assert.equal(session.timedOut, false, `session ${session.session} timed out`);
      }
      const { observed, errors } = observe(capture.requests);
      writeFileSync(join(dir, "observed.json"), JSON.stringify(observed, null, 2), { mode: 0o600 });
      writeFileSync(join(dir, "timeline.md"), timelineMarkdown(simulate(observed)), { mode: 0o600 });
      log("observed", { model, requests: observed.length, abstraction_errors: errors });
      assert.deepEqual(errors, [], "every request must match the modeled layout");
      return observed;
    })());
  }
  return observedByModel.get(model)!;
}

const verdicts = new Map<string, Promise<RuntimeResult>>();
function verdict(model: string, design: Design): Promise<RuntimeResult> {
  const key = `${model} ${design}`;
  if (!verdicts.has(key)) {
    verdicts.set(key, (async () => {
      const dir = folder(model);
      const result = await checkRuntime(await observations(model), design, join(dir, "tlc"));
      writeFileSync(join(dir, `${design}-design.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
      log("design_checked", { model, design, verdict: result.verdict, detail: result.detail, properties: result.properties });
      return result;
    })());
  }
  return verdicts.get(key)!;
}

function explain(result: RuntimeResult): string {
  return `${result.design} ${result.verdict}: ${result.detail}\ncoverage: ${JSON.stringify(result.coverage)}\n` +
    `properties: ${JSON.stringify(result.properties)}\nartifacts: ${artifacts}`;
}

async function conformingDesign(model: string): Promise<RuntimeResult> {
  const [current, proposed] = await Promise.all([verdict(model, "current"), verdict(model, "proposed")]);
  const accepted = [current, proposed].filter((r) => r.verdict === "ACCEPTED");
  assert.equal(accepted.length, 1, `${model}: expected exactly one design to match\n${explain(current)}\n${explain(proposed)}`);
  const result = accepted[0]!;
  for (const property of PROPERTIES) {
    assert.equal(result.properties[property]?.verdict, EXPECTED[result.design][property], `${model} ${property}: ${explain(result)}`);
  }
  writeFileSync(join(folder(model), "conforming-design.txt"), `${result.design}\n`, { mode: 0o600 });
  log("conforming_design", { model, design: result.design });
  return result;
}

test("with an Anthropic model, real fx conforms to the proposed design", async () => {
  const result = await conformingDesign(ANTHROPIC);
  assert.equal(result.design, "proposed", `fx sends the stable cache markers\n${explain(result)}`);
}, TIMEOUT);

test("with another model family, real fx sends no markers of its own", async () => {
  const result = await conformingDesign(OTHER);
  assert.equal(result.design, "current", `only Anthropic models take fx markers\n${explain(result)}`);
}, TIMEOUT);

test("bridge rejects a planted marker, missing coverage and empty evidence", async () => {
  const observed = await observations(ANTHROPIC);
  const design: Design = "proposed";
  const reports = join(folder(ANTHROPIC), "tlc");

  // A marker on the skills block, which no design places.
  const planted: ObservedRequest[] = structuredClone(observed);
  planted[0]!.manual = [...new Set([...planted[0]!.manual, 3])].sort((a, b) => a - b);
  const rejected = await checkRuntime(planted, design, join(reports, "control-planted"));
  log("control", { control: "planted_marker", verdict: rejected.verdict });
  assert.equal(rejected.verdict, "REJECTED", explain(rejected));

  // Without the sessions after the branch switches, nothing exercises
  // SameWorktreeReuse or ContextChangeKeepsStable.
  const partial = observed.filter((o) => o.s < 4);
  const missing = await checkRuntime(partial, design, join(reports, "control-partial"));
  log("control", { control: "missing_coverage", verdict: missing.verdict, detail: missing.detail });
  assert.equal(missing.verdict, "INCONCLUSIVE", explain(missing));

  const empty = await checkRuntime([], design, join(reports, "control-empty"));
  log("control", { control: "empty", verdict: empty.verdict });
  assert.equal(empty.verdict, "INCONCLUSIVE", explain(empty));
}, TIMEOUT);
