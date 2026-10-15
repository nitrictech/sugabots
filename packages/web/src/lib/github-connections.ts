import type { GitHubAppForm } from "@sugabots/contracts";
import { useMutation } from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";

/**
 * Leaves for GitHub to make the pod its own GitHub App, owned by
 * `organization` or by the person; GitHub comes back to install it.
 */
export function useMakeGitHubApp(podId: string) {
	return useMutation({
		mutationFn: async (organization: string | undefined) => {
			const form = await Effect.runPromise(
				client.api.gitHubConnections.start({
					params: { podId },
					payload: organization ? { organization } : {},
				}),
			);
			postToGitHub(form);
		},
	});
}

/** Leaves for GitHub to install the connection's app, or to change which repositories it reaches. */
export function useInstallGitHubApp(podId: string) {
	return useMutation({
		mutationFn: async (connectionId: string) => {
			const { url } = await Effect.runPromise(
				client.api.gitHubConnections.installUrl({ params: { podId, connectionId } }),
			);
			window.location.assign(url);
		},
	});
}

/** GitHub takes a manifest only as a posted form, so the browser leaves with one. */
function postToGitHub({ url, manifest }: GitHubAppForm) {
	const form = document.createElement("form");
	form.method = "post";
	form.action = url;
	const field = document.createElement("input");
	field.type = "hidden";
	field.name = "manifest";
	field.value = manifest;
	form.append(field);
	document.body.append(form);
	form.submit();
}
