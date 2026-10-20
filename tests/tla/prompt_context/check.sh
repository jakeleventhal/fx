#!/bin/sh
# Model-check PromptCache with TLC and require each config's expected verdict.
#
# PromptCache: how fx lays out a model request
# (src/core/agent/runtime/prompt_context.zig, orchestrator.zig
# appendStablePromptContext) and how an explicit-caching provider reuses it
# through AI Gateway with caching "auto". proposed.cfg and current-holds.cfg
# must pass. Each current-*.cfg shows a reuse fx misses today. gap-paths.cfg and
# gap-history.cfg show reuse the proposed markers alone cannot give: worktrees of
# one repository differ in the skill catalog and project rules paths, and the
# turn context sits ahead of the history. option-relative-paths.cfg must pass:
# it shows what relative paths would add. Each mutant-*.cfg plants a known-bad
# marker design that its property must catch.
#
# Run the real binary and have TLC replay its requests:
#   bun test ../drivers/prompt_context/
#
# Needs Java 11+ and tla2tools.jar, as ../README.md describes.
set -eu

cd "$(dirname "$0")"
# shellcheck source=../lib/tlc.sh
. ../lib/tlc.sh

tlc_verdicts "$@" <<'EOT'
MCPromptCache proposed - -deadlock
MCPromptCache current-holds - -deadlock
MCPromptCache current-cross-repo CrossRepoReuse -deadlock
MCPromptCache current-same-worktree SameWorktreeReuse -deadlock
MCPromptCache current-context ContextChangeKeepsStable -deadlock
MCPromptCache gap-paths WorktreeReuse -deadlock
MCPromptCache gap-history ContextChangeKeepsHistory -deadlock
MCPromptCache option-relative-paths - -deadlock
MCPromptCache mutant-every-system Budget -deadlock
MCPromptCache mutant-fence-after-context SameWorktreeReuse -deadlock
MCPromptCache mutant-no-auto SessionReuse -deadlock
EOT
