# YesYouKenSpace opencode fork

Namespaced under `docs/yesyoukenspace/` so it never collides with upstream
`packages/web/src/content/docs/` and survives rebases onto new upstream tags
untouched. This documents **what this fork adds on top of upstream and how to
maintain it** — nothing here is upstream's concern.

## What this fork is

`YesYouKenSpace/opencode`, branch **`v1.18.29-autoapprove`** = the upstream
`v1.18.29` release tag + a small, self-contained stack that turns on and tunes
**model-gated auto-approve** (a classifier reviews each consequential action;
fails closed). It exists because upstream ships this only as an open PR.

Remotes in a checkout:

| remote | repo | use |
| --- | --- | --- |
| `origin` | `anomalyco/opencode` | pull upstream tags to rebase onto |
| `fork` | `YesYouKenSpace/opencode` | push our branch |

## What sits on top of the release tag

1. **Cherry-pick of `anomalyco/opencode#39015`** ("model-gated auto-approve") —
   2 commits: a test-teardown fix and the feature itself. Adds the
   `experimental.auto_approve` config, the `review` permission mode, and the
   TUI "Auto-approve" cycle entry.
2. **Local patch** — `packages/tui/src/context/local.tsx`:
   - **Default to review**: a run-once startup effect that starts on the `build`
     agent in `review` when `experimental.auto_approve` is enabled, instead of
     `normal`. The user can still Tab/toggle away.
   - **Map auto → review**: `permission.toggle()` is wrapped so the auto-approve
     keybind flips `review ↔ normal` instead of the blind `auto ↔ normal`. So
     the keybind (and, via the startup default, the `--auto` flag) never lands
     on blind approve-everything. Falls back to blind `auto` only when the
     classifier is unconfigured or the agent isn't `build`.

   Provider nesting forces this into `local.tsx`: `PermissionProvider` sits
   *above* `SyncProvider` (`packages/tui/src/app.tsx`), so `permission.tsx`
   can't read config; `local.tsx` has both config and the agent state.

Both are guarded by upstream's existing "review requires build + config" effect
and fail safe: if the review overlay can't attach (e.g. the classifier model is
unreachable), opencode drops back to `normal` with a toast.

## Enabling it (runtime config, lives in dotfiles, not here)

In `opencode/.config/opencode/opencode.jsonc`:

```jsonc
"experimental": { "auto_approve": true },
"auto_approve": { "model": "openai/gpt-5.6-luna" }
```

Use a fast, non-reasoning model; a classification over ~15s falls back to the
normal prompt.

## Build / consume

- Build locally: `nix build .#default` (needs network + `~/.cache/nix` writable,
  so it can't run under a restricted sandbox).
- Consumed by dotfiles: `nixos/flake.nix` input
  `opencode.url = "github:YesYouKenSpace/opencode/v1.18.29-autoapprove"`, pinned
  in `nixos/flake.lock`.

## Maintenance

**Update to a newer upstream release:**

```bash
git fetch origin --tags
git rebase vX.Y.Z          # replays our 2 cherry-picks + the local patch + this doc
# resolve any conflicts (this doc is namespaced, so it won't conflict)
git push -f fork HEAD:v1.18.29-autoapprove   # consider renaming the branch to the new tag
```

Then in dotfiles: `cd ~/dotfiles/nixos && nix flake update opencode && make switch`.

**Retire the fork** once `#39015` merges upstream: point the dotfiles flake input
back to `github:anomalyco/opencode/vX.Y.Z`, keep only the local `local.tsx`
patch if still wanted (or upstream that too), and delete the fork branch.

Commits are authored under the original PR author; committer is
`YesYouKenSpace <16360559+YesYouKenSpace@users.noreply.github.com>` (noreply, to
satisfy GitHub email-privacy push protection).
