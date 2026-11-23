import type { Usage } from "@sugabots/core/accounting/usage";
import type { Accounts } from "@sugabots/core/accounts/accounts";
import type { Automations } from "@sugabots/core/chats/automations/automations";
import type { ChatDetailsView } from "@sugabots/core/chats/chat-details-view";
import type { ChatFiles } from "@sugabots/core/chats/chats/chat-files";
import type { ChatView } from "@sugabots/core/chats/chats/chat-view";
import type { Chats } from "@sugabots/core/chats/chats/chats";
import type { Reactions } from "@sugabots/core/chats/reactions/reactions";
import type { DesktopViewer } from "@sugabots/core/chats/tools/browser/viewer";
import type { Turns } from "@sugabots/core/chats/turns/turns";
import type { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import type { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import type { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import type { Files } from "@sugabots/core/files/files";
import type { FilePages } from "@sugabots/core/files/pages";
import type { Notifications } from "@sugabots/core/notifications/notifications";
import type { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import type { GitHubApps } from "@sugabots/core/providers/connectors/github/github-app";
import type { GitHubConnectors } from "@sugabots/core/providers/connectors/github/github-connectors";
import type { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import type { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import type { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import type { Membership } from "@sugabots/core/workspaces/membership/membership";
import type { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import type { WorkspaceTimeZone } from "@sugabots/core/workspaces/time-zone/workspace-time-zone";
import type { WorkspaceSetup } from "@sugabots/core/workspaces/workspace-setup/workspace-setup";
import type { StreamAccess } from "../routes/events/access.ts";

/**
 * Everything the routes may ask core for. Each is a service of operations or a view whose
 * every method requires the current actor and authorizes them, or the event
 * streams' `StreamAccess`, which does the same for an event stream. The exception
 * is `Automations.Webhooks`, which nobody signs in to call: the automation's secret
 * admits the run instead; and `Automations.ConnectorEvents`, which an
 * integration's signed delivery admits. `Accounts` is here for the referral link; its
 * `admit` is better-auth's, for somebody who has no account yet.
 *
 * `apiLayer` requires these and nothing else from core, so a route yielding a
 * repository, a workflow's steps or a service that acts for nobody, such as
 * `TurnExecution` or `PersonalAssistants`, does not compile.
 */
export type HttpServices =
	| Accounts.Service
	| Membership.Service
	| WorkspaceSetup.Service
	| WorkspaceTimeZone.Service
	| ProjectAdministration.Service
	| BotAdministration.Service
	| ModelProviderSetup.Service
	| SearchProviderSetup.Service
	| ComputerProviderSetup.Service
	| ComputerNetwork.Service
	| DesktopViewer.Service
	| ProjectComputerSetup.Service
	| GitHubApps.Service
	| GitHubConnectors.Service
	| ConnectorSetup.Service
	| Files.Service
	| FilePages.Service
	| Usage.Service
	| Notifications.Service
	| Chats.Service
	| ChatFiles.Service
	| ChatView.Service
	| Reactions.Service
	| ChatDetailsView.Service
	| Turns.Controls
	| Automations.Service
	| Automations.Webhooks
	| Automations.ConnectorEvents
	| StreamAccess.Service;
