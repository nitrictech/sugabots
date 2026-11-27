/**
 * The operation registry with every domain's services under it. An entrypoint
 * provides this, over the infrastructure every service shares, and reaches
 * the core only through `Operations.Service`.
 */

import { Layer } from "effect";
import { TurnComputers } from "../chats/tools/computer/turn-computers.ts";
import { ConnectorCalls } from "../providers/connectors/connector-calls.ts";
import { processLayer } from "../tiers.ts";
import { approvalsLayer } from "./approvals/index.ts";
import { automationsLayer } from "./automations/index.ts";
import { botsLayer } from "./bots/index.ts";
import { chatReadsLayer } from "./chat-reads/index.ts";
import { chatsLayer } from "./chats/index.ts";
import { computersLayer } from "./computers/index.ts";
import { connectorsLayer } from "./connectors/index.ts";
import { eventsLayer } from "./events/index.ts";
import { notificationsLayer } from "./notifications/index.ts";
import { projectsLayer } from "./projects/index.ts";
import { providersLayer } from "./providers/index.ts";
import { Operations } from "./registry.ts";
import { scheduledWorkLayer } from "./scheduled-work.ts";
import { turnsLayer } from "./turns/index.ts";
import { webLayer } from "./web/index.ts";
import { workspaceLayer } from "./workspace/index.ts";

const domainOperations = Operations.layerNoDeps.pipe(
	Layer.provide(
		Layer.mergeAll(
			workspaceLayer,
			projectsLayer,
			botsLayer,
			chatsLayer,
			chatReadsLayer,
			automationsLayer,
			computersLayer,
			connectorsLayer,
			providersLayer,
			webLayer,
			approvalsLayer,
			eventsLayer,
			turnsLayer,
			notificationsLayer,
			scheduledWorkLayer,
		),
	),
	// Computer operations and the bot loop share the service that owns each step's computer.
	Layer.provideMerge(TurnComputers.layer),
);

export const layer = domainOperations.pipe(Layer.provideMerge(ConnectorCalls.layer));

export const layerWithConnectorCalls = (calls: ConnectorCalls.Interface) =>
	domainOperations.pipe(
		Layer.provideMerge(processLayer(Layer.succeed(ConnectorCalls.Service, calls))),
	);
