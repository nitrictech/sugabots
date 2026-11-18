import type { Usage } from "@sugabots/core/accounting/usage";
import type { Accounts } from "@sugabots/core/accounts/accounts";
import type { BotComputerSetup } from "@sugabots/core/computers/bot-computer-setup";
import type { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import type { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import type { Automations } from "@sugabots/core/conversations/automations/automations";
import type { ChatFiles } from "@sugabots/core/conversations/chats/chat-files";
import type { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import type { Chats } from "@sugabots/core/conversations/chats/chats";
import type { ConversationView } from "@sugabots/core/conversations/conversation-view";
import type { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import type { Reactions } from "@sugabots/core/conversations/reactions/reactions";
import type { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import type { Turns } from "@sugabots/core/conversations/turns/turns";
import type { Files } from "@sugabots/core/files/files";
import type { FilePages } from "@sugabots/core/files/pages";
import type { Notifications } from "@sugabots/core/notifications/notifications";
import type { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import type { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import type { GitHubConnections } from "@sugabots/core/providers/connections/github/github-connections";
import type { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import type { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import type { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import type { ChannelAdministration } from "@sugabots/core/workspaces/channels/channel-administration";
import type { Membership } from "@sugabots/core/workspaces/membership/membership";
import type { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import type { WorkspaceTimeZone } from "@sugabots/core/workspaces/time-zone/workspace-time-zone";
import type { StreamAccess } from "../routes/events/access.ts";

/**
 * Everything the routes may ask core for. Each is a use case or a view whose
 * every method requires the current actor and authorizes them, or the event
 * streams' `StreamAccess`, which does the same for an event stream. The exception
 * is `Automations.Webhooks`, which nobody signs in to call: the automation's secret
 * admits the run instead; and `Automations.ConnectionEvents`, which an
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
	| Onboarding.Service
	| WorkspaceTimeZone.Service
	| ChannelAdministration.Service
	| BotAdministration.Service
	| ModelProviderSetup.Service
	| SearchProviderSetup.Service
	| ComputerProviderSetup.Service
	| ComputerNetwork.Service
	| DesktopViewer.Service
	| BotComputerSetup.Service
	| GitHubApps.Service
	| GitHubConnections.Service
	| ConnectionSetup.Service
	| Files.Service
	| FilePages.Service
	| ModelTrials.Service
	| Usage.Service
	| Notifications.Service
	| Chats.Service
	| ChatFiles.Service
	| ChatView.Service
	| Reactions.Service
	| ConversationView.Service
	| Turns.Controls
	| Automations.Service
	| Automations.Webhooks
	| Automations.ConnectionEvents
	| StreamAccess.Service;
