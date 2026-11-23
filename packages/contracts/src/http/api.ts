import { HttpApi } from "effect/unstable/httpapi";
import { ApprovalsApi } from "./groups/approvals.ts";
import { AutomationsApi } from "./groups/automations.ts";
import { BotsApi } from "./groups/bots.ts";
import { ChatsApi } from "./groups/chats.ts";
import { ComputerProvidersApi } from "./groups/computer-providers.ts";
import { ConnectorsApi } from "./groups/connectors.ts";
import { EventsApi } from "./groups/events.ts";
import { FilesApi } from "./groups/files.ts";
import { GitHubConnectorsApi, GitHubWebhooksApi } from "./groups/github.ts";
import { ModelProvidersApi } from "./groups/model-providers.ts";
import { NotificationsApi } from "./groups/notifications.ts";
import { ProjectComputerApi } from "./groups/project-computer.ts";
import { ProjectsApi } from "./groups/projects.ts";
import { ReferralsApi } from "./groups/referrals.ts";
import { SearchProvidersApi } from "./groups/search-providers.ts";
import { SystemApi } from "./groups/system.ts";
import { SystemBotsApi } from "./groups/system-bots.ts";
import { UsageApi } from "./groups/usage.ts";
import { WorkspaceSetupApi } from "./groups/workspace-setup.ts";
import { WorkspacesApi } from "./groups/workspaces.ts";
import { ValidateRequest } from "./middleware.ts";

/** The path under the server's `publicUrl` the API answers at, better-auth's routes included. */
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
	.add(BotsApi)
	.add(ProjectsApi)
	.add(WorkspaceSetupApi)
	.add(SystemBotsApi)
	.add(ModelProvidersApi)
	.add(SearchProvidersApi)
	.add(ComputerProvidersApi)
	.add(ProjectComputerApi)
	.add(GitHubConnectorsApi)
	.add(GitHubWebhooksApi)
	.add(ConnectorsApi)
	.add(FilesApi)
	.add(EventsApi)
	.add(ChatsApi)
	.add(ApprovalsApi)
	.add(AutomationsApi)
	.add(UsageApi)
	.add(ReferralsApi)
	.add(NotificationsApi)
	.middleware(ValidateRequest) {}
