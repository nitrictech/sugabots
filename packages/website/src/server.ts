/**
 * Renders pages for the build's prerender and `vite dev`. The live site is
 * static files, served by `worker.ts`.
 */

import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { NOT_FOUND_PAGE_PATH, NOT_FOUND_PRERENDER_HEADER } from "./not-found.ts";

export default createServerEntry({
	async fetch(request) {
		const response = await handler.fetch(request);
		if (!request.headers.has(NOT_FOUND_PRERENDER_HEADER)) return response;
		if (response.ok) {
			// Answering with an error fails the build; the prerender only reports the status, so say why.
			console.error(
				`A route matches ${NOT_FOUND_PAGE_PATH}, so 404.html would be that route, not the not-found page. Move ${NOT_FOUND_PAGE_PATH} to an address no route matches.`,
			);
			return new Response(null, { status: 500 });
		}
		// The prerender's first request adds a trailing slash, which redirects.
		if (response.status !== 404) return response;
		return new Response(response.body, { status: 200, headers: response.headers });
	},
});
