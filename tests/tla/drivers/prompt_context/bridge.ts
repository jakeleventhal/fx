// Connects the requests the real fx binary sent to TLC.
//
// 1. Each captured agent request becomes PromptCache blocks: the tools, then
//    the stable instruction groups (base, skills, project, mcp), the turn
//    context, the runtime notes, then one block per user message and per run
//    of assistant and tool messages. A message-level or part-level marker in
//    the run's family syntax marks the block it ends:
//    providerOptions.anthropic.cacheControl for Anthropic,
//    providerOptions.openai.promptCacheBreakpoint for OpenAI. Layout drift, a
//    marker inside a group, a marker in the other family's syntax, or a
//    system message after the conversation started is an abstraction error,
//    never a guess.
// 2. The blocks become PromptCacheObserved.tla. PromptCacheTrace replays them
//    through PromptCache's provider cache. A check passes only when TLC stops
//    on the ReplayIncomplete sentinel: every request replayed, nothing failed.
// 3. Missing coverage (no request that exercises a property) is INCONCLUSIVE,
//    not a pass.
//
// simulate() mirrors the model in TypeScript only to print a timeline for
// people. Verdicts come from TLC.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TLA_ROOT, runTlc, type TlcRun } from "../lib/tlc";
import type { CapturedRequest } from "./scenarios";

export type Design = "current" | "proposed";
/** Whose cache rules and marker syntax a run uses: PromptCache's Family. */
export type Family = "anthropic" | "openai";
export type Verdict = "ACCEPTED" | "REJECTED" | "INCONCLUSIVE" | "TOOL_ERROR";
export type PropertyVerdict = "HOLDS" | "VIOLATED" | "TOOL_ERROR";

export const PROPERTIES = ["Budget", "SessionReuse", "CrossRepoReuse", "SameWorktreeReuse", "ContextChangeKeepsStable"] as const;
export type Property = (typeof PROPERTIES)[number];

export interface Block { k: string; v: string }

export interface ObservedRequest {
  seq: number;
  w: string;
  repo: string;
  s: number;
  req: Block[];
  manual: number[];
}

export interface Abstraction {
  blocks: Block[];
  manual: number[];
  /** Prompt message indexes that make up each block, in block order. */
  sources: number[][];
  errors: string[];
}

export interface RuntimeResult {
  version: 1;
  design: Design;
  family: Family;
  verdict: Verdict;
  detail: string;
  requests: number;
  coverage: Record<Property, number>;
  properties: Partial<Record<Property, { verdict: PropertyVerdict; detail?: string; log?: string }>>;
  conformanceLog?: string;
  hashes: Record<string, string>;
}

const tlaDir = join(TLA_ROOT, "prompt_context");
const SPECS = ["PromptCache.tla", "PromptCacheTrace.tla"];
const ORDER = ["base", "skills", "project", "mcp", "ctx", "rt"] as const;
const NINSTR = 7;
const POS_PROFILE = 2;
const POS_STABLE = 5;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const short = (text: string) => sha(text).slice(0, 16);

type SystemKind = (typeof ORDER)[number] | "other";

function systemKind(content: string): SystemKind {
  if (content.startsWith("Skills provide task instructions") || content.includes("<available_skills>")) return "skills";
  if (content.startsWith("<project-instructions-guidance>") || content.includes("<project-rules")) return "project";
  if (content.startsWith("Configured MCP servers")) return "mcp";
  if (content.startsWith("<fx-turn-context>")) return "ctx";
  if (content.startsWith("Runtime context:") || content.startsWith("<response_language_control>")) return "rt";
  return "other";
}

const MARKER: Record<Family, (providerOptions: any) => unknown> = {
  anthropic: (options) => options?.anthropic?.cacheControl,
  openai: (options) => options?.openai?.promptCacheBreakpoint,
};

function hasMarker(message: any, family: Family): boolean {
  const marker = MARKER[family];
  if (marker(message?.providerOptions)) return true;
  if (Array.isArray(message?.content)) {
    return message.content.some((part: any) => marker(part?.providerOptions));
  }
  return false;
}

function text(message: any): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

/** Turns one captured agent request body into PromptCache blocks. */
export function abstractRequest(body: string, family: Family): Abstraction {
  const errors: string[] = [];
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { blocks: [], manual: [], sources: [], errors: ["body is not JSON"] };
  }
  const prompt: any[] = Array.isArray(parsed.prompt) ? parsed.prompt : [];
  const blocks: Block[] = [{ k: "tools", v: short(JSON.stringify(parsed.tools ?? [])) }];
  const sources: number[][] = [[]];
  const marked: boolean[] = [false];
  if (Array.isArray(parsed.tools) && parsed.tools.some((tool: any) => tool?.providerOptions)) {
    errors.push("a tool carries providerOptions; tool markers are not modeled");
  }
  const other: Family = family === "anthropic" ? "openai" : "anthropic";
  prompt.forEach((message, n) => {
    if (hasMarker(message, other)) errors.push(`message ${n} carries an ${other} marker on an ${family} request`);
  });

  // Stable instruction groups and the overlay.
  let group = 0; // index into ORDER
  let i = 0;
  const groups: { kind: string; messages: number[] }[] = [{ kind: "base", messages: [] }];
  for (; i < prompt.length && prompt[i].role === "system"; i += 1) {
    const kind = systemKind(text(prompt[i]));
    if (kind === "other") {
      if (groups.at(-1)!.kind === "ctx" || groups.at(-1)!.kind === "rt") {
        errors.push(`unclassified system message ${i} after the turn context`);
      }
      groups.at(-1)!.messages.push(i);
      continue;
    }
    const at = ORDER.indexOf(kind);
    if (kind === "rt" && groups.at(-1)!.kind === "rt") {
      groups.at(-1)!.messages.push(i);
      continue;
    }
    if (at <= group) {
      errors.push(`system message ${i} (${kind}) is out of order after ${ORDER[group]}`);
      groups.at(-1)!.messages.push(i);
      continue;
    }
    group = at;
    groups.push({ kind, messages: [i] });
  }
  const kinds = groups.map((g) => g.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(ORDER)) {
    errors.push(`instruction groups ${kinds.join(",")} differ from ${ORDER.join(",")}`);
  }
  for (const g of groups) {
    if (g.messages.length === 0) {
      errors.push(`empty ${g.kind} group`);
      continue;
    }
    blocks.push({ k: g.kind, v: short(g.messages.map((m) => text(prompt[m])).join("\u0000")) });
    sources.push(g.messages);
    g.messages.forEach((m, n) => {
      if (hasMarker(prompt[m], family) && n !== g.messages.length - 1) errors.push(`marker inside the ${g.kind} group (message ${m})`);
    });
    marked.push(hasMarker(prompt[g.messages.at(-1)!], family));
  }

  // The conversation.
  for (; i < prompt.length; i += 1) {
    const role = prompt[i].role;
    if (role === "system") {
      errors.push(`system message ${i} after the conversation started`);
      continue;
    }
    if (role === "user") {
      blocks.push({ k: "user", v: short(text(prompt[i])) });
      sources.push([i]);
      marked.push(hasMarker(prompt[i], family));
      continue;
    }
    const last = blocks.at(-1)!;
    if (last.k === "asst") {
      sources.at(-1)!.push(i);
      last.v = short(sources.at(-1)!.map((m) => text(prompt[m])).join("\u0000"));
      if (marked.at(-1)) errors.push(`marker inside an assistant run (before message ${i})`);
      marked[marked.length - 1] = hasMarker(prompt[i], family);
    } else {
      blocks.push({ k: "asst", v: short(text(prompt[i])) });
      sources.push([i]);
      marked.push(hasMarker(prompt[i], family));
    }
  }
  if (!blocks.some((b) => b.k === "user")) errors.push("no user message");
  const manual = marked.flatMap((m, n) => (m ? [n + 1] : []));
  return { blocks, manual, sources, errors };
}

/** Abstracts every agent request, in send order. Title requests are a separate prefix and are left out. */
export function observe(requests: CapturedRequest[], family: Family): { observed: ObservedRequest[]; errors: string[] } {
  const observed: ObservedRequest[] = [];
  const errors: string[] = [];
  for (const request of requests.filter((r) => r.kind === "agent").sort((a, b) => a.seq - b.seq)) {
    const a = abstractRequest(request.body, family);
    for (const e of a.errors) errors.push(`request ${request.seq} (session ${request.session}): ${e}`);
    observed.push({ seq: request.seq, w: request.worktree, repo: request.repo, s: request.session, req: a.blocks, manual: a.manual });
  }
  return { observed, errors };
}

function word(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`refusing unsafe TLA+ string: ${JSON.stringify(value)}`);
  return `"${value}"`;
}

export function observedModule(observed: ObservedRequest[]): string {
  const record = (o: ObservedRequest) => {
    const req = o.req.map((b) => `[k |-> ${word(b.k)}, v |-> ${word(b.v)}]`).join(", ");
    return `  [w |-> ${word(o.w)}, repo |-> ${word(o.repo)}, s |-> ${o.s}, manual |-> {${o.manual.join(", ")}},\n` +
      `   req |-> << ${req} >>]`;
  };
  return [
    "------------------------ MODULE PromptCacheObserved ------------------------",
    "(* Written by tests/tla/drivers/prompt_context/bridge.ts from a real run. *)",
    "Observed == <<",
    observed.map(record).join(",\n"),
    ">>",
    "=============================================================================",
    "",
  ].join("\n");
}

interface Derived { first: boolean; prev: ObservedRequest | null; changed: boolean; worktreeSeen: boolean; worktreeCtxChanged: boolean; anySeen: boolean }

/** The same derivations PromptCacheTrace makes, for coverage and the timeline. */
export function derive(observed: ObservedRequest[]): Derived[] {
  return observed.map((o, n) => {
    const earlier = observed.slice(0, n);
    const sameSession = earlier.filter((e) => e.s === o.s);
    const prev = sameSession.at(-1) ?? null;
    const ctx = (r: ObservedRequest) => r.req[5]?.v;
    const sameWorktree = earlier.filter((e) => e.w === o.w);
    return {
      first: prev === null,
      prev,
      changed: prev !== null && ctx(prev) !== ctx(o),
      worktreeSeen: sameWorktree.length > 0,
      worktreeCtxChanged: sameWorktree.length > 0 && ctx(sameWorktree.at(-1)!) !== ctx(o),
      anySeen: n > 0,
    };
  });
}

/** How many requests exercise each property's condition. */
export function coverage(observed: ObservedRequest[]): Record<Property, number> {
  const d = derive(observed);
  return {
    Budget: observed.length,
    SessionReuse: d.filter((x) => !x.first && !x.changed).length,
    CrossRepoReuse: d.filter((x, n) => x.first && x.anySeen && observed.slice(0, n).some((e) => e.w !== observed[n]!.w)).length,
    SameWorktreeReuse: d.filter((x) => x.first && x.worktreeCtxChanged).length,
    ContextChangeKeepsStable: d.filter((x) => x.changed).length,
  };
}

export interface TimelineRow {
  seq: number; s: number; w: string; first: boolean; changed: boolean;
  blocks: number; manual: number[]; breakpoints: number[]; read: number;
}

/** Diagnostic mirror of PromptCache's provider cache. TLC decides; this explains. */
export function simulate(observed: ObservedRequest[], family: Family): TimelineRow[] {
  const cache = new Set<string>();
  const key = (req: Block[], n: number) => JSON.stringify(req.slice(0, n));
  const d = derive(observed);
  return observed.map((o, n) => {
    const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    const lastUser = Math.max(...o.req.flatMap((b, j) => (b.k === "user" ? [j + 1] : [])));
    let bps: number[];
    let read = 0;
    if (family === "anthropic") {
      // PromptCache Hit: any written prefix up to the furthest breakpoint.
      bps = sorted([...o.manual, o.req.length, lastUser - 1]);
      for (let m = 1; m <= Math.max(...bps); m += 1) if (cache.has(key(o.req, m))) read = m;
      for (const bp of bps) cache.add(key(o.req, bp));
    } else {
      // PromptCache Lookup: only lookup candidates; the developer block end is written too.
      bps = sorted([...o.manual, o.req.length]);
      const eligible = o.req.flatMap((b, j) => (j + 1 > NINSTR && (b.k === "user" || b.k === "asst") ? [j + 1] : []));
      for (const m of sorted([...bps, ...eligible, NINSTR])) if (cache.has(key(o.req, m))) read = m;
      for (const bp of [...bps, NINSTR]) cache.add(key(o.req, bp));
    }
    return { seq: o.seq, s: o.s, w: o.w, first: d[n]!.first, changed: d[n]!.changed, blocks: o.req.length, manual: o.manual, breakpoints: bps, read };
  });
}

export function timelineMarkdown(rows: TimelineRow[]): string {
  const lines = [
    "Diagnostic timeline, computed by bridge.ts simulate(); TLC gives the verdicts.",
    `Block positions: 1 tools, 2 base, 3 skills, 4 project, 5 mcp, 6 turn context, 7 runtime notes, 8+ conversation.`,
    "",
    "| request | session | worktree | first | context changed | blocks | manual markers | all markers | blocks read |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| ${r.seq} | ${r.s} | ${r.w} | ${r.first ? "yes" : "no"} | ${r.changed ? "yes" : "no"} | ${r.blocks} | ` +
      `${r.manual.join(",") || "none"} | ${r.breakpoints.join(",")} | ${r.read} |`);
  }
  return `${lines.join("\n")}\n`;
}

function cfg(design: Design, family: Family, invariants: string[]): string {
  return ["SPECIFICATION Spec", "CONSTANTS", `  Design = "${design}"`, `  Family = "${family}"`, "INVARIANTS",
    ...invariants.map((x) => `  ${x}`), ""].join("\n");
}

async function trace(dir: string, observed: ObservedRequest[], design: Design, family: Family, invariants: string[]): Promise<TlcRun> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PromptCacheObserved.tla"), observedModule(observed));
  writeFileSync(join(dir, "PromptCacheTrace.cfg"), cfg(design, family, invariants));
  return runTlc(dir, "PromptCacheTrace", "PromptCacheTrace.cfg", SPECS, tlaDir, ["-deadlock"]);
}

/**
 * Checks the observed requests against one design: conformance first, then
 * each property on the same replay. Writes every TLC run under `reports`.
 */
export async function checkRuntime(observed: ObservedRequest[], design: Design, family: Family, reports: string): Promise<RuntimeResult> {
  const cover = coverage(observed);
  const hashes: Record<string, string> = {};
  for (const spec of SPECS) hashes[spec] = sha(readFileSync(join(tlaDir, spec), "utf8"));
  const base: RuntimeResult = { version: 1, design, family, verdict: "INCONCLUSIVE", detail: "", requests: observed.length, coverage: cover, properties: {}, hashes };
  const missing = PROPERTIES.filter((p) => cover[p] === 0);
  if (observed.length === 0 || missing.length > 0) {
    return { ...base, detail: observed.length === 0 ? "no requests" : `no request exercises ${missing.join(", ")}` };
  }
  hashes["PromptCacheObserved.tla"] = sha(observedModule(observed));
  const conformance = await trace(join(reports, design, "conforms"), observed, design, family, ["Conforms", "ReplayIncomplete"]);
  base.conformanceLog = join(reports, design, "conforms", "tlc.log");
  if (conformance.violated === "Conforms") return { ...base, verdict: "REJECTED", detail: `requests do not match the ${design} layout and markers` };
  if (conformance.violated !== "ReplayIncomplete") {
    return { ...base, verdict: "TOOL_ERROR", detail: `TLC exit ${conformance.exitCode}: ${conformance.output.slice(-400)}` };
  }
  for (const property of PROPERTIES) {
    const dir = join(reports, design, property);
    const run = await trace(dir, observed, design, family, ["Conforms", property, "ReplayIncomplete"]);
    const verdict: PropertyVerdict = run.violated === "ReplayIncomplete" ? "HOLDS" : run.violated === property ? "VIOLATED" : "TOOL_ERROR";
    base.properties[property] = { verdict, log: join(dir, "tlc.log"), ...(verdict === "TOOL_ERROR" ? { detail: run.output.slice(-400) } : {}) };
  }
  return { ...base, verdict: "ACCEPTED", detail: `${observed.length} requests replayed` };
}

export { NINSTR, POS_PROFILE, POS_STABLE };
