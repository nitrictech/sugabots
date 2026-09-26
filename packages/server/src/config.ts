export * as ServerConfig from "./config.ts";

import { Config, Context, Effect, Layer } from "effect";

/** The settings the server itself still reads. Core services read their own. */
export interface Interface {
	readonly port: number;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/server/ServerConfig",
) {}

export const make = Effect.gen(function* () {
	return {
		port: yield* Config.Port("PORT").pipe(Config.withDefault(3000)),
	} satisfies Interface;
});

export const layer = Layer.effect(Service, make);

/** The path under the installation's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";
