/**
 * A person's desktop app, connected to the server so its bots can use tools
 * on that computer. The app dials out over one WebSocket and serves MCP
 * across it, so the server reaches a computer it couldn't connect to.
 */

/** The WebSocket the desktop app opens, under the API's base path. */
export const DEVICE_CONNECT_PATH = "/devices/connect";

/**
 * One frame on the device's socket. Each MCP session the server opens, one
 * per turn using the device, has its own id, so several turns can share the
 * socket without their JSON-RPC ids colliding.
 */
export type DeviceFrame =
	| { readonly type: "open"; readonly session: string }
	| { readonly type: "message"; readonly session: string; readonly message: unknown }
	| { readonly type: "close"; readonly session: string };

/** Whether the caller's device is connected and lent to a thread. */
export interface DeviceLending {
	readonly connected: boolean;
	/** The device's name, when it's connected. */
	readonly name: string | null;
	readonly lent: boolean;
}
