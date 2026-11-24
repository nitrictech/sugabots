/**
 * The errors the providers operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { DisplayName, type DomainError, UserText, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";
import { type SignInServiceId, signInServiceNames } from "../built-in-providers.ts";

/** No model provider with that id in the workspace. */
export class ModelProviderNotFound
	extends Schema.TaggedError<ModelProviderNotFound>()("ModelProviderNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No model provider with that id in this workspace";
	}
	get userMessage() {
		return userText`No such model provider`;
	}
}

/** A model provider with that name is in the workspace already. */
export class ModelProviderNameConflict
	extends Schema.TaggedError<ModelProviderNameConflict>()("ModelProviderNameConflict", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A model provider with that name is in this workspace already";
	}
	get userMessage() {
		return userText`A model provider with that name already exists`;
	}
}

/** What a provider lacks before it can be used: a key, or a sign-in to a subscription. */
export type MissingCredential = "api-key" | SignInServiceId;

const missingCredentialSchema = Schema.Literals([
	"api-key",
	"chatgpt",
	"xai",
] as const satisfies readonly MissingCredential[]);

/** The provider's models were to be changed while it has no key or sign-in. */
export class ProviderModelsRequireCredential
	extends Schema.TaggedError<ProviderModelsRequireCredential>()("ProviderModelsRequireCredential", {
		missing: missingCredentialSchema,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The provider's models can't change until it has its ${this.missing} credential`;
	}
	get userMessage() {
		return this.missing === "api-key"
			? userText`Add an API key before managing models`
			: userText`Sign in with ${signInServiceNames[this.missing]} before managing models`;
	}
}

/** The provider was to be switched on while it has no key or sign-in. */
export class ProviderActivationRequiresCredential
	extends Schema.TaggedError<ProviderActivationRequiresCredential>()(
		"ProviderActivationRequiresCredential",
		{ missing: missingCredentialSchema },
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The provider can't be switched on until it has its ${this.missing} credential`;
	}
	get userMessage() {
		return this.missing === "api-key"
			? userText`Add an API key before activating this provider`
			: userText`Sign in with ${signInServiceNames[this.missing]} before activating this provider`;
	}
}

/** Only a custom provider is removed; a built-in one stays, switched off if unwanted. */
export class ModelProviderRemovalNotAllowed
	extends Schema.TaggedError<ModelProviderRemovalNotAllowed>()("ModelProviderRemovalNotAllowed", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The provider is built in, or not in this workspace, so it can't be removed";
	}
	get userMessage() {
		return userText`Only custom providers can be removed`;
	}
}

/** A model added by hand that the provider lists already. */
export class ProviderModelAlreadyConfigured
	extends Schema.TaggedError<ProviderModelAlreadyConfigured>()("ProviderModelAlreadyConfigured", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The model is configured in this workspace already";
	}
	get userMessage() {
		return userText`That model is already configured in this workspace`;
	}
}

/** What a fetched model can do is the provider's to say, so only switching capabilities off changes it. */
export class FetchedModelCapabilitiesImmutable
	extends Schema.TaggedError<FetchedModelCapabilitiesImmutable>()(
		"FetchedModelCapabilitiesImmutable",
		{},
	)
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A fetched model's capabilities are the provider's to say";
	}
	get userMessage() {
		return userText`The provider says what this model can do; switch capabilities off instead`;
	}
}

/** No model with that id at the provider. */
export class ProviderModelNotFound
	extends Schema.TaggedError<ProviderModelNotFound>()("ProviderModelNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No model with that id at the provider";
	}
	get userMessage() {
		return userText`No such provider model`;
	}
}

/** The workspace does not offer the model something was asked to run on. */
export class ModelNotEnabled
	extends Schema.TaggedError<ModelNotEnabled>()("ModelNotEnabled", { model: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `This workspace does not offer the model "${this.model}"`;
	}
	get userMessage() {
		return userText`This workspace does not offer that model`;
	}
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** A change would stop the workspace offering a model its default or a system bot runs on. */
export class ModelInUse
	extends Schema.TaggedError<ModelInUse>()("ModelInUse", {
		/** The provider's name for the model, which an administrator switched on. */
		modelId: DisplayName.schema,
		/** What holds it: the workspace default, and the system bots by name. */
		holders: Schema.Struct({
			workspaceDefault: Schema.Boolean,
			systemBots: Schema.Array(DisplayName.schema),
		}),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The change would stop the workspace offering "${this.modelId}", which is still held`;
	}
	get userMessage() {
		const { workspaceDefault, systemBots } = this.holders;
		const names = [...(workspaceDefault ? ["New bots"] : []), ...systemBots];
		const one = names.length === 1 && !workspaceDefault;
		// A list of names members see is itself a name they see.
		const subject = DisplayName.fromRecord(LIST.format(names));
		return userText`${subject} ${one ? "uses" : "use"} ${this.modelId}. Choose another model for ${one ? "it" : "them"} under Models → Default first.`;
	}
}

/**
 * The server's egress policy refuses the address a model provider, search
 * provider, computer provider or connector was given.
 */
export class UrlNotAllowed
	extends Schema.TaggedError<UrlNotAllowed>()("UrlNotAllowed", {
		/** Why the policy refuses it, in members' words. */
		refusal: UserText.schema,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `The address is not allowed: ${this.refusal}`;
	}
	get userMessage() {
		return this.refusal;
	}
}

/** The provider takes a key; it has no sign-in to start. */
export class ProviderSignInNotOffered
	extends Schema.TaggedError<ProviderSignInNotOffered>()("ProviderSignInNotOffered", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The provider takes an API key, not a sign-in";
	}
	get userMessage() {
		return userText`This provider takes an API key, not a sign-in`;
	}
}

/** The sign-in handed back has expired, or wasn't started for this provider. */
export class ProviderSignInAttemptInvalid
	extends Schema.TaggedError<ProviderSignInAttemptInvalid>()("ProviderSignInAttemptInvalid", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The sign-in attempt is expired, unreadable or for another provider";
	}
	get userMessage() {
		return userText`This sign-in has expired; start again`;
	}
}

/** The subscription's sign-in service refused, couldn't be reached, or answered in a way we can't use. */
export class ProviderSignInFailed
	extends Schema.TaggedError<ProviderSignInFailed>()("ProviderSignInFailed", {
		userMessage: UserText.schema,
		cause: Schema.optional(Schema.Defect()),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.userMessage;
	}
}

/** The provider has no API key or sign-in yet. */
export class DiscoveryCredentialsMissing
	extends Schema.TaggedError<DiscoveryCredentialsMissing>()("DiscoveryCredentialsMissing", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The provider has no API key or sign-in";
	}
	get userMessage() {
		return userText`This provider has no API key or sign-in yet. Add one, then try again.`;
	}
}

/** The provider answered 401 or 403: it doesn't accept the key or sign-in. */
export class DiscoveryCredentialsRejected
	extends Schema.TaggedError<DiscoveryCredentialsRejected>()("DiscoveryCredentialsRejected", {
		status: Schema.Finite,
		statusText: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider answered ${this.status} ${this.statusText}`;
	}
	get userMessage() {
		return userText`The provider didn't accept the API key or sign-in. Replace the key, or sign in again, then try again.`;
	}
}

/** The subscription sign-in couldn't give a live token. */
export class DiscoverySignInLapsed
	extends Schema.TaggedError<DiscoverySignInLapsed>()("DiscoverySignInLapsed", {
		cause: ProviderSignInFailed,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The subscription sign-in gave no live token: ${this.cause.message}`;
	}
	get userMessage() {
		return this.cause.userMessage;
	}
}

/** The provider failed or was busy: a 408, 429 or 5xx. Asking again later may work. */
export class DiscoveryUnavailable
	extends Schema.TaggedError<DiscoveryUnavailable>()("DiscoveryUnavailable", {
		status: Schema.Finite,
		statusText: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider answered ${this.status} ${this.statusText}`;
	}
	get userMessage() {
		return userText`The provider couldn't list its models just now. Try again in a few minutes.`;
	}
}

/** No connection to the provider: refused, no such host, or no answer in time. */
export class DiscoveryUnreachable
	extends Schema.TaggedError<DiscoveryUnreachable>()("DiscoveryUnreachable", {
		cause: Schema.Defect(),
	})
	implements DomainError
{
	readonly isRetryable = true;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The provider could not be reached: ${String(this.cause)}`;
	}
	get userMessage() {
		return userText`We can't reach the provider. Check its address, and that the server is running if it's your own. Then try again.`;
	}
}

/** The network policy refused the provider's address before anything was sent. */
export class DiscoveryAddressRefused
	extends Schema.TaggedError<DiscoveryAddressRefused>()("DiscoveryAddressRefused", {
		/** Which of the policy's rules refused it, for the logs. */
		rule: Schema.String,
		/** Why the policy refuses it, in our words. */
		reason: UserText.schema,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return `The network policy refused the provider's address: ${this.rule}`;
	}
	get userMessage() {
		return userText`We can't send requests to the provider's address. ${this.reason}`;
	}
}

/**
 * The provider's answer isn't a model list we can read: a 4xx other than 401
 * or 403 (usually a wrong address), or a body that isn't a model list.
 */
export class ModelListUnreadable
	extends Schema.TaggedError<ModelListUnreadable>()("ModelListUnreadable", {
		/** What was wrong with the answer, for the logs. */
		problem: Schema.String,
		/** The HTTP status, when the provider answered with an error. */
		status: Schema.optional(Schema.Finite),
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.problem;
	}
	get userMessage() {
		return userText`The provider didn't send a model list we can read. Check the address is for the provider's API, then try again.`;
	}
}

/** The provider's model list is bigger than we accept: too many bytes or too many models. */
export class ModelListTooLarge
	extends Schema.TaggedError<ModelListTooLarge>()("ModelListTooLarge", {
		/** Which limit it went over, for the logs. */
		problem: Schema.String,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Warn" as const;
	override get message() {
		return this.problem;
	}
	get userMessage() {
		return userText`The provider lists more models than we can take. Add the models you want by hand instead.`;
	}
}

/** The workspace has no search provider. */
export class SearchProviderNotFound
	extends Schema.TaggedError<SearchProviderNotFound>()("SearchProviderNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The workspace has no search provider";
	}
	get userMessage() {
		return userText`This workspace has no search provider`;
	}
}

/** Search was to be switched on for a built-in provider that needs a key, without one. */
export class SearchProviderApiKeyRequired
	extends Schema.TaggedError<SearchProviderApiKeyRequired>()("SearchProviderApiKeyRequired", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "Search can't be switched on for this provider without an API key";
	}
	get userMessage() {
		return userText`Add an API key before enabling search`;
	}
}
