---------------------------- MODULE PromptCache ----------------------------
(***************************************************************************)
(* How fx lays out a model request and how an explicit-caching provider    *)
(* (Anthropic through AI Gateway with providerOptions.gateway.caching =    *)
(* "auto") reuses it across steps, turns, sessions, worktrees and repos.   *)
(*                                                                         *)
(* fx side: src/core/agent/runtime/orchestrator.zig appendStablePromptContext *)
(* builds the stable instructions, the per-step overlay follows them, and  *)
(* src/core/agent/runtime/prompt_context.zig buildProviderPrompt puts the  *)
(* history after both. src/gateway/vercel_protocol.zig sends the request.  *)
(*                                                                         *)
(* Provider side, as AI Gateway documents automatic caching and as         *)
(* /tmp probes on the test lane observed (docs/cache-hardening/LEDGER.md): *)
(*   - the cached prefix is tools, then system, then messages;             *)
(*   - an entry is written only at a breakpoint, covering the prefix up to *)
(*     and including that block;                                           *)
(*   - a request reads the longest written entry that is a prefix of it    *)
(*     and ends at or before one of its breakpoints;                       *)
(*   - with caching "auto" the Gateway marks the last message and the      *)
(*     message before the last user message (the last system message on a  *)
(*     first request);                                                     *)
(*   - at most Limit blocks may carry a marker (Anthropic: 4).             *)
(*                                                                         *)
(* Design = "current" is fx today: no manual markers. Design = "proposed"  *)
(* adds one marker after the repo-independent instructions (MarkProfile)   *)
(* and one at the end of the stable instructions, before the per-step      *)
(* overlay (MarkStable). Mutation plants known-bad designs:                *)
(*   "mark_every_system"   the design fx had before a0b393743: a marker on *)
(*                         every stable system message;                    *)
(*   "fence_after_context" the stable marker placed after the turn context;*)
(*   "no_auto"             the manual markers without caching "auto".      *)
(*                                                                         *)
(* PathScoped = TRUE is fx today: the skill catalog and the project rules  *)
(* name the worktree's absolute paths, so two worktrees of one repository  *)
(* send different bytes there. FALSE models the same text with paths      *)
(* relative to the workspace root, a design option, not fx today.          *)
(*                                                                         *)
(* Abstraction: a block is a [k, v] record; equal v means equal bytes.     *)
(* Tokens, cache lifetime, eviction and the provider's 20-block lookback   *)
(* window are not modeled: every modeled request is shorter than the       *)
(* window and every request happens inside the cache lifetime.             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Design,       \* "current" | "proposed"
  Mutation,     \* "none" | "mark_every_system" | "fence_after_context" | "no_auto"
  Worktrees,    \* worktree ids
  RepoOf,       \* [Worktrees -> repository ids]
  MaxSessions,  \* sessions started in one behavior
  MaxSteps,     \* model requests after the first in one session
  Limit,        \* blocks per request that may carry a cache marker
  PathScoped    \* skill catalog and project rules embed the worktree path

ASSUME Design \in {"current", "proposed"}
ASSUME Mutation \in {"none", "mark_every_system", "fence_after_context", "no_auto"}
ASSUME MaxSessions \in Nat /\ MaxSteps \in Nat /\ Limit \in Nat
ASSUME PathScoped \in BOOLEAN

Block(k, v) == [k |-> k, v |-> v]

(* Provider prefix order for one request. Every value is a string so TLC   *)
(* compares like with like.                                                *)
(*   tools    tool schemas: the same for one profile and fx version        *)
(*   base     system prompt and custom tool guidance                       *)
(*   skills   skill catalog: lists each root by absolute path              *)
(*   project  AGENTS.md project context, tagged with the file's path       *)
(*   mcp      MCP catalog                                                  *)
(*   ctx      <fx-turn-context>: worktree path, date, branch               *)
(*   rt       permission, verification and response-language notes        *)
Scoped(w) == IF PathScoped THEN w ELSE RepoOf[w]

Instructions(w, br) ==
  << Block("tools", "p"), Block("base", "p"), Block("skills", Scoped(w)),
     Block("project", Scoped(w)), Block("mcp", "p"), Block("ctx", w \o "@" \o br),
     Block("rt", "p") >>

PosProfile == 2   \* last repo-independent block: base
PosStable  == 5   \* last stable block: mcp
PosContext == 6   \* the turn context
NInstr     == 7

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

LastUser(req) == Max({i \in 1..Len(req) : req[i].k = "user"})

Manual(req) ==
  CASE Mutation = "mark_every_system" -> {2, 3, 4, PosStable}
    [] Design = "current" -> {}
    [] Mutation = "fence_after_context" -> {PosProfile, PosContext}
    [] OTHER -> {PosProfile, PosStable}

Auto(req) == IF Mutation = "no_auto" THEN {} ELSE {Len(req), LastUser(req) - 1}

Breakpoints(req) == Manual(req) \cup Auto(req)

(* The longest written entry that is a prefix of req and ends at or before  *)
(* one of its breakpoints.                                                  *)
Hit(req, bps, c) ==
  IF bps = {} THEN 0 ELSE
    LET found == {n \in 1..Max(bps) : SubSeq(req, 1, n) \in c}
    IN IF found = {} THEN 0 ELSE Max(found)

VARIABLES cache, sessions, active, log, branchOf
vars == <<cache, sessions, active, log, branchOf>>

NoSession == [on |-> FALSE, w |-> "none", s |-> 0, n |-> 0, br |-> "b1",
              hist |-> <<>>, last |-> <<>>, switched |-> FALSE]

Init ==
  /\ cache = {}
  /\ sessions = 0
  /\ active = NoSession
  /\ log = <<>>
  /\ branchOf = [w \in Worktrees |-> "b1"]

(* Send one request and record what the provider read.                     *)
Send(w, s, br, hist, first, prev, changed) ==
  LET req == Instructions(w, br) \o hist
      bps == Breakpoints(req)
  IN /\ cache' = cache \cup {SubSeq(req, 1, n) : n \in bps}
     /\ log' = Append(log, [w |-> w, s |-> s, first |-> first, req |-> req, bps |-> bps,
                            read |-> Hit(req, bps, cache), prev |-> prev, changed |-> changed,
                            repoSeen |-> \E i \in 1..Len(log) : RepoOf[log[i].w] = RepoOf[w],
                            worktreeSeen |-> \E i \in 1..Len(log) : log[i].w = w,
                            anySeen |-> Len(log) > 0])

(* A session starts on the branch its worktree was left on.                 *)
Start(w) ==
  LET s == sessions + 1
      br == branchOf[w]
      hist == << Block("user", ToString(s) \o ".0") >>
  IN /\ ~active.on
     /\ sessions < MaxSessions
     /\ sessions' = s
     /\ active' = [on |-> TRUE, w |-> w, s |-> s, n |-> 0, br |-> br, hist |-> hist,
                   last |-> Instructions(w, br) \o hist, switched |-> FALSE]
     /\ Send(w, s, br, hist, TRUE, <<>>, FALSE)
     /\ UNCHANGED branchOf

(* The next request of the session: a tool step, a new user turn, or a tool *)
(* step after the agent switched branches (the turn context changes).       *)
Continue(kind) ==
  LET a == active
      n == a.n + 1
      br == IF kind = "switch" THEN "b2" ELSE a.br
      hist == Append(a.hist, Block(IF kind = "turn" THEN "user" ELSE "asst",
                                   ToString(a.s) \o "." \o ToString(n)))
  IN /\ a.on
     /\ a.n < MaxSteps
     /\ kind = "switch" => ~a.switched
     /\ active' = [a EXCEPT !.n = n, !.br = br, !.hist = hist,
                            !.last = Instructions(a.w, br) \o hist,
                            !.switched = a.switched \/ kind = "switch"]
     /\ Send(a.w, a.s, br, hist, FALSE, a.last, kind = "switch")
     /\ branchOf' = [branchOf EXCEPT ![a.w] = br]
     /\ UNCHANGED sessions

End ==
  /\ active.on
  /\ active' = NoSession
  /\ UNCHANGED <<cache, sessions, log, branchOf>>

(* The user switches a worktree's branch outside fx between sessions: the  *)
(* next session's turn context differs with no request in between.         *)
ExternalSwitch(w) ==
  /\ ~active.on
  /\ branchOf[w] = "b1"
  /\ branchOf' = [branchOf EXCEPT ![w] = "b2"]
  /\ UNCHANGED <<cache, sessions, active, log>>

Next ==
  \/ \E w \in Worktrees : Start(w)
  \/ \E kind \in {"step", "turn", "switch"} : Continue(kind)
  \/ End
  \/ \E w \in Worktrees : ExternalSwitch(w)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties. Each is an invariant over the request log.                   *)

TypeOK ==
  /\ sessions \in 0..MaxSessions
  /\ \A i \in 1..Len(log) : log[i].read \in 0..Len(log[i].req)

(* Never more markers than the provider accepts.                           *)
Budget == \A i \in 1..Len(log) : Cardinality(log[i].bps) <= Limit

(* A new session in a worktree that already ran reads at least the stable  *)
(* instructions, even when the worktree is now on another branch.          *)
SameWorktreeReuse ==
  \A i \in 1..Len(log) : log[i].first /\ log[i].worktreeSeen => log[i].read >= PosStable

(* A new session in a worktree of a repository that already ran reads at    *)
(* least the stable instructions. Needs PathScoped = FALSE.                 *)
WorktreeReuse ==
  \A i \in 1..Len(log) : log[i].first /\ log[i].repoSeen => log[i].read >= PosStable

(* A new session in any repository reads at least the repo-independent part *)
(* once anything has run.                                                   *)
CrossRepoReuse ==
  \A i \in 1..Len(log) : log[i].first /\ log[i].anySeen => log[i].read >= PosProfile

(* Within a session, a request whose instructions did not change reads all  *)
(* of the previous request.                                                 *)
SessionReuse ==
  \A i \in 1..Len(log) : ~log[i].first /\ ~log[i].changed => log[i].read >= Len(log[i].prev)

(* When the turn context changes mid-session, the stable instructions are   *)
(* still read.                                                              *)
ContextChangeKeepsStable ==
  \A i \in 1..Len(log) : log[i].changed => log[i].read >= PosStable

(* When the turn context changes mid-session, the history is still read.    *)
(* Lesson 4: no design here has it, because the turn context sits ahead of  *)
(* the history. Checked so the gap stays visible.                           *)
ContextChangeKeepsHistory ==
  \A i \in 1..Len(log) : log[i].changed => log[i].read >= Len(log[i].prev)
=============================================================================
