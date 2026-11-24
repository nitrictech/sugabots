import { HttpServerResponse } from "effect/unstable/http";

/**
 * A redirect back to the web app at `path`, from a sign-in or setup that went
 * through another site, with the project it is about and any `outcome`
 * parameters, which the web app turns into its own page and words.
 */
export function webAppReturn({
	webAppUrl,
	path,
	at,
	outcome = {},
}: {
	webAppUrl: string;
	path: string;
	at: { workspaceId: string; projectId: string } | undefined;
	outcome?: Record<string, string>;
}): HttpServerResponse.HttpServerResponse {
	const back = new URL(webAppUrl);
	back.pathname = `${back.pathname.replace(/\/$/, "")}${path}`;
	if (at) {
		back.searchParams.set("workspace", at.workspaceId);
		back.searchParams.set("project", at.projectId);
	}
	for (const [name, value] of Object.entries(outcome)) {
		back.searchParams.set(name, value);
	}
	return HttpServerResponse.redirect(back.toString(), { status: 302 });
}

/**
 * The answer to a HEAD on a callback whose GET spends a one-time code, so a
 * link prefetch can't spend it.
 */
export const refuseHead = HttpServerResponse.empty({ status: 405, headers: { allow: "GET" } });
