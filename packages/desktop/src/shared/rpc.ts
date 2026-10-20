import type { RPCSchema } from "electrobun";

/** How long a server has to answer before the app says it can't be reached. */
export const SERVER_CHECK_TIMEOUT_MS = 10_000;

export type ConnectResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string };

/** Between the server picker and the main process. */
export type SetupRPC = {
	bun: RPCSchema<{
		requests: {
			/** The server the app opens now, if one has been chosen. */
			currentServer: { params: undefined; response: string | null };
			/** Opens the Sugabots server at `address` once it answers as one. */
			connect: { params: { address: string }; response: ConnectResult };
		};
	}>;
	webview: RPCSchema;
};

/** A command a bot asked to run, waiting for the person's answer. */
export interface CommandRequest {
	readonly command: string;
	readonly cwd: string;
}

/** Between an approval window and the main process. */
export type ApprovalRPC = {
	bun: RPCSchema<{
		requests: {
			command: { params: undefined; response: CommandRequest };
			decide: { params: { allow: boolean }; response: undefined };
		};
	}>;
	webview: RPCSchema;
};
