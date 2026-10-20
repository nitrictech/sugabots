export * as Devices from "./devices.ts";

import type { JSONRPCMessage, MCPTransport } from "@ai-sdk/mcp";
import type { DeviceFrame, DeviceLending } from "@sugabots/contracts/devices";
import { Context, Effect, Layer } from "effect";

/**
 * People's desktop apps while they're connected, and the threads their owners
 * have lent them to. Held in this process's memory: a spike's shortcut, which
 * assumes one server process and forgets lending on restart.
 */
export interface Interface {
	/** Registers a device; the owner's earlier device, if still connected, is replaced. */
	readonly connect: (device: {
		ownerId: string;
		name: string;
		send: (frame: DeviceFrame) => void;
	}) => Effect.Effect<Connected>;
	readonly lend: (threadId: string, ownerId: string, lent: boolean) => Effect.Effect<void>;
	readonly lending: (threadId: string, ownerId: string) => Effect.Effect<DeviceLending>;
	/** The connected devices whose owners lent them to the thread. */
	readonly lentTo: (threadId: string) => Effect.Effect<ConnectedDevice[]>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Devices") {}

export const make = Effect.sync(() => {
	const devices = new Map<string, Device>();
	const lentByThread = new Map<string, Set<string>>();

	return Service.of({
		connect: ({ ownerId, name, send }) =>
			Effect.sync(() => {
				devices.get(ownerId)?.disconnect();
				const device = new Device(ownerId, name, send);
				devices.set(ownerId, device);
				return {
					receive: (frame) => device.receive(frame),
					disconnect: () => {
						device.disconnect();
						if (devices.get(ownerId) === device) devices.delete(ownerId);
					},
				};
			}),
		lend: (threadId, ownerId, lent) =>
			Effect.sync(() => {
				const owners = lentByThread.get(threadId) ?? new Set();
				if (lent) owners.add(ownerId);
				else owners.delete(ownerId);
				lentByThread.set(threadId, owners);
			}),
		lending: (threadId, ownerId) =>
			Effect.sync(() => {
				const device = devices.get(ownerId);
				return {
					connected: device !== undefined,
					name: device?.name ?? null,
					lent: lentByThread.get(threadId)?.has(ownerId) ?? false,
				};
			}),
		lentTo: (threadId) =>
			Effect.sync(() =>
				[...(lentByThread.get(threadId) ?? [])].flatMap((ownerId) => {
					const device = devices.get(ownerId);
					return device ? [device] : [];
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps;

/** What the socket's handler does with a connected device. */
export interface Connected {
	/** Hands the device's frame to the session it belongs to. */
	readonly receive: (frame: DeviceFrame) => void;
	/** Ends the device's sessions, for when its socket closes. */
	readonly disconnect: () => void;
}

export interface ConnectedDevice {
	readonly ownerId: string;
	readonly name: string;
	/** A new MCP session with the device, as a transport for an MCP client. */
	readonly openSession: () => MCPTransport;
}

class Device implements ConnectedDevice {
	readonly ownerId: string;
	readonly name: string;
	readonly send: (frame: DeviceFrame) => void;
	readonly #sessions = new Map<string, MCPTransport>();

	constructor(ownerId: string, name: string, send: (frame: DeviceFrame) => void) {
		this.ownerId = ownerId;
		this.name = name;
		this.send = send;
	}

	openSession(): MCPTransport {
		const session = crypto.randomUUID();
		const sessions = this.#sessions;
		const send = this.send;
		const transport: MCPTransport = {
			start: async () => {
				sessions.set(session, transport);
				send({ type: "open", session });
			},
			send: async (message) => send({ type: "message", session, message }),
			close: async () => {
				if (!sessions.delete(session)) return;
				send({ type: "close", session });
				transport.onclose?.();
			},
		};
		return transport;
	}

	receive(frame: DeviceFrame) {
		const transport = this.#sessions.get(frame.session);
		if (!transport) return;
		if (frame.type === "message") transport.onmessage?.(frame.message as JSONRPCMessage);
		if (frame.type === "close") {
			this.#sessions.delete(frame.session);
			transport.onclose?.();
		}
	}

	disconnect() {
		for (const transport of this.#sessions.values()) {
			transport.onerror?.(new Error(`${this.name} disconnected`));
			transport.onclose?.();
		}
		this.#sessions.clear();
	}
}
