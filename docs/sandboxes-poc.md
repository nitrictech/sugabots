# Sandboxes (proof of concept)

Status: plan for the `sandboxes-poc` branch. Phase 1 is built; see
[Phase 1 as built](#phase-1-as-built).

## Goal

Agents in a pod can run software and work on existing code: clone a repository,
edit it, run its tests, and propose the change as a pull request. Everything the
agent runs executes in an isolated sandbox, and no credential that can change
anything outside the sandbox ever enters it.

## Decisions

| Decision | Choice |
| --- | --- |
| Whose identity the sandbox acts as | The pod's. Access (repositories, allowed hosts, secrets) is configured on the pod and is the same whoever asked. |
| How many sandboxes | One per pod, created on first use and shared by every thread and agent in the pod. |
| Where git runs | Inside the sandbox for everything local (clone, fetch, branch, commit, diff, test). Push and pull request creation are tools the server carries out, behind approval. |
| Isolation | A property of each provider. The first provider is OpenSandbox on Docker, with gVisor (`runsc`) as the runtime wherever it's installed; other providers (E2B, ...) declare what they give. |
| First provider | OpenSandbox (Apache-2.0) run locally in Compose, rather than a Docker provider of our own. It gives exec, files, pause/resume, egress rules and credential injection already, and tests the interface against an API we didn't design. See [Spike findings](#spike-findings-opensandbox). |
| Where the agent loop runs | Where it does today, in the turn worker. The sandbox is compute that tools drive; it holds no model credentials and no agent state. |
| Who manages a pod's sandbox and repositories | Workspace admins only, for now. |
| Which agents get sandbox tools | Opt-in per agent. System agents never do: they have no pod. |
| When a sandbox is paused | When nobody holds a lease on it, after a short grace period. The next tool call resumes it. |

Why these, briefly: nearly every mature harness (Managed Agents, OpenAI Agents
SDK, Open SWE, Mastra, Copilot, Claude Code on the web) keeps the loop and the
credentials outside the sandbox and adds credentials at an egress proxy. The
pod-bound identity follows Claude Tag's channel identity, which fits shared pods
better than running as whichever member asked (Devin, Cursor, Linear). See
[References](#references).

## Architecture

```
turn worker (any API process)
  │  sandbox tools: exec, read/write/edit file, repo_checkout
  │  repo tools:    repo_push, repo_open_pull_request  (approval)
  ▼
Sandbox service ── workspace's sandbox provider ──► opensandbox | e2b | ...
  │                                         │
  │                                         ▼
  │                                    pod sandbox  (/workspace/<thread>/<repo>)
  │                                         │ all outbound traffic
  ▼                                         ▼
Postgres (pod_sandbox, sandbox_lease,   egress proxy ── allowlist per pod
          pod_repository, worktrees)         └─ injects read-only GitHub token
                                                for github.com clone/fetch
GitHub App ◄── push + PR from the server, with a write token that never
               reaches the sandbox
```

### Sandbox service

`packages/core/src/sandboxes/sandbox.ts`. Each workspace configures its own
sandbox provider in settings, the way it configures a search provider: a
preset (OpenSandbox for now), the service's address and a sealed key, the
image, the isolation it runs with, and the hosts sandboxes may reach. Stored in
`sandbox_provider`, one per workspace. `Sandbox.forConnection` turns that row
into a provider; implementations live under `implementations/`.

What stays with the installation is whether a workspace may choose `container`
isolation at all (`SANDBOX_ALLOW_UNISOLATED`), since an escape from one lands
on the installation's host.

The required surface stays small, following LangChain Deep Agents' finding that
every file tool can be built on exec plus upload and download. That keeps a new
provider to a handful of methods.

```ts
export interface Interface {
  readonly isolation: Isolation; // "container" | "gvisor" | "microvm"
  readonly pauseKeeps: PauseKeeps; // "memory" | "filesystem" | "nothing"
  readonly create: (spec: Spec) => Effect.Effect<Handle, CreateFailed>;
  readonly connect: (id: ProviderSandboxId) => Effect.Effect<Handle, SandboxMissing>;
}

export interface Handle {
  readonly id: ProviderSandboxId;
  readonly exec: (command: Command) => Effect.Effect<Execution, ExecFailed>;
  readonly upload: (path: SandboxPath, content: Uint8Array) => Effect.Effect<void, ExecFailed>;
  readonly download: (path: SandboxPath) => Effect.Effect<Uint8Array, ExecFailed>;
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  readonly destroy: Effect.Effect<void>;
}
```

`pause` means "stop costing compute". What survives differs by provider, so each
declares it in `pauseKeeps`, and the resume message the agent gets depends on
it:

| Provider | `pauseKeeps` | Notes |
| --- | --- | --- |
| OpenSandbox on Docker | `memory` | `docker pause`: processes are frozen and carry on after resume (confirmed in the spike, ~80ms each way). Frees CPU but still holds memory. |
| OpenSandbox on Kubernetes | `filesystem` | Commits the root filesystem to an OCI image in a registry and releases the pod; processes end. |
| Our own Docker provider (not planned) | `filesystem` | Would use `docker stop`, which frees memory too but ends processes. |
| Kubernetes agent-sandbox | `filesystem` | Scales the pod to zero; the workspace volume stays. |
| Vercel Sandbox | `filesystem` | Filesystem saved on stop. |
| E2B | `memory` | Keeps memory and running processes; bills storage only. |
| Fly Sprites | `memory` | Checkpoint and restore. |
| Cloudflare Sandbox | `nothing` | Disk resets to the image on sleep. Usable only with a backup to R2 before sleeping, since losing work silently isn't allowed. |

A provider whose pause keeps `nothing` is never paused by the reconciler.

`Execution` streams stdout and stderr and resolves to an exit code. Background
processes, PTY, port exposure and snapshots are left out of the PoC; they become
optional capabilities when needed.

### Leases and pausing

A turn that uses the sandbox holds a lease on it. When no lease is live, the
sandbox is paused after a grace period, and the next lease resumes it.

- **Leases, not a counter.** "Is anyone using it" is a query for unexpired
  leases (`sandbox_lease`), not a stored count. A counter drifts the first time
  a process dies between incrementing and decrementing; an expired lease simply
  stops counting.
- **Acquired on first sandbox tool call** in a turn, not when the turn starts,
  so a turn that never touches the sandbox doesn't wake it.
- **Renewed while the turn runs** (every 30s, expiring after 90s), so a crashed
  API process can't hold a sandbox awake. Released when the turn finishes, fails,
  or parks waiting for an approval: a push waiting on a human shouldn't keep the
  sandbox running.
- **Grace period** (`SANDBOX_IDLE_GRACE`, default 5 minutes) before pausing.
  Leases end with every turn, and a conversation is a run of turns seconds or
  minutes apart; pausing the moment the last lease ends would pause and resume
  between nearly every message.
- **Who pauses it:** a reconciler in the background layer (beside the existing
  workers) finds running sandboxes with no live lease and `lastLeaseEndedAt`
  older than the grace period, and pauses them. It takes the pod's advisory lock
  so it can't race a turn acquiring a lease.
- **Resume** happens inside lease acquisition, under the same lock.
- **Worktree leases** (below) are the same rows with a worktree set, so one
  mechanism answers both "is anyone in this worktree" and "is anyone in this
  sandbox".

When a provider's pause keeps only the filesystem, the agent is told its
sandbox was resumed and that anything it left running has stopped.

Resume also re-sends the pod's egress credentials: OpenSandbox keeps them only
in its egress sidecar's memory, so they're gone after a Kubernetes pause or a
sidecar restart.

A lost sandbox is reported, never silently replaced (Open SWE's rule): the
agent is told, and someone with `sandbox.manage` on the pod (a workspace
admin, or a Personal pod's owner) chooses **Start a new sandbox** from the
pod's menu. The same discards a working sandbox that has got into a mess.

### OpenSandbox provider

- `opensandbox/server` runs in `compose.yml` with the Docker socket, so the
  Sugabots API process never holds it. The API talks to it with
  `@alibaba-group/opensandbox` and an API key.
- Sandbox ports are published only on the Docker bridge address
  (`publish_host`), and each sandbox's exec daemon checks an access token.
- Runtime `runsc` where gVisor is installed. A host without it runs `runc`,
  accepted only with `SANDBOX_ALLOW_UNISOLATED=true`, for development and
  trusted single-user installs.
- Commands run as a non-root user (`uid`), not the image's default root.
- Base image `sugabots/sandbox`: Debian with git, curl, build-essential, Node,
  Python, ripgrep, and that user. Stock toolchain only in the PoC; per-pod
  images and setup scripts come later.
- File tools use OpenSandbox's files API, not exec. Every exec costs about a
  second whatever the command, so a `read_file` built on `cat` would be slow.

A Docker provider of our own is only worth writing if OpenSandbox falls short.

### Egress proxy

The policy (allowed hosts, which credentials go to which hosts) is Sugabots'
and the same for every provider. How traffic is forced through the proxy is the
provider's job, because proxy environment variables alone are advisory: a tool
that ignores `HTTPS_PROXY` goes straight out. Docker does it with an `internal`
network. A hosted provider does it with its own egress rules set to allow only
the proxy's address (E2B `allowOut`, Vercel network policy), with the proxy
reachable over the internet and authenticated per sandbox. A provider that can't
restrict egress to one address can't be used with credentials.

**On OpenSandbox the provider enforces the policy itself**, so no proxy of ours
is needed. Each sandbox gets an egress sidecar (DNS filtering plus nftables),
and its Credential Vault injects credentials by host, method and path through
TLS interception. Sugabots creates the sandbox with the pod's allowlist and
default-deny, then writes the credential bindings. Rules are domain names only;
there are no IP or CIDR rules.

For a provider without this, the rest of this section applies: a proxy of ours
running beside Postgres in `compose.yml`. mitmproxy with a small addon is enough
for that, since it already does TLS termination and request rewriting.

- Each sandbox authenticates to the proxy with a per-sandbox proxy credential in
  its proxy URL. That credential identifies the sandbox and grants nothing
  beyond the pod's policy.
- The addon asks the API for that sandbox's policy: allowed hosts (defaults:
  package registries and GitHub) and credential rules.
- For `github.com` and `api.github.com` it injects a read-only GitHub App
  installation token scoped to the pod's repositories. The sandbox sees only
  `GH_TOKEN=proxy-injected`.
- The injected token is read-only, so a `git push` from inside the sandbox is
  rejected by GitHub; the only way to push is the `repo_push` tool. (The spike
  confirmed that requests not matching a credential binding go out with no
  credential added.)
- Private and metadata addresses (RFC 1918, 169.254.169.254) and the Sugabots
  API are refused, reusing the rules in `providers/network/egress.ts`.
- Every request is logged with the sandbox and turn it came from.

### Repositories and git

- A GitHub App installed on the organisation. The server keeps its private key,
  sealed with the existing credential cipher.
- `pod_repository` binds repositories to a pod. Tokens are minted by the server
  for exactly those repository IDs, one hour at a time.
- `repo_checkout` clones or fetches into `/workspace/<threadId>/<repo>` and
  creates a git worktree on a `pod/<podId>/<threadId>` branch. Every thread gets
  its own worktree so agents in the same pod don't edit the same tree.
- A lease on the worktree (a `sandbox_lease` row with the worktree set) stops
  two turns editing it at once; the second is told who holds it.
- `.git/hooks` and `.git/config` are made read-only to the agent's user, so an
  injected instruction can't plant a hook the server later runs.

**`repo_push`** (mutating, needs approval):

1. `git bundle create` in the sandbox for the thread's branch, then download the
   bundle.
2. On the server, fetch the bundle into a cached bare clone and check it: the
   branch is `pod/<podId>/…`, it isn't the default branch, and it doesn't touch
   `.github/workflows` unless the approver was shown that and agreed.
3. Push from the server with a short-lived write token.

**`repo_open_pull_request`** (mutating, needs approval) opens the PR as the
GitHub App, with the person whose message started the work as `Co-authored-by`,
and links back to the thread.

This needs git in the server image (`Dockerfile`).

## Changes to existing code

| Area | Change |
| --- | --- |
| `conversations/tools/for-turn.ts` | Register the sandbox and repo tools for a crew agent with `sandboxEnabled`. |
| `conversations/tools/calls/recorded.ts` | Split "acted" from "needs approval". Exec changes sandbox state, so a turn that ran a command must not be retried, but it runs without approval: the sandbox is the boundary. Only `repo_push` and `repo_open_pull_request` ask. |
| `conversations/tools/approvals/store.ts` | Approvals are keyed to a connection (`connectionId`, `connectionRevision`, `remoteToolName`). Generalise the subject so a built-in tool can be approved, and show the push's branch and diff summary on the approval card. |
| `conversations/turns/worker.ts` | The 10-minute `TURN_TIMEOUT` and 8-step cap are too small for coding work. Make both a property of the turn, larger when sandbox tools are present. |
| `conversations/turns/context.ts` | Describe the sandbox, the thread's worktree and the pod's repositories in the `[Turn]` instruction. |
| `contracts/src/built-in-tools.ts` | Catalogue entries for the new tools, so `disabledTools` and the tool access UI cover them. |
| `web` | Render exec calls (command, streamed output, exit code) in the tool activity log. A file panel and diff view come after the PoC. |

## New tables

- `pod_sandbox`: `podId` (unique), `provider`, `providerSandboxId`, `status`
  (`creating`, `running`, `paused`, `missing`), `isolation`, `lastLeaseEndedAt`.
  Creation takes an advisory lock on the pod, because a turn in any API process
  may be first to need it.
- `pod_repository`: `podId`, `githubInstallationId`, `githubRepositoryId`,
  `fullName`, `defaultBranch`.
- `sandbox_lease`: `podSandboxId`, `turnId`, `worktreeId` (nullable),
  `expiresAt`.
- `sandbox_worktree`: `podSandboxId`, `threadId`, `repositoryId`, `path`,
  `branch`.
- `agent.sandboxEnabled`: the per-agent opt-in.

## Phases

1. **Run software.** Sandbox service, OpenSandbox in Compose and its provider, the `exec`,
   `read_file`, `write_file` and `edit_file` tools, the `pod_sandbox` and
   `sandbox_lease` tables, the per-agent switch, and exec rendering in the web
   app. Egress is open, behind a flag. Done when an agent can write a script in
   a pod, run it, and report the output, and a second thread in the same pod
   sees the same sandbox.
2. **Egress policy.** A per-pod allowlist with defaults, applied through
   OpenSandbox's network policy with default-deny. Done when a request to a
   host outside the allowlist fails from inside the sandbox.
3. **Check out code.** GitHub App, `pod_repository`, read-only token injection,
   `repo_checkout`, per-thread worktrees and leases. Done when an agent clones a
   private repository, changes it and runs its tests, and `git push` from inside
   the sandbox is refused.
4. **Propose changes.** The approval generalisation, `repo_push` with its
   checks, `repo_open_pull_request`. Done when an approved push produces a PR
   from `pod/<podId>/<threadId>`, and a push touching `.github/workflows` shows
   that on the approval card.
5. **Pausing and a second provider.** The reconciler that pauses leaseless
   sandboxes, resume on lease (re-sending credentials), reaping sandboxes of
   deleted pods. Add E2B as the second provider: the hosted option, and the
   first test of egress through a proxy of ours. Done when a sandbox
   pauses five minutes after its last turn, resumes on the next tool call, and a
   turn killed mid-run doesn't keep it awake.

## Spike findings (OpenSandbox)

Run on 2026-09-25 against `opensandbox/server:latest` in Compose, execd v1.1.0,
egress v1.1.7, TypeScript SDK 1.1.0, Docker 29 on `runc`.

| Check | Result |
| --- | --- |
| Create | ~5.5s with images cached (~58s on first run, pulling images) |
| Exec streaming | Output arrives as it's written (lines 500ms apart arrived 500ms apart); exit code returned |
| Exec overhead | ~1s per call, even for `true` |
| Files | Binary bytes round-trip through `writeFiles` / `readBytes` |
| Second client | `Sandbox.connect(id)` from another client sees the same filesystem |
| Background process | `background: true` keeps running; survives pause/resume |
| Pause / resume | ~80ms each; state `Paused` / `CONTAINER_PAUSED` |
| Egress, host not allowed | Blocked (DNS doesn't resolve) |
| Egress, allowed host | Works |
| Egress, raw IP | Blocked (times out) |
| Credential injection | `Authorization` added for the bound host, method and path only; never visible in the sandbox's environment |
| git clone through the egress sidecar | Works for an allowed host (github.com) |
| Non-root commands | `uid: 1000` works; the default is root |
| Isolation | `runc` (host kernel), because gVisor isn't installed on this machine |

## Phase 1 as built

- Workspace settings → Sandboxes: set up OpenSandbox, its URL and key (with a
  connection test), image, isolation and allowed hosts, and a switch. Stored in
  `sandbox_provider` (`packages/core/src/providers/sandbox-providers/`), served
  at `/workspaces/:workspace/sandbox-provider` to workspace admins.
- `packages/core/src/sandboxes/`: the provider interface, the OpenSandbox
  provider, and the pod sandbox store with leases. `store.test.ts` covers one
  sandbox per pod, concurrent first use, a lost sandbox not being replaced, a
  provider switched off, unisolated sandboxes only where allowed, and lease
  release and renewal.
- `packages/core/src/conversations/tools/sandbox/`: `run_command`, `read_file`,
  `write_file`, `edit_file`, and the per-turn lease that backs them.
- `agent.sandbox_enabled`, switched on the agent's settings page.
- OpenSandbox in `compose.yml` behind `--profile sandboxes`, and
  `SANDBOX_ALLOW_UNISOLATED` in `.env.example`.
- Turns with sandbox tools may make 40 model calls rather than 8.

Checked end to end against a local OpenSandbox (the tools called directly,
without a model): write, run, edit, run again, read, clone from GitHub,
`npm view`, a host outside the allowlist refused, and a second turn seeing the
first one's files.

Differences from the plan, and what's left for later phases:

- The allowlist is the workspace's, not yet each pod's. Saving a change updates
  running sandboxes' egress rules straight away, and a paused one when it
  wakes, except a switch to or from `*` (anywhere): a sandbox made to reach
  anywhere has no egress filter to change, so that reaches new sandboxes only.
  Phase 2 is per-pod lists.
- Exec calls show in the web app as any tool call does: the command and the
  final output, not output streaming as it arrives.
- Deleting a pod destroys its sandbox first. Deleting a whole workspace does
  not yet: its sandboxes' rows go with it, and the sandboxes keep running.
- The pod's advisory lock is held, in a transaction, while its sandbox is first
  made. That's seconds with the image cached, and about a minute the first
  time an image is pulled, during which the pod's other turns wait on it.
- OpenSandbox's file API names owners rather than numbering them, so the
  sandbox gets a user named `agent` (uid 1000) when it's made. Images need
  `useradd` and `groupadd`, which Debian and Ubuntu images have.

## Pausing as built

- A sweep in every API process (`sandboxes/pausing.ts`, once a minute) pauses
  running sandboxes that have had no live lease for
  `SANDBOX_IDLE_PAUSE_MINUTES` (5 by default). It takes each pod's lock
  without waiting, so a pod whose turn is taking a lease is skipped until the
  next sweep, and checks again under the lock that the sandbox is still idle.
- The next lease on a paused sandbox resumes it, marks it running, and the
  agent's first sandbox result after that carries a note saying it was paused
  and that programs left running may have stopped.
- Providers declare `pauseKeeps`. OpenSandbox declares `filesystem` because it
  can't say whether it runs on Docker (which keeps memory) or Kubernetes (which
  doesn't), so the note is worded for the worse case.
- The pod's sidebar chip shows `paused`.

Checked against the local OpenSandbox: a sandbox running a background loop
paused in about 100ms (`docker inspect` shows it paused), resumed in about a
second on the next command, and the loop carried on with a gap for the pause.

Not done: re-sending egress credentials after a resume (nothing uses
OpenSandbox's credential vault yet), and freeing memory on Docker, where a
pause only stops CPU.

## Phase 3 as built: checking out code

- **GitHub connection**, one per workspace (Workspace settings → GitHub): a
  fine-grained personal access token for now, sealed with the credential key
  and tested against `GET /user`. `apiBaseUrl` and `gitHost` default to
  github.com and can point at GitHub Enterprise Server. A GitHub App each
  installation registers through the manifest flow is the next method.
- **Pod repositories** (pod settings → Repositories), added by whoever holds
  `sandbox.manage`. Each is checked with GitHub when added, which is where its
  default branch and privacy come from.
- **Credentials**: on every lease the pod's sandbox is given the token through
  OpenSandbox's credential vault, bound to `/<repo>.git/info/refs` and
  `/<repo>.git/git-upload-pack` on the git host for the pod's repositories
  only. The sandbox never sees the token, and a push posts to
  `git-receive-pack`, which gets nothing, so GitHub refuses it. A sandbox made
  to reach any host (`*`) has no egress sidecar and so gets no credentials.
- **`repo_checkout(owner/repo)`** clones each repository once per sandbox
  (`/workspace/.repositories/<repo>.git`) and gives each thread its own
  worktree (`/workspace/threads/<thread>/<name>`) on branch
  `pod/<pod>/<thread>`. Calling it again fetches. Commits are authored as the
  agent. Public repositories that aren't the pod's can be checked out too.

Checked against a live sandbox with public repositories: two threads got
separate worktrees and branches from the shared clone, a second checkout
fetched rather than cloned, commits carried the agent's name, and `git push`
from inside failed for want of credentials. A private repository with a real
token hasn't been tried yet.

Not done: `.git/hooks` and `.git/config` aren't made read-only, and there are
no leases on worktrees, so two agents in the same thread share one.

## Phase 4 as built: proposing changes

- **`repo_push(repository)`** and **`repo_open_pull_request(repository, title,
  body)`**, offered when the pod has repositories. Both wait for a person
  every time; there is no "Always allow" for them.
- **Approvals for built-in tools.** An approval's target is either a
  connection tool, at the configuration it was approved under, or a built-in
  tool. Checkpoints from before read as connection approvals.
- **What the approver sees** is worked out by the server, not the model: for a
  push, the repository, the thread's branch, its head commit, the commit
  subjects and changed files, with any `.github/workflows` changes called out;
  for a pull request, head, base and title. It's kept on the call
  (`tool_call.approval_summary`) and shown on the approval card.
- **The push** is done by the server. The sandbox packs the branch into a git
  bundle; the server fetches it into a clone of its own, refuses it if the
  branch has moved since the approved head, and pushes it with the workspace's
  token (given to git through its environment, never its arguments). Only
  the thread's own `pod/<pod>/<thread>` branch, never a force push. The
  server's image now has git for this.
- **The pull request** is opened as a draft by the API, from the thread's
  branch into the default branch, signed with the agent's handle.

Tested: the push flow against a local git remote (pushes new commits, refuses
an empty push, never overwrites the remote, spots workflow changes), and a
built-in approval parking with its summary, refusing "Always allow", and
running once allowed. Not yet tried against GitHub itself.

## Out of the PoC

Kubernetes and microVM providers, snapshots, preview URLs for dev servers,
interactive terminals, per-pod images and setup scripts, secrets beyond the
GitHub token, a file browser, and storing sandbox outputs as pod files.

## Open questions

- **Default CPU, memory and disk** for a sandbox, and how long a paused sandbox
  is kept before it's deleted.
- **gVisor on development machines.** It isn't installed on the spike machine
  (NixOS), so the spike ran on `runc`. Registering it needs a system change:
  `virtualisation.docker.daemon.settings.runtimes.runsc.path`.
- **Where the one-second exec cost comes from.** It's the same for `true` as for
  `echo`, so it's fixed overhead in OpenSandbox rather than the command. Worth
  finding before agents run many short commands.

## References

- Anthropic, Claude Code sandboxing and the GitHub proxy: <https://www.anthropic.com/engineering/claude-code-sandboxing>
- Anthropic, Managed Agents environments: <https://platform.claude.com/docs/en/managed-agents/environments>
- Claude Tag agent identity: <https://claude.com/docs/claude-tag/concepts/agent-identity>
- Open SWE sandbox providers and GitHub token injection: <https://github.com/langchain-ai/open-swe/blob/main/agent/sandboxes/AGENTS.md>
- LangChain Deep Agents sandbox backends: <https://docs.langchain.com/oss/python/deepagents/sandboxes>
- GitHub Copilot cloud agent, risks and mitigations: <https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations>
- OpenHands sandbox server: <https://github.com/OpenHands/sandbox-server>
- Mastra workspace sandboxes: <https://mastra.ai/docs/workspace/sandbox>
- gVisor with Docker: <https://gvisor.dev/docs/user_guide/quick_start/docker/>
- Simon Willison, the lethal trifecta: <https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/>
