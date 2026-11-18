/** What the setup page can ask of the main process, which its preload exposes as `window.setup`. */
export interface SetupBridge {
	/** Adds the Sugabots server at `address` and opens it, once it answers as one. */
	connect(address: string): Promise<ConnectResult>;
}

export type ConnectResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string };

export const setupChannels = {
	connect: "setup:connect",
} as const;
