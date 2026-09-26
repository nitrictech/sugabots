export * as Installation from "./installation.ts";

import { Config, Context, Data, Effect, Layer, Option } from "effect";

/** How this installation is reached, and whether it runs in production. */
export interface Interface {
	readonly isProduction: boolean;
	/** The address in the browser's address bar for the API, without a trailing slash. Email links and OAuth redirects start here. */
	readonly publicUrl: string;
	/** Where the web app is served, without a trailing slash. `publicUrl` unless the web app is hosted apart from the API. */
	readonly webAppUrl: string;
	/** The origins allowed to send the API a cookie: those of `publicUrl` and `webAppUrl`. */
	readonly trustedOrigins: readonly string[];
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Installation") {}

export const make = Effect.gen(function* () {
	const nodeEnv = yield* Config.String("NODE_ENV").pipe(Config.withDefault("development"));
	const environment = environmentFrom(nodeEnv);
	if (!environment) {
		return yield* new InvalidConfig({
			message: `NODE_ENV must be development, production or test, not "${nodeEnv}"`,
		});
	}
	const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
	const publicUrl = yield* Config.URL("PUBLIC_URL").pipe(
		Config.withDefault(new URL(`http://localhost:${port}`)),
	);
	const webAppUrl = yield* Config.option(Config.URL("WEB_APP_URL"));
	for (const [name, url] of [
		["PUBLIC_URL", publicUrl],
		["WEB_APP_URL", Option.getOrUndefined(webAppUrl)],
	] as const) {
		if (url && url.protocol !== "http:" && url.protocol !== "https:") {
			return yield* new InvalidConfig({ message: `${name} must use HTTP or HTTPS` });
		}
	}
	return fromUrls({
		isProduction: environment === "production",
		publicUrl: publicUrl.href,
		webAppUrl: Option.getOrUndefined(webAppUrl)?.href,
	});
});

export const layer = Layer.effect(Service, make);

export type Environment = "development" | "production";

export class InvalidConfig extends Data.TaggedError("InvalidInstallationConfig")<{
	message: string;
}> {}

/**
 * The installation at `publicUrl`, with its web app at `webAppUrl` or, when
 * that is omitted, at `publicUrl` too.
 */
export function fromUrls(input: {
	isProduction: boolean;
	publicUrl: string;
	webAppUrl?: string;
}): Interface {
	const publicUrl = withoutTrailingSlash(input.publicUrl);
	const webAppUrl = withoutTrailingSlash(input.webAppUrl ?? input.publicUrl);
	return {
		isProduction: input.isProduction,
		publicUrl,
		webAppUrl,
		trustedOrigins: [...new Set([new URL(publicUrl).origin, new URL(webAppUrl).origin])],
	};
}

/**
 * The environment `NODE_ENV` names, or `undefined` for a value it does not
 * recognise. `test`, which test runners set, runs as development.
 */
export function environmentFrom(nodeEnv: string): Environment | undefined {
	if (nodeEnv === "production") return "production";
	if (nodeEnv === "development" || nodeEnv === "test") return "development";
	return undefined;
}

function withoutTrailingSlash(url: string) {
	return url.replace(/\/+$/, "");
}
