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
	/**
	 * Where bot-made HTML pages are served from, as an origin of its own so a
	 * page shares nothing with the app. The same server answers there, and
	 * only with pages. `undefined` when unset: pages are then written into
	 * their frame instead.
	 */
	readonly contentOrigin: string | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Installation") {}

export const make = Effect.gen(function* () {
	const environment = yield* Config.Literals(
		["development", "production", "test"],
		"NODE_ENV",
	).pipe(Config.withDefault("development"));
	const port = yield* Config.Port("PORT").pipe(Config.withDefault(3000));
	const publicUrl = yield* Config.URL("PUBLIC_URL").pipe(
		Config.withDefault(new URL(`http://localhost:${port}`)),
	);
	const webAppUrl = yield* Config.option(Config.URL("WEB_APP_URL"));
	const contentOrigin = yield* Config.option(Config.URL("CONTENT_ORIGIN"));
	for (const [name, url] of [
		["PUBLIC_URL", publicUrl],
		["WEB_APP_URL", Option.getOrUndefined(webAppUrl)],
		["CONTENT_ORIGIN", Option.getOrUndefined(contentOrigin)],
	] as const) {
		if (url && url.protocol !== "http:" && url.protocol !== "https:") {
			return yield* new InvalidConfig({ message: `${name} must use HTTP or HTTPS` });
		}
	}
	const installation = fromUrls({
		isProduction: environment === "production",
		publicUrl: publicUrl.href,
		webAppUrl: Option.getOrUndefined(webAppUrl)?.href,
		contentOrigin: Option.getOrUndefined(contentOrigin)?.href,
	});
	// Cookies are shared across a host's ports and schemes, and the server tells
	// the content origin apart by the `Host` header alone, so only another
	// hostname keeps it apart.
	const contentHostname = installation.contentOrigin && hostnameOf(installation.contentOrigin);
	if (
		contentHostname &&
		installation.trustedOrigins.some((origin) => hostnameOf(origin) === contentHostname)
	) {
		return yield* new InvalidConfig({
			message: "CONTENT_ORIGIN must have a hostname apart from those of PUBLIC_URL and WEB_APP_URL",
		});
	}
	return installation;
});

export const layer = Layer.effect(Service, make);

export class InvalidConfig extends Data.TaggedError("InvalidInstallationConfig")<{
	message: string;
}> {}

/**
 * The installation at `publicUrl`, with its web app at `webAppUrl` or, when
 * that is omitted, at `publicUrl` too, and its pages at `contentOrigin`'s
 * origin when one is given.
 */
export function fromUrls(input: {
	isProduction: boolean;
	publicUrl: string;
	webAppUrl?: string;
	contentOrigin?: string;
}): Interface {
	const publicUrl = withoutTrailingSlash(input.publicUrl);
	const webAppUrl = withoutTrailingSlash(input.webAppUrl ?? input.publicUrl);
	return {
		isProduction: input.isProduction,
		publicUrl,
		webAppUrl,
		trustedOrigins: [...new Set([new URL(publicUrl).origin, new URL(webAppUrl).origin])],
		contentOrigin: input.contentOrigin ? new URL(input.contentOrigin).origin : undefined,
	};
}

function withoutTrailingSlash(url: string) {
	return url.replace(/\/+$/, "");
}

/** The hostname of `url`, without the trailing dot of a fully qualified name, which names the same host. */
function hostnameOf(url: string) {
	return new URL(url).hostname.replace(/\.$/, "");
}
