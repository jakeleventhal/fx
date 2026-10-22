// Runs the real fx binary through sessions whose first turn changes the
// context mid-session (rules delivered from a subfolder AGENTS.md, a named
// skill, an agent branch switch) and whose second turn resumes them. TLC
// replays the requests through PromptCache's MidSessionKeepsHistory: each
// request reads all of the previous one except notes at its end, and on the
// turn after a named skill, all history before that turn's user message.
//
// fx must conform to exactly one of the two layouts PromptCache models with
// Notes, and it must be the notes design, where mid-session changes are notes
// after the conversation and the property holds. No model calls: a local fake
// Gateway serves scripted tool calls and replies.
//
// The notes design has not landed in fx, so these tests run only with
// FX_TLA_NEXT_NOTES=1. On fx before it, they fail: fx matches today's layout
// and violates the property.
//
// Evidence goes to FX_TLA_OUT or a temp folder, under midsession/: every
// Gateway request, activity.jsonl, observed.json, timeline.md and TLC logs.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifacts, binary, targetHelpers } from "../lib/context";
import { MID_PROPERTIES, checkRuntime, observe, simulate, timelineMarkdown, type Design, type Family, type RuntimeResult } from "./bridge";
import { activityLogger, collectMidSession, type CapturedRequest } from "./scenarios";

const helpers = await targetHelpers();
const log = activityLogger(artifacts);
const TIMEOUT = 900_000;
const NEXT_NOTES = process.env.FX_TLA_NEXT_NOTES === "1";
const familyOf = (model: string): Family => (model.startsWith("anthropic/") ? "anthropic" : "openai");

// Claude reads a conversation differently from the instructions on when a
// system message comes right before a user message, which misses the cache
// for the whole conversation. So a note is the last message or comes right
// before an assistant message (`src/core/agent/stream_provider.zig`
// placeContextNotes). Returns "<request seq>:<message index>" per misplaced note.
function notesBeforeUser(requests: CapturedRequest[]): string[] {
  const misplaced: string[] = [];
  for (const request of requests) {
    if (request.kind !== "agent") continue;
    const prompt: { role: string }[] = JSON.parse(request.body).prompt;
    const firstMessage = prompt.findIndex((m) => m.role !== "system");
    if (firstMessage < 0) continue;
    for (let i = firstMessage; i + 1 < prompt.length; i++) {
      if (prompt[i].role === "system" && prompt[i + 1].role === "user") misplaced.push(`${request.seq}:${i}`);
    }
  }
  return misplaced;
}

function explain(result: RuntimeResult, notes: boolean): string {
  return `${notes ? "notes" : "today"} layout ${result.verdict}: ${result.detail}\n` +
    `coverage: ${JSON.stringify(result.coverage)}\nproperties: ${JSON.stringify(result.properties)}`;
}

// Design "proposed" is a family fx sends cache markers to; "current" one it
// sends none to, whose provider caches prefixes by itself (PromptCache.tla).
async function midSessionVerdicts(model: string, design: Design) {
  const dir = join(artifacts, "midsession", model.replace(/[^a-z0-9]+/gi, "-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  log("midsession_start", { binary, model, artifacts: dir });
  const capture = await collectMidSession({ binary, helpers, artifacts: dir, model });
  for (const session of capture.sessions) {
    assert.equal(session.exitCode, 0, `session ${session.session} exited ${session.exitCode}; see ${session.stderrFile}`);
    assert.equal(session.timedOut, false, `session ${session.session} timed out`);
  }
  const misplaced = notesBeforeUser(capture.requests);
  log("midsession_note_placement", { model, misplaced });
  assert.deepEqual(misplaced, [], "a note must be last or come right before an assistant message");
  const family = familyOf(model);
  const { observed, errors } = observe(capture.requests, family);
  writeFileSync(join(dir, "observed.json"), JSON.stringify(observed, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "timeline.md"), timelineMarkdown(simulate(observed, family)), { mode: 0o600 });
  log("midsession_observed", { model, requests: observed.length, abstraction_errors: errors });
  assert.deepEqual(errors, [], "every request must match a modeled layout");
  const [today, notes] = await Promise.all([false, true].map((n) =>
    checkRuntime(observed, design, family, join(dir, "tlc"), { notes: n, properties: MID_PROPERTIES })));
  for (const [n, result] of [[false, today], [true, notes]] as const) {
    writeFileSync(join(dir, `${n ? "notes" : "today"}-layout.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    log("midsession_checked", { model, notes: n, verdict: result.verdict, detail: result.detail, properties: result.properties });
  }
  return { today: today!, notes: notes! };
}

async function expectNotesDesign(model: string, design: Design = "proposed") {
  const { today, notes } = await midSessionVerdicts(model, design);
  const accepted = [today, notes].filter((r) => r.verdict === "ACCEPTED");
  const both = `${explain(today, false)}\n${explain(notes, true)}\nartifacts: ${artifacts}`;
  assert.equal(accepted.length, 1, `${model}: expected exactly one layout to match\n${both}`);
  assert.equal(accepted[0], notes, `${model}: fx should add mid-session changes after the conversation\n${both}`);
  assert.equal(notes.properties.MidSessionKeepsHistory?.verdict, "HOLDS", `${model}\n${both}`);
}

test.skipIf(!NEXT_NOTES)("with an Anthropic model, mid-session changes keep the cached conversation", async () => {
  await expectNotesDesign("anthropic/claude-sonnet-5.5");
}, TIMEOUT);

test.skipIf(!NEXT_NOTES)("with GPT-5.6 or later, mid-session changes keep the cached conversation", async () => {
  await expectNotesDesign("openai/gpt-6.1-sol");
}, TIMEOUT);

test.skipIf(!NEXT_NOTES)("with fx's default model, which gets no cache markers, mid-session changes keep the cached conversation", async () => {
  await expectNotesDesign("spacexai/grok-4.7", "current");
}, TIMEOUT);
