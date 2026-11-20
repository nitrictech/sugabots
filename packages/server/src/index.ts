import { NodeRuntime } from "@effect/platform-node";
import { Usage } from "@sugabots/core/accounting/usage";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { BlobDeletions } from "@sugabots/core/blob-store/deletions";
import { ComputerNetwork } from "@sugabots/core/computers/computer-network";
import { ComputerProviderSetup } from "@sugabots/core/computers/computer-provider-setup";
import { ProjectComputerSetup } from "@sugabots/core/computers/project-computer-setup";
import { ProjectComputers } from "@sugabots/core/computers/project-computers";
import { Automations } from "@sugabots/core/conversations/automations/automations";
import { AutomationRuns } from "@sugabots/core/conversations/automations/runs";
import { Conversations } from "@sugabots/core/conversations/conversations";
import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { DesktopViewer } from "@sugabots/core/conversations/tools/browser/viewer";
import { BuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import { ComputerTools } from "@sugabots/core/conversations/tools/computer";
import { ConnectionTools } from "@sugabots/core/conversations/tools/connections";
import { Turns } from "@sugabots/core/conversations/turns/turns";
import { ConversationWorkflows } from "@sugabots/core/conversations/workflows";
import { Credentials } from "@sugabots/core/credentials/credentials";
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
import { Installation } from "@sugabots/core/installation/installation";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { GitHubApps } from "@sugabots/core/providers/connections/github/github-app";
import { GitHubConnections } from "@sugabots/core/providers/connections/github/github-connections";
import { GitHubSignIn } from "@sugabots/core/providers/connections/github/github-sign-in";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { PresetSeeding } from "@sugabots/core/providers/model-providers/preset-seeding";
import { Models } from "@sugabots/core/providers/models/models";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { BotAdministration } from "@sugabots/core/workspaces/bots/bot-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { ProjectAdministration } from "@sugabots/core/workspaces/projects/project-administration";
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
 * ids, blob storage, the cipher, the installation's settings and egress
 * policy, the durable events and the bus that fans them out, and the workflow
 * engine with its lanes. A service's `layer` never provides these, so there is one of each
 * however many services use them.
 */
const Infrastructure = Layer.mergeAll(
	BlobStore.layer,
	Credentials.layer,
	Egress.layer,
	EventOutbox.layer,
	ConversationWorkflows.lanes,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			Installation.layer,
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
	ConnectionTools.layer,
);

/**
 * Accounts, members, projects, bots, their files and the providers they
 * use, trying a model, and notifying people.
 */
const WorkspacesAndProviders = Layer.mergeAll(
	Membership.layer,
	Notifications.layer,
	Onboarding.layer,
	ProjectAdministration.layer,
	BotAdministration.layer,
	ModelProviderSetup.layer,
	SearchProviderSetup.layer,
	ComputerProviderSetup.layer,
	ComputerNetwork.layer,
	ProjectComputerSetup.layer,
	GitHubApps.layer,
	GitHubConnections.layer,
	ConnectionSetup.layer,
	Files.layer,
	FilePages.layer,
	ModelTrials.layer,
	Usage.layer,
).pipe(Layer.provideMerge(Accounts.layer));

/**
 * The conversations, over how they start and signal their workflows. Their
 * events go through the outbox.
 */
const ConversationServices = Conversations.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(Turns.signalsLayer, AutomationRuns.layer)),
);

/**
 * What runs without a request: the workflows, the automation scheduler, the
 * nightly event prune, deleting queued blobs, seeding the preset providers
 * into every workspace, pausing idle computers, and measuring running ones'
 * disks.
 */
const Background = Layer.mergeAll(
	ConversationWorkflows.layer,
	Automations.schedulerLayer,
	EventPruning.layer,
	BlobDeletions.layer,
	UnsentUploads.layer,
	PresetSeeding.layer,
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
	Layer.provide(ConversationServices),
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
