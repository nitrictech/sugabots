import type { Sandbox } from "./sandbox.ts";

export interface Env {
	readonly SANDBOX: DurableObjectNamespace<Sandbox>;
	/** The bearer token Sugabots sends with every request. */
	readonly API_KEY: string;
}
