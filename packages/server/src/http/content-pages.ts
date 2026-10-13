import {
	PAGE_CONTENT_POLICY,
	PAGE_HEIGHT_REPORT,
	PAGE_THEME_FROM_FRAGMENT,
	withLeadingTags,
} from "@sugabots/contracts/artifact-pages";
import { ArtifactPages } from "@sugabots/core/artifacts/pages";
import { Installation } from "@sugabots/core/installation/installation";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * Bot-made HTML pages, served from the installation's content origin when
 * one is set, at addresses `ArtifactPages` seals. Only the content origin
 * answers here, and it answers nothing else (see `onlyPagesOnContentHost`).
 *
 * The page's policy comes as a header, which the page cannot remove, and
 * includes `sandbox`, so the page has an opaque origin even if it is opened
 * outside its frame. `Allow-CSP-From` agrees to the policy the web app's frame
 * asks for in its `csp` attribute; a site the page navigates to won't, so
 * Chromium refuses to show it in the frame.
 */
export const contentPageRoutes = Layer.effectDiscard(
	Effect.gen(function* () {
		const router = yield* HttpRouter.HttpRouter;
		const installation = yield* Installation.Service;
		const pages = yield* ArtifactPages.Service;
		const { contentOrigin } = installation;
		if (!contentOrigin) return;
		const sentToContentOrigin = contentOriginMatcher(contentOrigin);
		const headers = {
			"content-security-policy": `sandbox allow-scripts; ${PAGE_CONTENT_POLICY}; frame-ancestors ${installation.trustedOrigins.join(" ")}`,
			"allow-csp-from": new URL(installation.webAppUrl).origin,
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			// The address stops working within minutes, and the page is the pod's.
			"cache-control": "private, no-store",
		};

		// A wildcard rather than a `:token` parameter: the router matches no
		// parameter over 100 characters, and a sealed token is longer.
		yield* router.add(
			"GET",
			`${ArtifactPages.PAGE_PATH}/*`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				if (!sentToContentOrigin(request)) return HttpServerResponse.empty({ status: 404 });
				const token = tokenIn(request.url);
				if (!token) return HttpServerResponse.empty({ status: 404 });
				return yield* pages.open(token).pipe(
					Effect.map(({ html }) =>
						HttpServerResponse.html(
							`${withLeadingTags(html, PAGE_THEME_FROM_FRAGMENT)}${PAGE_HEIGHT_REPORT}`,
						).pipe(HttpServerResponse.setHeaders(headers)),
					),
					Effect.catchTag("ArtifactPageUnavailable", () =>
						Effect.succeed(
							HttpServerResponse.text(
								"This page's address has expired. Open it again in Sugabots.",
								{
									status: 404,
								},
							),
						),
					),
				);
			}),
		);
	}),
);

/** The token in a page's path, `/pages/<token>`, without any query. */
function tokenIn(url: string): string | undefined {
	const path = url.split("?")[0] ?? "";
	const token = path.slice(`${ArtifactPages.PAGE_PATH}/`.length);
	return token && !token.includes("/") ? token : undefined;
}

/**
 * The content origin serves pages and nothing else: not the API, not the web
 * app. It is the same server under another name, so without this every route
 * would answer there too.
 */
export function onlyPagesOnContentHost(contentOrigin: string | undefined) {
	const sentToContentOrigin = contentOrigin ? contentOriginMatcher(contentOrigin) : undefined;
	return <E, R>(
		effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
	): Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E,
		R | HttpServerRequest.HttpServerRequest
	> =>
		Effect.gen(function* () {
			if (!sentToContentOrigin) return yield* effect;
			const request = yield* HttpServerRequest.HttpServerRequest;
			const isPage =
				request.method === "GET" && request.url.startsWith(`${ArtifactPages.PAGE_PATH}/`);
			if (sentToContentOrigin(request) && !isPage) {
				return HttpServerResponse.empty({ status: 404 });
			}
			return yield* effect;
		});
}

/**
 * Whether a request was sent to `contentOrigin`, by its `Host` header read as
 * a browser reads an address at that origin's scheme: case, a default port
 * however written, and the trailing dot of a fully qualified name don't count.
 */
function contentOriginMatcher(contentOrigin: string) {
	const content = new URL(contentOrigin);
	const target = canonicalHost(content);
	return (request: HttpServerRequest.HttpServerRequest) => {
		const host = request.headers.host;
		if (!host || !URL.canParse(`${content.protocol}//${host}`)) return false;
		return canonicalHost(new URL(`${content.protocol}//${host}`)) === target;
	};
}

const canonicalHost = (url: URL) => `${url.hostname.replace(/\.$/, "")}:${url.port}`;
