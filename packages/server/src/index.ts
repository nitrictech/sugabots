import { NodeRuntime } from "@effect/platform-node";
import { Usage } from "@sugabots/core/accounting/usage";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { Conversations } from "@sugabots/core/conversations/conversations";
import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { RoutineRuns } from "@sugabots/core/conversations/routines/runs";
import { RoutineScheduler } from "@sugabots/core/conversations/routines/scheduler";
import { BuiltInTools } from "@sugabots/core/conversations/tools/built-in";
import { ConnectionTools } from "@sugabots/core/conversations/tools/connections";
import { TurnRequests } from "@sugabots/core/conversations/turns/requests";
import { Turns } from "@sugabots/core/conversations/turns/turns";
import { ConversationWorkflows } from "@sugabots/core/conversations/workflows";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer } from "@sugabots/core/database/database";
import { EventBus } from "@sugabots/core/database/events/bus";
import { EventOutbox } from "@sugabots/core/database/events/outbox";
import { EventPruning } from "@sugabots/core/database/events/prune";
import { EventStore } from "@sugabots/core/database/events/store";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { ConnectionSetup } from "@sugabots/core/providers/connections/connection-setup";
import { ModelProviderSetup } from "@sugabots/core/providers/model-providers/model-provider-setup";
import { PresetSeeding } from "@sugabots/core/providers/model-providers/preset-seeding";
import { Models } from "@sugabots/core/providers/models/models";
import { Egress } from "@sugabots/core/providers/network/egress";
import { SearchProviderSetup } from "@sugabots/core/providers/search-providers/search-provider-setup";
import { AgentAdministration } from "@sugabots/core/workspaces/agents/agent-administration";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PodAdministration } from "@sugabots/core/workspaces/pods/pod-administration";
import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { Authentication } from "./auth/authentication.ts";
import { apiLayer } from "./http/app.ts";
import { webAppLayer } from "./http/mount.ts";
import { listeningLayer, nodeServerLayer } from "./http/serve.ts";
import { requestSpanNames } from "./http/tracing.ts";
import { observabilityLayer } from "./observability.ts";
import { ChannelAccess } from "./routes/events/access.ts";
import { Workflows } from "./workflows.ts";

/**
 * What the process owns once and every service above builds on: the pool,
 * ids, the cipher, the installation's settings and egress policy, the durable
 * events and the bus that fans them out, and the workflow engine with its
 * lanes. A service's `layer` never provides these, so there is one of each
 * however many services use them.
 */
const Infrastructure = Layer.mergeAll(
	Credentials.layer,
	Egress.layer,
	EventOutbox.layer,
	ConversationWorkflows.lanes,
).pipe(
	Layer.provideMerge(Layer.mergeAll(Installation.layer, EventBus.layer, Workflows.engine)),
	Layer.provideMerge(Layer.mergeAll(Ids.layer, EventStore.layer)),
	Layer.provideMerge(databaseLayer),
);

/** The outside systems: email, the workspaces' models, and the tools turns are offered. */
const Integrations = Layer.mergeAll(
	Email.layer,
	Models.layer,
	BuiltInTools.layer,
	ConnectionTools.layer,
);

/** Accounts, members, pods, agents and the providers they use, and trying a model. */
const WorkspacesAndProviders = Layer.mergeAll(
	Membership.layer,
	Onboarding.layer,
	PodAdministration.layer,
	AgentAdministration.layer,
	ModelProviderSetup.layer,
	SearchProviderSetup.layer,
	ConnectionSetup.layer,
	ModelTrials.layer,
	Usage.layer,
).pipe(Layer.provideMerge(Accounts.layer));

/**
 * The conversations, over how they start and signal their workflows. Their
 * events go through the outbox.
 */
const ConversationServices = Conversations.layer.pipe(
	Layer.provideMerge(Layer.mergeAll(TurnRequests.layer, Turns.signalsLayer, RoutineRuns.layer)),
);

/**
 * What runs without a request: the workflows, the routine scheduler, the
 * nightly event prune, and seeding the preset providers into every workspace.
 */
const Background = Layer.mergeAll(
	ConversationWorkflows.layer,
	RoutineScheduler.layer,
	EventPruning.layer,
	PresetSeeding.layer,
);

/** The API and the web app on `PORT`, with better-auth answering who is calling. */
const Http = listeningLayer.pipe(
	Layer.provideMerge(
		HttpRouter.serve(Layer.merge(apiLayer, webAppLayer), { disableListenLog: true }),
	),
	Layer.provide([Authentication.layer, ChannelAccess.layer, requestSpanNames]),
	Layer.provide(nodeServerLayer),
);

/**
 * The process, tier by tier. The tracer goes in at the bottom so that
 * everything is traced: routes, better-auth's hooks, the background work, and
 * the statements they all send.
 */
const Main = Layer.mergeAll(Http, Background).pipe(
	Layer.provide(ConversationServices),
	Layer.provide(WorkspacesAndProviders),
	Layer.provide(Integrations),
	Layer.provide(Infrastructure),
	Layer.provide(observabilityLayer),
);

Layer.launch(Main).pipe(NodeRuntime.runMain);
