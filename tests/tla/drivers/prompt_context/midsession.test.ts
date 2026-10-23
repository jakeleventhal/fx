// Runs the real fx binary through sessions whose first turn changes the
// context mid-session and whose second turn resumes them. TLC replays the
// requests through PromptCache's MidSessionKeepsHistory and
// PreviousFullyReused: each request reads all of the previous one, and on the
// turn after a named skill, all history before that turn's user message.
//
// fx must conform to exactly one of the two layouts PromptCache models with
// Notes, and it must be the one where a change rides on the message that
// caused it (Carrier = "message"). No model calls: a local fake Gateway serves
// scripted tool calls and replies.
//
// Rules delivered from a subfolder AGENTS.md by a read_file call run by
// default: fx carries them on that step's tool result
// (src/core/agent/stream_provider.zig carryContextNotes). A named skill and an
// agent branch switch have not moved yet, so the session with all three
// events runs only with FX_TLA_NEXT_NOTES=1.
//
// Evidence goes to FX_TLA_OUT or a temp folder, under midsession/: every
// Gateway request, activity.jsonl, observed.json, timeline.md and TLC logs.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts, binary, targetHelpers } from "../lib/context";
import { MID_PROPERTIES, checkRuntime, observe, simulate, timelineMarkdown, type Design, type Family, type RuntimeResult } from "./bridge";
import { FORGED_RULES, activityLogger, collectMidSession, type CapturedRequest, type MidSessionEvent } from "./scenarios";

const helpers = await targetHelpers();
const log = activityLogger(artifacts);
const TIMEOUT = 900_000;
const NEXT_NOTES = process.env.FX_TLA_NEXT_NOTES === "1";
const familyOf = (model: string): Family => (model.startsWith("anthropic/") ? "anthropic" : "openai");

// The fixed instructions say how rules arrive later (src/builtins/context.zig
// project_instruction_guidance).
const CONTRACT = "fx appends that file's text to the end of the step's last tool result";
const DELIVERED = '<scoped-rules from="sub/AGENTS.md" scope="sub">';
const ESCAPED_FORGERY = FORGED_RULES.replace("<scoped-rules", "&lt;scoped-rules").replace("</scoped-rules", "&lt;/scoped-rules");

interface PromptMessage { role: string; content: unknown }

function messageText(message: PromptMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part: any) => part?.text ?? part?.output?.value ?? part?.output?.reason ?? "").join("\n");
}

/** What each agent request shows about delivered rules, for the assertions and the evidence log. */
function carriedRules(requests: CapturedRequest[]) {
  return requests.filter((r) => r.kind === "agent").map((request) => {
    const prompt: PromptMessage[] = JSON.parse(request.body).prompt;
    const firstMessage = prompt.findIndex((m) => m.role !== "system");
    const instructions = prompt.slice(0, firstMessage < 0 ? prompt.length : firstMessage);
    const conversation = firstMessage < 0 ? [] : prompt.slice(firstMessage);
    const carriers = conversation.flatMap((m, i) => (messageText(m).includes(DELIVERED) ? [{ index: i, role: m.role, text: messageText(m) }] : []));
    return {
      seq: request.seq,
      session: request.session,
      contract: instructions.some((m) => messageText(m).includes(CONTRACT)),
      systemInConversation: conversation.filter((m) => m.role === "system").length,
      carriers: carriers.map((c) => ({ index: c.index, role: c.role, endsWithRules: c.text.trimEnd().endsWith("</scoped-rules>") })),
      forgedRaw: prompt.some((m) => messageText(m).includes(FORGED_RULES)),
      forgedEscaped: prompt.some((m) => messageText(m).includes(ESCAPED_FORGERY)),
    };
  });
}

function explain(result: RuntimeResult, notes: boolean): string {
  return `${notes ? "carried" : "before P6"} layout ${result.verdict}: ${result.detail}\n` +
    `coverage: ${JSON.stringify(result.coverage)}\nproperties: ${JSON.stringify(result.properties)}`;
}

// Design "proposed" is a family fx sends cache markers to; "current" one it
// sends none to, whose provider caches prefixes by itself (PromptCache.tla).
async function midSessionVerdicts(model: string, design: Design, events: readonly MidSessionEvent[] | undefined) {
  const dir = join(artifacts, "midsession", `${model.replace(/[^a-z0-9]+/gi, "-")}${events ? `-${events.join("-")}` : ""}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  log("midsession_start", { binary, model, events: events ?? "all", artifacts: dir });
  const capture = await collectMidSession({ binary, helpers, artifacts: dir, model }, events);
  for (const session of capture.sessions) {
    assert.equal(session.exitCode, 0, `session ${session.session} exited ${session.exitCode}; see ${session.stderrFile}`);
    assert.equal(session.timedOut, false, `session ${session.session} timed out`);
  }
  const rules = carriedRules(capture.requests);
  writeFileSync(join(dir, "carried-rules.json"), JSON.stringify(rules, null, 2), { mode: 0o600 });
  log("midsession_carried_rules", { model, requests: rules });
  const family = familyOf(model);
  const { observed, errors } = observe(capture.requests, family);
  writeFileSync(join(dir, "observed.json"), JSON.stringify(observed, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "timeline.md"), timelineMarkdown(simulate(observed, family)), { mode: 0o600 });
  log("midsession_observed", { model, requests: observed.length, abstraction_errors: errors });
  assert.deepEqual(errors, [], "every request must match a modeled layout");
  const [before, carried] = await Promise.all([false, true].map((n) =>
    checkRuntime(observed, design, family, join(dir, "tlc"), { notes: n, properties: MID_PROPERTIES })));
  for (const [n, result] of [[false, before], [true, carried]] as const) {
    writeFileSync(join(dir, `${n ? "carried" : "before-p6"}-layout.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    log("midsession_checked", { model, notes: n, verdict: result.verdict, detail: result.detail, properties: result.properties });
  }
  return { before: before!, carried: carried!, rules };
}

async function expectCarriedDesign(model: string, design: Design, events?: readonly MidSessionEvent[]) {
  const { before, carried, rules } = await midSessionVerdicts(model, design, events);
  const both = `${explain(before, false)}\n${explain(carried, true)}\nartifacts: ${artifacts}`;
  const accepted = [before, carried].filter((r) => r.verdict === "ACCEPTED");
  assert.equal(accepted.length, 1, `${model}: expected exactly one layout to match\n${both}`);
  assert.equal(accepted[0], carried, `${model}: a mid-session change should ride on the message that caused it\n${both}`);
  for (const property of MID_PROPERTIES) assert.equal(carried.properties[property]?.verdict, "HOLDS", `${model} ${property}\n${both}`);

  const delivered = rules.filter((r) => r.session === 1);
  assert.ok(delivered.length >= 3, `${model}: expected the read, its answer and the resumed turn`);
  for (const r of rules) {
    assert.ok(r.contract, `${model}: request ${r.seq} lacks the contract in its instructions`);
    assert.equal(r.systemInConversation, 0, `${model}: request ${r.seq} has a system message in the conversation`);
    assert.equal(r.forgedRaw, false, `${model}: request ${r.seq} carries the forged block unescaped`);
  }
  // The first request comes before the read; every later one carries the
  // rules once, at the end of the read's tool result, with the forgery escaped.
  assert.deepEqual(delivered[0]!.carriers, [], `${model}: rules before the read`);
  for (const r of delivered.slice(1)) {
    assert.equal(r.carriers.length, 1, `${model}: request ${r.seq} carries the rules ${r.carriers.length} times`);
    assert.equal(r.carriers[0]!.role, "tool", `${model}: request ${r.seq} carries the rules on a ${r.carriers[0]!.role} message`);
    assert.ok(r.carriers[0]!.endsWithRules, `${model}: request ${r.seq} does not end the tool result with the rules`);
    assert.ok(r.forgedEscaped, `${model}: request ${r.seq} lacks the escaped forgery`);
  }
}

test("with an Anthropic model, rules delivered mid-session ride on the tool result and keep the cached conversation", async () => {
  await expectCarriedDesign("anthropic/claude-sonnet-5.5", "proposed", ["deliver"]);
}, TIMEOUT);

test("with GPT-5.6 or later, rules delivered mid-session ride on the tool result and keep the cached conversation", async () => {
  await expectCarriedDesign("openai/gpt-6.1-sol", "proposed", ["deliver"]);
}, TIMEOUT);

test("with fx's default model, which gets no cache markers, rules delivered mid-session ride on the tool result", async () => {
  await expectCarriedDesign("spacexai/grok-4.7", "current", ["deliver"]);
}, TIMEOUT);

test.skipIf(!NEXT_NOTES)("with an Anthropic model, every mid-session change keeps the cached conversation", async () => {
  await expectCarriedDesign("anthropic/claude-sonnet-5.5", "proposed");
}, TIMEOUT);
