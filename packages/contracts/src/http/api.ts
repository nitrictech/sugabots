import { HttpApi } from "effect/unstable/httpapi";
import { AgentsApi } from "./groups/agents.ts";
import { ChatsApi } from "./groups/chats.ts";
import { ConnectionsApi } from "./groups/connections.ts";
import { EventsApi } from "./groups/events.ts";
import { GitHostsApi } from "./groups/git-hosts.ts";
import { ModelProvidersApi } from "./groups/model-providers.ts";
import { ModelTrialsApi } from "./groups/model-trials.ts";
import { OnboardingApi } from "./groups/onboarding.ts";
import { PodSandboxApi } from "./groups/pod-sandbox.ts";
import { PodsApi } from "./groups/pods.ts";
import { ReferralsApi } from "./groups/referrals.ts";
import { RoutinesApi } from "./groups/routines.ts";
import { SandboxProvidersApi } from "./groups/sandbox-providers.ts";
import { SearchProvidersApi } from "./groups/search-providers.ts";
import { SystemApi } from "./groups/system.ts";
import { SystemAgentsApi } from "./groups/system-agents.ts";
import { ThreadsApi } from "./groups/threads.ts";
import { ToolApprovalsApi } from "./groups/tool-approvals.ts";
import { UsageApi } from "./groups/usage.ts";
import { WorkspacesApi } from "./groups/workspaces.ts";
import { ValidateRequest } from "./middleware.ts";

/** The path under the installation's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";

/**
 * The whole API, as data.
 *
 * The server implements it group by group, and `packages/sdk` derives its
 * client from it, so a route exists in both places or neither. Its paths are
 * relative to `API_BASE_PATH`.
 */
export class Api extends HttpApi.make("sugabots")
	.add(SystemApi)
	.add(WorkspacesApi)
	.add(AgentsApi)
	.add(PodsApi)
	.add(OnboardingApi)
	.add(SystemAgentsApi)
	.add(ModelTrialsApi)
	.add(ModelProvidersApi)
	.add(SearchProvidersApi)
	.add(SandboxProvidersApi)
	.add(PodSandboxApi)
	.add(GitHostsApi)
	.add(ConnectionsApi)
	.add(EventsApi)
	.add(ChatsApi)
	.add(ThreadsApi)
	.add(ToolApprovalsApi)
	.add(RoutinesApi)
	.add(UsageApi)
	.add(ReferralsApi)
	.middleware(ValidateRequest) {}
