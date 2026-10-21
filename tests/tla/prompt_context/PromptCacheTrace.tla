-------------------------- MODULE PromptCacheTrace --------------------------
(***************************************************************************)
(* Replays the requests the real fx binary sent (recorded by               *)
(* tests/tla/drivers/prompt_context/) through PromptCache's provider cache *)
(* and checks them against one modeled design.                             *)
(*                                                                         *)
(* PromptCacheObserved, which the driver writes, defines Observed: one     *)
(* record per model request in send order, with the worktree w, its        *)
(* repository repo, the session s, the request as PromptCache blocks, and  *)
(* manual, the block positions that carried a cache marker. Whether a      *)
(* request is a session's first, which request came before it, and whether *)
(* the turn context changed are derived here, not trusted from the driver. *)
(*                                                                         *)
(* A check passes when TLC stops on ReplayIncomplete: every request was    *)
(* replayed and no listed property failed on the way. Conforms holds when  *)
(* every request has the modeled layout and exactly Design's markers.      *)
(***************************************************************************)
EXTENDS PromptCacheObserved, Naturals, Sequences, FiniteSets, TLC

CONSTANTS Design, Family

VARIABLES i, cache, log
vars == <<i, cache, log>>

PC == INSTANCE PromptCache WITH
  Mutation <- "none", Worktrees <- {}, RepoOf <- [w \in {} |-> "none"],
  MaxSessions <- 0, MaxSteps <- 0, Limit <- 4, PathScoped <- TRUE,
  sessions <- 0, active <- 0, branchOf <- 0

Kinds == <<"tools", "base", "skills", "project", "mcp", "ctx", "rt">>

Layout(req) ==
  /\ Len(req) > PC!NInstr
  /\ \A j \in 1..PC!NInstr : req[j].k = Kinds[j]
  /\ \A j \in (PC!NInstr + 1)..Len(req) : req[j].k \in {"user", "asst"}
  /\ \E j \in (PC!NInstr + 1)..Len(req) : req[j].k = "user"

\* The request before n in the same session, or 0 for a session's first.
Before(n) ==
  LET earlier == {j \in 1..(n - 1) : Observed[j].s = Observed[n].s}
  IN IF earlier = {} THEN 0 ELSE PC!Max(earlier)

Ctx(req) == req[6]

Init ==
  /\ i = 0
  /\ cache = {}
  /\ log = <<>>

Next ==
  /\ i < Len(Observed)
  /\ LET n == i + 1
         o == Observed[n]
         b == Before(n)
         bps == PC!BpsWith(o.req, o.manual)
     IN /\ cache' = cache \cup {SubSeq(o.req, 1, m) : m \in PC!WritesWith(o.req, o.manual)}
        /\ log' = Append(log, [w |-> o.w, s |-> o.s, first |-> b = 0, req |-> o.req, bps |-> bps,
                               read |-> PC!ReadWith(o.req, o.manual, cache),
                               prev |-> IF b = 0 THEN <<>> ELSE Observed[b].req,
                               changed |-> b # 0 /\ Ctx(o.req) # Ctx(Observed[b].req),
                               repoSeen |-> \E j \in 1..i : Observed[j].repo = o.repo,
                               worktreeSeen |-> \E j \in 1..i : Observed[j].w = o.w,
                               anySeen |-> i > 0])
        /\ i' = n

Spec == Init /\ [][Next]_vars

Conforms ==
  \A j \in 1..i : Layout(Observed[j].req) /\ Observed[j].manual = PC!Manual(Observed[j].req)

Budget == PC!Budget
SessionReuse == PC!SessionReuse
CrossRepoReuse == PC!CrossRepoReuse
SameWorktreeReuse == PC!SameWorktreeReuse
ContextChangeKeepsStable == PC!ContextChangeKeepsStable

ReplayIncomplete == i < Len(Observed)
=============================================================================
