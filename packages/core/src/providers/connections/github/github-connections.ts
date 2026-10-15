import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/*
 * A pod's GitHub connection: the pod's own GitHub App (see `github-app.ts`),
 * installed on the account the pod works on. A pod has at most one, since
 * its sandbox can be signed in to only one account at GitHub.
 */

export class NotGitHubConnection
	extends Schema.TaggedError<NotGitHubConnection>()("NotGitHubConnection", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No such GitHub connection in the pod";
	}
	get userMessage() {
		return userText`This pod has no such GitHub connection. It may have been removed.`;
	}
}

/** A second GitHub connection for a pod, whose sandbox can be signed in to only one account there. */
export class PodHasGitHubConnection
	extends Schema.TaggedError<PodHasGitHubConnection>()("PodHasGitHubConnection", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The pod already has a GitHub connection";
	}
	get userMessage() {
		return userText`This pod is already connected to GitHub. Add repositories to that connection, or remove it first to connect another account.`;
	}
}
