/** What the setup page can ask of the main process, which its preload exposes as `window.setup`. */
export interface SetupBridge {
	/** The server the app opens now, if one has been chosen. */
	currentServer(): Promise<string | undefined>;
	/** Opens the Sugabots server at `address` once it answers as one. */
	connect(address: string): Promise<ConnectResult>;
}

export type ConnectResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string };

export const setupChannels = {
	currentServer: "setup:current-server",
	connect: "setup:connect",
} as const;
