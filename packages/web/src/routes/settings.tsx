import { createRoute, redirect } from "@tanstack/react-router";
import { matchesMedia, SIDE_BY_SIDE } from "@/lib/media.ts";
import { shellRoute } from "./workspace.tsx";

/*
 * Settings are a dialog over whatever page is open, named by the address's
 * `?settings=`. Their addresses from before that, `/$workspace/settings` and
 * the pages under it, are still in emails, docs and bookmarks, so each opens
 * the page it names: over the workspace's home, or on a phone over You, which
 * lists the settings and is where their Back leads.
 */

export const settingsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings",
	beforeLoad: ({ params }) => openSettingsAt(params.workspace, ""),
});

export const settingsPageRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/settings/$",
	beforeLoad: ({ params }) => openSettingsAt(params.workspace, params._splat ?? ""),
});

/**
 * Goes on to `page` of the settings, written as `?settings=` writes it, in
 * the address's place. A phone's list of them is You itself.
 */
function openSettingsAt(workspace: string, page: string): never {
	if (!matchesMedia(SIDE_BY_SIDE)) {
		throw redirect({
			to: "/$workspace/you",
			params: { workspace },
			search: page === "" ? {} : { settings: page },
			replace: true,
		});
	}
	throw redirect({
		to: "/$workspace",
		params: { workspace },
		search: { settings: page },
		replace: true,
	});
}
