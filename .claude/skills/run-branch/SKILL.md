---
name: run-branch
description: Get a branch's own copy of Sugabots running, with its own database and URLs, and give the person its URL to test themselves. Use when asked to run, start, spin up or try a branch, or for a URL to test one at, and to clean up, remove or stop a branch's copy afterwards.
---

# Run a branch's copy of Sugabots

Get the branch running and hand over its URL. The person tests it themselves:
do not read the diff, open a browser, or test anything unless they ask.

A linked git worktree runs its own copy of the app beside the main
checkout's: its own Postgres database, copied from the main checkout's, and
its own Portless URLs, prefixed with the branch name. Never point a worktree
at the main checkout's database or URLs.

1. Get into the branch's worktree. Given a branch, such as `fix-ui` or
   `origin/fix-ui`, `git fetch origin fix-ui` and use the worktree
   `git worktree list` shows for it, or make one beside the main checkout:
   `git worktree add ../sugabots-fix-ui -b fix-ui origin/fix-ui`. Run every
   later command there. Given no branch, use the current directory, which
   must be a linked worktree on a branch: in the main checkout, ask before
   going on, since it runs on the database every branch copies.
2. `bun install`.
3. `bun run db:branch`. It copies the main checkout's database the first
   time, applies this branch's migrations every time, and writes
   `DATABASE_URL`, `PUBLIC_URL` and `API_URL` into this worktree's `.env`.
   On a branch without a `db:branch` script, run the copy from the checkout
   this skill is in, from this worktree:
   `node <checkout>/packages/core/scripts/db-branch.ts`, where this skill is
   `<checkout>/.claude/skills/run-branch/SKILL.md`. Whichever copy runs, it
   copies the main checkout's database and `.env`. If it says
   the Portless proxy is not running, stop and ask the person to run
   `bun run dev` in the main checkout, which starts it.
4. `bun run dev` in the background. On a branch whose
   `packages/web/vite.config.ts` does not mention `loadEnv`, pass the API's
   URL, or the web app calls the main checkout's API:
   `API_URL=<API_URL from .env> bun run dev`.
5. Wait until `PUBLIC_URL` answers with 200, then reply with:
   - the URL,
   - sign in as `dev@sugabots.local` / `development`, or with their own
     account, since the database is a copy of theirs,
   - `bun run db:branch reset` in the worktree for a fresh copy of the data.

## Cleaning up

When the person says they are done, or invokes this as `/run-branch clean
<branch>`, remove the branch's copy, in this order:

1. Stop its dev server. If this session started it in the background, stop
   that task. Otherwise find what is still running in the worktree and kill
   it, with `kill -9` if it is still there a few seconds after a plain `kill`:
   on Linux, the processes whose `/proc/<pid>/cwd` is inside the worktree.
   Check it has gone before going on: a dev server still running writes
   Vite's cache back into the deleted worktree.
2. Check `git -C <worktree> status --short` and
   `git -C <worktree> log @{u}..` are empty. If not, the person has
   uncommitted or unpushed work there: ask before going on.
3. `git worktree remove --force <worktree>`, then `rm -rf` the folder if
   anything is left in it.
4. `git branch -D <branch>` from the main checkout. This deletes the local
   branch only, never the remote one.
5. `bun run db:branch prune` from the main checkout drops its database.
