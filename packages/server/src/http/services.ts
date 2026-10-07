import type { Usage } from "@sugabots/core/accounting/usage";
import type { Accounts } from "@sugabots/core/accounts/accounts";
import type { ChatView } from "@sugabots/core/conversations/chats/chat-view";
import type { Chats } from "@sugabots/core/conversations/chats/chats";
import type { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import type { Routines } from "@sugabots/core/conversations/routines/routines";
import type { ThreadView } from "@sugabots/core/conversations/thread-view";
import type { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import type { Turns } from "@sugabots/core/conversations/turns/turns";
import type { GitHosts } from "@sugabots/core/git-hosts/git-hosts";
import type { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import type { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import type { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import type { PodSandboxSetup } from "@sugabots/core/sandboxes/pod-sandbox-setup";
import type { SandboxNetwork } from "@sugabots/core/sandboxes/sandbox-network";
import type { SandboxProviderSetup } from "@sugabots/core/sandboxes/sandbox-provider-setup";
import type { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import type { Membership } from "@sugabots/core/workspaces/membership/membership";
import type { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import type { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import type { ChannelAccess } from "../routes/events/access.ts";

/**
 * Everything the routes may ask core for. Each is a use case or a view whose
 * every method requires the current actor and authorizes them, or the event
 * streams' `ChannelAccess`, which does the same for a channel. The exception
 * is `Routines.Webhooks`, which nobody signs in to call: the routine's secret
 * admits the run instead. `Accounts` is here for the referral link; its
 * `admit` is better-auth's, for somebody who has no account yet.
 *
 * `apiLayer` requires these and nothing else from core, so a route yielding a
 * repository, a workflow's steps or a service that acts for nobody, such as
 * `TurnExecution` or `PersonalPods`, does not compile.
 */
export type HttpServices =
	| Accounts.Service
	| Membership.Service
	| Onboarding.Service
	| PodAdministration.Service
	| AgentAdministration.Service
	| ModelProviderSetup.Service
	| SearchProviderSetup.Service
	| SandboxProviderSetup.Service
	| SandboxNetwork.Service
	| DesktopViewer.Service
	| PodSandboxSetup.Service
	| GitHosts.Service
	| ConnectionSetup.Service
	| ModelTrials.Service
	| Usage.Service
	| Chats.Service
	| ChatView.Service
	| ThreadView.Service
	| Turns.Controls
	| Routines.Service
	| Routines.Webhooks
	| ChannelAccess.Service;
