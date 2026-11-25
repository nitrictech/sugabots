/**
 * The errors the connectors operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";

/** The project has no connector with that id. */
export class ConnectorNotFound
	extends Schema.TaggedError<ConnectorNotFound>()("ConnectorNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project has no connector with that id";
	}
	get userMessage() {
		return userText`No such connector`;
	}
}

/** Another of the project's connectors has that name. */
export class ConnectorNameTaken
	extends Schema.TaggedError<ConnectorNameTaken>()("ConnectorNameTaken", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Another of the project's connectors has that name";
	}
	get userMessage() {
		return userText`A connector with that name already exists here`;
	}
}

/** A tool access change names tools the connector doesn't list. */
export class UnknownConnectorTool
	extends Schema.TaggedError<UnknownConnectorTool>()("UnknownConnectorTool", {
		names: Schema.Array(Schema.String),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The connector does not list ${this.names.join(", ")}`;
	}
	get userMessage() {
		return userText`The connector no longer lists some of those tools. Check the connector to refresh them.`;
	}
}

/**
 * Why a sign-in could not start: the authorization server offers no dynamic
 * client registration, which is the only way Sugabots registers; no server
 * answered; or something else, which the logs say.
 */
const signInStartFailureSchema = Schema.Literals([
	"registration_unsupported",
	"unreachable",
	"unknown",
]);

export type SignInStartFailure = typeof signInStartFailureSchema.Type;

/**
 * The server or its authorization server would not start a sign-in. `reason`
 * is why, as far as it is known; the logs have the full cause.
 */
export class ConnectorOAuthStartFailed
	extends Schema.TaggedError<ConnectorOAuthStartFailed>()("ConnectorOAuthStartFailed", {
		reason: signInStartFailureSchema,
	})
	implements DomainError
{
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get isRetryable() {
		return this.reason === "unreachable";
	}
	override get message() {
		return `A connector's sign-in did not start: ${this.reason}`;
	}
	get userMessage() {
		if (this.reason === "registration_unsupported") {
			return userText`Sugabots can't use this server's sign-in, because the server doesn't let new apps register themselves. Connect it with an access token from the server instead.`;
		}
		if (this.reason === "unreachable") {
			return userText`Sugabots couldn't reach the server to start signing in. Check the address and that the server is running, then try again.`;
		}
		return userText`The server didn't start a sign-in. Try again, or connect it with an access token from the server instead.`;
	}
}

/** A sign-in was asked of a connector that signs in with a secret. */
export class ConnectorDoesNotUseOAuth
	extends Schema.TaggedError<ConnectorDoesNotUseOAuth>()("ConnectorDoesNotUseOAuth", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The connector signs in with a secret, not OAuth";
	}
	get userMessage() {
		return userText`This connector uses a secret, not OAuth`;
	}
}

/** A built-in connector's server needed no sign-in, so nothing was kept. */
export class ConnectorNeededNoSignIn
	extends Schema.TaggedError<ConnectorNeededNoSignIn>()("ConnectorNeededNoSignIn", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The built-in connector's server needed no sign-in, so it was not kept";
	}
	get userMessage() {
		return userText`This server doesn't need a sign-in, so nothing was added. Connect it without one instead.`;
	}
}

/** A GitHub connector whose app isn't installed on an account yet. */
export class GitHubAppNotInstalled
	extends Schema.TaggedError<GitHubAppNotInstalled>()("GitHubAppNotInstalled", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The connector's GitHub App isn't installed yet";
	}
	get userMessage() {
		return userText`Install the connector's GitHub App on an account first.`;
	}
}

/** The project has no GitHub app with that id. */
export class NotGitHubConnector
	extends Schema.TaggedError<NotGitHubConnector>()("NotGitHubConnector", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No such GitHub connector in the project";
	}
	get userMessage() {
		return userText`There's no such GitHub app here. It may have been removed.`;
	}
}

/** A second GitHub app for a project, whose computer can be signed in to only one account there. */
export class ProjectHasGitHubConnector
	extends Schema.TaggedError<ProjectHasGitHubConnector>()("ProjectHasGitHubConnector", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project already has a GitHub app";
	}
	get userMessage() {
		return userText`There's a GitHub app here already. Add repositories to it, or remove it first to connect another account.`;
	}
}

/** A repository the connector's GitHub app can't reach. */
export class RepositoryUnreachable
	extends Schema.TaggedError<RepositoryUnreachable>()("RepositoryUnreachable", {
		repository: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The account doesn't reach ${this.repository}`;
	}
	get userMessage() {
		return userText`The connector's GitHub App can't reach that repository. Give it access on GitHub first.`;
	}
}

/**
 * GitHub refused a request or couldn't be reached. `reason` is GitHub's own
 * words, for the logs and for the bot whose call it was; members are told
 * only that GitHub refused.
 */
export class GitHubRequestFailed
	extends Schema.TaggedError<GitHubRequestFailed>()("GitHubRequestFailed", {
		status: Schema.UndefinedOr(Schema.Int),
		reason: Schema.String,
	})
	implements DomainError
{
	override readonly [ErrorReporter.severity] = "Warn" as const;
	get isRetryable() {
		return this.status === undefined || this.status >= 500;
	}
	override get message() {
		return `GitHub ${this.status ?? "unreachable"}: ${this.reason}`;
	}
	get userMessage() {
		return this.isRetryable
			? userText`We couldn't reach GitHub. Try again in a few minutes.`
			: userText`GitHub refused the project's sign-in. Someone who manages the project can check its GitHub connector in the project's settings.`;
	}
}
