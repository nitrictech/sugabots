import { NodeRuntime } from "@effect/platform-node";
import { BotLoop } from "@sugabots/bot-loop/bot-loop";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { SessionAuthentication } from "@sugabots/core/authentication/session";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { BlobStore } from "@sugabots/core/blob-store/blob-store";
import { BlobDeletions } from "@sugabots/core/blob-store/deletions";
import { AutomationRuns } from "@sugabots/core/chats/automations/runs";
import { ChatServices } from "@sugabots/core/chats/chat-services";
import { ChatWorkflows } from "@sugabots/core/chats/workflows";
import { ProjectComputers } from "@sugabots/core/computers/project-computers";
import { layer as databaseLayer, directClientLayer } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventPruning } from "@sugabots/core/database/events/prune";
import { EventStore } from "@sugabots/core/database/events/store";
import { Email } from "@sugabots/core/email/email";
import { FilePages } from "@sugabots/core/files/pages";
import { UnsentAttachments } from "@sugabots/core/files/unsent-attachments";
import { Ids } from "@sugabots/core/ids/ids";
import { Notifications } from "@sugabots/core/notifications/notifications";
import { layer as operationsLayer } from "@sugabots/core/operations/layer";
import { GitHubSignIn } from "@sugabots/core/providers/connectors/github/github-sign-in";
import { Models } from "@sugabots/core/providers/models/models";
import { Egress } from "@sugabots/core/providers/network/egress";
import { Secrets } from "@sugabots/core/secrets/secrets";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Lanes } from "@sugabots/core/workflows/lanes";
import { WorkflowEngines } from "@sugabots/workflow/engine";
import { Duration, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Authentication } from "./auth/authentication.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { listeningLayer, nodeServerLayer } from "./http/serve.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { layer as schedulerLayer } from "./scheduler/scheduler.ts";

/**
 * What the process owns once and every service above builds on: the pools,
 * ids, blob storage, the cipher, the server's settings and egress
 * policy, the durable events and the bus that fans them out, and the workflow
 * engine with its lanes. A service's `layer` never provides these, so there is one of each
 * however many services use them.
 */
/**
 * The workflow engine, embedded in this server on its Postgres; one server
 * process only. Its messages go through the main pool, so a signal sent in a
 * transaction commits with it; its locks go through the direct connection.
 */
const workflowEngine = WorkflowEngines.singleRunnerWith({
	hostLockWait: Duration.seconds(30),
	sessions: directClientLayer,
});

/** The lanes of every workflow that may wait in one: core's, and the bot loop's turns. */
const lanes = Lanes.layerFor([...ChatWorkflows.definitions, ...BotLoop.definitions]);

const Infrastructure = Layer.mergeAll(
	BlobStore.layer,
	Secrets.layer,
	Egress.layer,
	EventOutbox.layer,
	lanes,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			ServerSettings.layer,
			EventBus.layer.pipe(Layer.provide(directClientLayer)),
			workflowEngine,
		),
	),
	Layer.provideMerge(Layer.mergeAll(Ids.layer, EventStore.layer)),
	Layer.provideMerge(databaseLayer),
);

/** The outside systems: email, the workspaces' models, and the tools turns are offered. */
const OutsideSystems = Layer.mergeAll(Email.layer, Models.layer);

/**
 * Accounts, the pages of the files bots make, and notifying members.
 */
const WorkspacesAndProviders = Layer.mergeAll(Notifications.layer, FilePages.layer).pipe(
	Layer.provideMerge(Accounts.layer),
);

/**
 * The chats, over how they start and signal their workflows: a turn's from
 * the bot loop, which owns its workflow. Their events go through the outbox.
 */
const ChatServiceLayers = ChatServices.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(BotLoop.edgeLayer, AutomationRuns.layer)),
);

/**
 * Background runs the core and bot loop workflows, the scheduler, event
 * pruning, blob deletion, and computer measurement and upgrades.
 */
const Background = Layer.mergeAll(
	ChatWorkflows.layer,
	BotLoop.layer,
	schedulerLayer,
	EventPruning.layer,
	BlobDeletions.layer,
	UnsentAttachments.layer,
	ProjectComputers.sweepLayer,
);

/** The API and the web app on `PORT`, with better-auth answering who is calling. */
const Http = listeningLayer.pipe(
	Layer.provideMerge(
		HttpRouter.serve(Layer.merge(apiLayer, webAppLayer), { disableListenLog: true }),
	),
	Layer.provide([
		Authentication.layer,
		SessionAuthentication.layer,
		WebhookAuthentication.layer,
		requestSpanNames,
	]),
	Layer.provide(nodeServerLayer),
);

/**
 * The process, tier by tier. The tracer goes in at the bottom so that
 * everything is traced: routes, better-auth's hooks, the background work, and
 * the statements they all send. The operation registry, with the services of
 * the domains moved onto operations, sits over the chat services, which some
 * of those are built from: moving a workspace's time zone moves its routines
 * through the store that emits.
 */
export const Main = Layer.mergeAll(Http, Background).pipe(
	Layer.provide(operationsLayer),
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
