import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { API_BASE_PATH } from "../config.ts";
import type { AppType } from "./app.ts";
import { onError, onNotFound } from "./errors.ts";

/**
 * The API at `API_BASE_PATH`, and the built web app at every other path,
 * answering a path that is not a file with `index.html` so the browser's
 * router handles the deep link. Without a build — development, where Vite
 * serves the app and proxies `/api` here — this is the API alone.
 */
export function mount(api: AppType) {
	const app = new Hono().onError(onError).notFound(onNotFound).route(API_BASE_PATH, api);
	if (!existsSync(WEB_ROOT)) {
		return app;
	}

	const files = serveStatic({
		root: WEB_ROOT,
		onFound: (path, c) => {
			c.header("Cache-Control", path.includes("/assets/") ? IMMUTABLE : REVALIDATE);
		},
	});
	const index = serveStatic({
		root: WEB_ROOT,
		path: "index.html",
		onFound: (_path, c) => c.header("Cache-Control", REVALIDATE),
	});
	const isApi = (path: string) => path === API_BASE_PATH || path.startsWith(`${API_BASE_PATH}/`);

	return app.use("*", files).get("*", (c, next) => (isApi(c.req.path) ? next() : index(c, next)));
}

/** The web app's build output, which the image lays out beside the server. */
const WEB_ROOT = fileURLToPath(new URL("../../../web/dist/", import.meta.url));

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
