import type { GitHubConnections } from "../../../providers/connections/github/github-connections.ts";

/** What the model is told of the pod's GitHub connection with the turn. */
export function gitHubNote(connected: GitHubConnections.Connected, signedIn: boolean): string {
	const listed = connected.repositories
		.map((repository) => `${repository} (https://github.com/${repository}.git)`)
		.join(", ");
	const reading = signedIn
		? "In the sandbox, git clone and fetch of them are signed in to read, outside the sandbox, without a token."
		: "The sandbox's provider can't sign its requests in, so only public ones can be cloned.";
	return `The pod's GitHub connection, ${connected.connection.handle}, works on: ${listed}. ${reading} Nothing in the sandbox can push to them.`;
}
