import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import {
	HttpRouter,
	HttpServerRespondable,
	HttpServerResponse,
	HttpStaticServer,
} from "effect/unstable/http";
import { API_BASE_PATH } from "./api.ts";

/** The web app's build output, which the image lays out beside the server. */
const WEB_ROOT = fileURLToPath(new URL("../../../web/dist/", import.meta.url));

/**
 * The built web app at every path outside `API_BASE_PATH`, answering a path
 * that is not a file with `index.html` so the browser's router handles the
 * deep link. Without a build — development, where Vite serves the app and
 * proxies `/api` here — there is nothing to serve and this adds no route.
 */
export const webAppLayer = existsSync(WEB_ROOT)
	? Layer.effectDiscard(
			Effect.gen(function* () {
				const router = yield* HttpRouter.HttpRouter;
				const serveFile = yield* HttpStaticServer.make({
					root: WEB_ROOT,
					spa: true,
				});
				yield* router.add("GET", "/*", (request) =>
					isApi(request.url)
						? Effect.succeed(HttpServerResponse.empty({ status: 404 }))
						: serveFile.pipe(
								Effect.map((response) =>
									HttpServerResponse.setHeader(
										response,
										"cache-control",
										request.url.includes("/assets/") ? IMMUTABLE : REVALIDATE,
									),
								),
								Effect.catch(HttpServerRespondable.toResponse),
							),
				);
			}),
		)
	: Layer.empty;

/** An unknown API path is a 404, not the web app's `index.html`. */
function isApi(url: string): boolean {
	return url === API_BASE_PATH || url.startsWith(`${API_BASE_PATH}/`);
}

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
