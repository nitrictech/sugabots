import { NodeRuntime } from "@effect/platform-node";
import { Usage } from "@sugabots/core/accounting/usage";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { BlobDeletions } from "@sugabots/core/blob-store/deletions";
import { Automations } from "@sugabots/core/chats/automations/automations";
import { AutomationRuns } from "@sugabots/core/chats/automations/runs";
import { ChatServices } from "@sugabots/core/chats/chat-services";
import { DesktopViewer } from "@sugabots/core/chats/tools/browser/viewer";
import { BuiltInTools } from "@sugabots/core/chats/tools/built-in";
import { ComputerTools } from "@sugabots/core/chats/tools/computer";
import { ConnectorTools } from "@sugabots/core/chats/tools/connectors";
import { Turns } from "@sugabots/core/chats/turns/turns";
import { ChatWorkflows } from "@sugabots/core/chats/workflows";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { ProjectComputers } from "@sugabots/core/computers/project-computers";
import { layer as databaseLayer, directClientLayer } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventPruning } from "@sugabots/core/database/events/prune";
import { EventStore } from "@sugabots/core/database/events/store";
import { Email } from "@sugabots/core/email/email";
import { Files } from "@sugabots/core/files/files";
import { FilePages } from "@sugabots/core/files/pages";
import { UnsentUploads } from "@sugabots/core/files/unsent-uploads";
import { Ids } from "@sugabots/core/ids/ids";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { ConnectorSetup } from "@sugabots/core/providers/connectors/connector-setup";
import { GitHubApps } from "@sugabots/core/providers/connectors/github/github-app";
import { GitHubConnectors } from "@sugabots/core/providers/connectors/github/github-connectors";
import { GitHubSignIn } from "@sugabots/core/providers/connectors/github/github-sign-in";
import { BuiltInProviderSeeding } from "@sugabots/core/providers/model-providers/built-in-provider-seeding";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { Models } from "@sugabots/core/providers/models/models";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
import { WorkspaceSetup } from "@sugabots/core/workspaces/workspace-setup/workspace-setup";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Authentication } from "./auth/authentication.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { listeningLayer, nodeServerLayer } from "./http/serve.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { StreamAccess } from "./routes/events/access.ts";
import { Workflows } from "./workflows.ts";

/**
 * What the process owns once and every service above builds on: the pools,
 * ids, blob storage, the cipher, the server's settings and egress
 * policy, the durable events and the bus that fans them out, and the workflow
 * engine with its lanes. A service's `layer` never provides these, so there is one of each
 * however many services use them.
 */
const Infrastructure = Layer.mergeAll(
	BlobStore.layer,
	Secrets.layer,
	Egress.layer,
	EventOutbox.layer,
	ChatWorkflows.lanes,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			ServerSettings.layer,
			EventBus.layer.pipe(Layer.provide(directClientLayer)),
			Workflows.engine,
		),
	),
	Layer.provideMerge(Layer.mergeAll(Ids.layer, EventStore.layer)),
	Layer.provideMerge(databaseLayer),
);

/** The outside systems: email, the workspaces' models, and the tools turns are offered. */
const OutsideSystems = Layer.mergeAll(
	Email.layer,
	Models.layer,
	BuiltInTools.layer,
	ComputerTools.layer,
	DesktopViewer.layer,
	ConnectorTools.layer,
);

/**
 * Accounts, memberships, projects, bots, their files and the providers they
 * use, trying a model, and notifying people.
 */
const WorkspacesAndProviders = Layer.mergeAll(
	Membership.layer,
	Notifications.layer,
	WorkspaceSetup.layer,
	ProjectAdministration.layer,
	BotAdministration.layer,
	ModelProviderSetup.layer,
	SearchProviderSetup.layer,
	ComputerProviderSetup.layer,
	ComputerNetwork.layer,
	ProjectComputerSetup.layer,
	GitHubApps.layer,
	GitHubConnectors.layer,
	ConnectorSetup.layer,
	Files.layer,
	FilePages.layer,
	Usage.layer,
).pipe(Layer.provideMerge(Accounts.layer));

/**
 * The chats, over how they start and signal their workflows. Their
 * events go through the outbox.
 */
const ChatServiceLayers = ChatServices.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Turns.signalsLayer, AutomationRuns.layer)),
);

/**
 * What runs without a request: the workflows, the automation scheduler, the
 * nightly event prune, deleting queued blobs, seeding the built-in providers
 * into every workspace, pausing idle computers, and measuring running ones'
 * disks.
 */
const Background = Layer.mergeAll(
	ChatWorkflows.layer,
	Automations.schedulerLayer,
	EventPruning.layer,
	BlobDeletions.layer,
	UnsentUploads.layer,
	BuiltInProviderSeeding.layer,
	ProjectComputers.sweepLayer,
);

/** The API and the web app on `PORT`, with better-auth answering who is calling. */
const Http = listeningLayer.pipe(
	Layer.provideMerge(
		HttpRouter.serve(Layer.merge(apiLayer, webAppLayer), { disableListenLog: true }),
	),
	Layer.provide([Authentication.layer, StreamAccess.layer, requestSpanNames]),
	Layer.provide(nodeServerLayer),
);

/**
 * The process, tier by tier. The tracer goes in at the bottom so that
 * everything is traced: routes, better-auth's hooks, the background work, and
 * the statements they all send.
 */
export const Main = Layer.mergeAll(Http, Background).pipe(
	Layer.provide(ChatServiceLayers),
	Layer.provide(WorkspacesAndProviders),
	Layer.provide(OutsideSystems),
	// What bots' computers are signed in to, which computers leave to the edge.
	Layer.provide(GitHubSignIn.layer),
	Layer.provide(Infrastructure),
	Layer.provide(observabilityLayer),
);

// Only when run, as `node src/index.ts`, so a test can import `Main` to check it loads.
if (import.meta.main) {
	Layer.launch(Main).pipe(NodeRuntime.runMain);
}
