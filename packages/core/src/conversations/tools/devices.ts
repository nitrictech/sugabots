export * as DeviceTools from "./devices.ts";

import { connectionToolKey, connectionToolMutating } from "@sugabots/contracts";
import { Context, Effect, Layer } from "effect";
import { Devices } from "../../devices/devices.ts";
import { connectOver, type ServerSession } from "../../providers/connections/mcp.ts";
import type { OfferedTool } from "./connections.ts";

/**
 * The tools of the desktops lent to a thread, offered to its turns beside the
 * pod's connections. Each device is keyed by its own handle, such as
 * `tims_laptop__run_command`.
 *
 * Every call runs without the server asking anyone: the desktop asks its owner
 * before it runs anything, which is what keeps a computer in its owner's hands
 * whatever the server decides.
 */
export interface Interface {
	readonly forThread: (threadId: string) => Effect.Effect<DeviceToolSet>;
}

export interface DeviceToolSet {
	readonly tools: Record<string, OfferedTool>;
	/** Ends the sessions behind these tools. */
	readonly close: () => Promise<void>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/DeviceTools") {}

export const make = Effect.gen(function* () {
	const devices = yield* Devices.Service;
	return Service.of({
		forThread: (threadId) =>
			Effect.gen(function* () {
				const lent = yield* devices.lentTo(threadId);
				yield* Effect.logInfo(`Devices lent to thread ${threadId}: ${lent.length}`);
				const opened = yield* Effect.forEach(
					lent,
					(device) =>
						Effect.tryPromise(async () => {
							const session = await connectOver(device.openSession());
							return { device, session, listing: await session.list() };
						}).pipe(
							Effect.catch((failure) =>
								Effect.as(
									Effect.logWarning(`${device.name} left out of the turn`, failure.cause),
									undefined,
								),
							),
						),
					{ concurrency: "unbounded" },
				);
				const sessions: ServerSession[] = [];
				const tools: Record<string, OfferedTool> = {};
				for (const entry of opened) {
					if (!entry) continue;
					const { device, session, listing } = entry;
					sessions.push(session);
					const handle = handleOf(device.name);
					for (const { described, inputSchema, tool } of listing.tools) {
						tools[connectionToolKey(handle, described.name)] = {
							tool: {
								...tool,
								execute: (input, options) => session.run(listing, described.name, input, options),
							},
							handle,
							description: described.description ?? "",
							inputSchema,
							mutating: connectionToolMutating(described),
							access: "allow",
							connectionId: `device:${device.ownerId}`,
							connectionRevision: 0,
							remoteToolName: described.name,
						};
					}
				}
				return {
					tools,
					close: async () => {
						await Promise.allSettled(sessions.map((session) => session.close()));
					},
				};
			}),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

/** No devices, for a case that lends a thread none. */
export const none: Interface = {
	forThread: () => Effect.succeed({ tools: {}, close: async () => undefined }),
};

/** A tool-name-safe handle from the device's name: "Tim's Laptop" becomes `tims_laptop`. */
function handleOf(name: string): string {
	const handle = name
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return handle || "desktop";
}
