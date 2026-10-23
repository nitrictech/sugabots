export * as AgentPresence from "./agent-presence.ts";

import { streamEvent, workspaceChannel } from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Effect, Layer, Stream } from "effect";
import { Database, query } from "../database/database.ts";
import { EventBus } from "../database/events/bus.ts";
import { agent } from "../database/schema.ts";
import { DeviceLinks } from "./device-links.ts";

/**
 * Tells each workspace, live, when a bot standing for an agent on somebody's
 * computer goes online or offline: whenever that computer connects,
 * disconnects, or changes what it lends. Not replayed: a client that missed
 * one reads `online` again with the bot.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const links = yield* DeviceLinks.Service;
		const bus = yield* EventBus.Service;
		const database = yield* Database;
		const announce = (deviceId: string) =>
			query((db) =>
				db
					.select({ id: agent.id, workspaceId: agent.workspaceId, url: agent.a2aUrl })
					.from(agent)
					.where(eq(agent.a2aDeviceId, deviceId)),
			).pipe(
				Effect.flatMap((bots) =>
					Effect.forEach(
						bots,
						({ id, workspaceId, url }) =>
							Effect.promise(() =>
								bus.publish(
									workspaceChannel(workspaceId),
									streamEvent("agent.presence_changed", {
										agentId: id,
										online: url !== null && links.lends(deviceId, url),
									}),
								),
							),
						{ discard: true },
					),
				),
				Effect.provideService(Database, database),
				Effect.catchCause((cause) =>
					Effect.logWarning("Announcing a bot's presence failed", cause),
				),
			);
		yield* Effect.forkScoped(links.changes.pipe(Stream.runForEach(announce)));
	}),
);
