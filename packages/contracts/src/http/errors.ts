// biome-ignore-all lint/plugin/errors-implement-domain-error: The HTTP statuses wrap public errors for transport.
import { PublicError, UserText } from "@sugabots/errors";
import { Schema } from "effect";
import type {
	FailureOf,
	HttpOperationName,
	OperationContracts,
	OwnEndpointOperationName,
} from "../operations/index.ts";

/**
 * The API's failures, one class per status.
 *
 * An endpoint lists the ones it can answer with, so a client's error type
 * names exactly those and a handler failing with one it did not declare does
 * not compile. An operation's endpoint lists those `failureForError` answers
 * its errors with. Each is a tagged error on the wire, `{ "_tag": "NotFound",
 * "message": "…" }`, which is what the generated client decodes back into the
 * class.
 */

/** What went wrong, for members to read. */
const message = UserText.schema;

/**
 * Anything machine-readable behind the message: the fields that failed
 * validation, or the code better-auth refused with.
 */
const details = Schema.optional(Schema.Unknown);

/** The `DomainError` behind the status, when there is one. */
const error = Schema.optional(PublicError);

/** The fields every failure has. */
const failureFields = { message, details, error };

/** The statuses the API answers its failures with. */
type FailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500;

/**
 * The base class of a failure answered with `status`: a tagged error whose
 * schema carries the status for the HTTP API to answer with, and whose class
 * keeps it as `status`, so the status is written once, here, and a table
 * that maps errors to failures can require one.
 */
const failureAnswered =
	<Self>() =>
	<
		const Tag extends string,
		const Status extends FailureStatus,
		Extra extends Schema.Struct.Fields = Record<never, never>,
	>(
		tag: Tag,
		status: Status,
		extra?: Extra,
	) =>
		Object.assign(
			Schema.TaggedError<Self>()(
				tag,
				{ ...failureFields, ...(extra ?? ({} as Extra)) },
				{ httpApiStatus: status },
			),
			{ status },
		);

export class BadRequest extends failureAnswered<BadRequest>()("BadRequest", 400) {}

export class Unauthorized extends failureAnswered<Unauthorized>()("Unauthorized", 401) {}

/** The caller can see the thing, and may not do this to it. */
export class Forbidden extends failureAnswered<Forbidden>()("Forbidden", 403) {}

/**
 * Absent, or hidden from the caller: the API does not tell the two apart, so
 * an id cannot be probed for.
 */
export class NotFound extends failureAnswered<NotFound>()("NotFound", 404) {}

export class Conflict extends failureAnswered<Conflict>()("Conflict", 409) {}

export class PayloadTooLarge extends failureAnswered<PayloadTooLarge>()("PayloadTooLarge", 413) {}

/** The body is of a media type the endpoint does not take. */
export class UnsupportedMediaType extends failureAnswered<UnsupportedMediaType>()(
	"UnsupportedMediaType",
	415,
) {}

/**
 * Something went wrong on the server. The message says nothing about what; a
 * defect's message names its `reference`, which finds its full entry in the
 * server's log.
 */
export class InternalServerError extends failureAnswered<InternalServerError>()(
	"InternalServerError",
	500,
	{ reference: Schema.optional(Schema.String) },
) {}

/** Every failure the API answers with, decoded from its body by its `_tag`. */
export const apiFailureSchema = Schema.Union([
	BadRequest,
	Unauthorized,
	Forbidden,
	NotFound,
	Conflict,
	PayloadTooLarge,
	UnsupportedMediaType,
	InternalServerError,
]);

export type ApiFailure = typeof apiFailureSchema.Type;

/** One of the API's failure classes, such as `NotFound`, with the status it is answered with. */
export type ApiFailureClass = (new (fields: {
	readonly message: UserText;
	readonly details?: unknown;
	readonly error?: PublicError;
}) => ApiFailure) & { readonly status: FailureStatus };

/** The operations the HTTP API serves, at a derived endpoint or one of their own. */
type ServedOperationName =
	| HttpOperationName<OperationContracts>
	| OwnEndpointOperationName<OperationContracts>;

/** The tag of every error an operation the HTTP API serves can fail with. */
export type ServedErrorTag = FailureOf<ServedOperationName>["_tag"];

/**
 * How the HTTP API answers each error an operation it serves can fail with:
 * the failure class, and so the status, that carries the error's user message
 * and public fields. One entry per tag, so an error added to a served
 * operation's contract doesn't compile until it has one.
 *
 * Something the caller can't reach is `NotFound`, so an id can't be probed
 * for; something they reach but may not act on is `Forbidden`. A bot's
 * refusals (`BotCannotReach`, approvals and turns that ended) never reach a
 * member's session, and are answered like their nearest member refusal.
 */
export const failureForError = {
	// Hidden, or missing: the API doesn't tell the two apart.
	ResourceHidden: NotFound,
	AutomationNotFound: NotFound,
	AutomationTriggerNotFound: NotFound,
	BotGone: NotFound,
	ChatFileNotFound: NotFound,
	ComputerProviderNotFound: NotFound,
	ConnectorNotFound: NotFound,
	ModelProviderNotFound: NotFound,
	NoComputer: NotFound,
	NotGitHubConnector: NotFound,
	NotBotMember: NotFound,
	NotInProject: NotFound,
	ProjectGone: NotFound,
	ProviderModelNotFound: NotFound,
	ReferralsOff: NotFound,
	SearchProviderNotFound: NotFound,
	SystemBotMissing: NotFound,
	ToolApprovalNotFound: NotFound,

	// Reached, and not the caller's to do.
	ActionForbidden: Forbidden,
	BotCannotReach: Forbidden,
	ApprovalNeeded: Forbidden,
	ApprovalRefused: Forbidden,
	EmailUnverified: Forbidden,

	// Clashes with how things stand now.
	AlreadyInWorkspace: Conflict,
	AlreadyInvited: Conflict,
	AutomationNameTaken: Conflict,
	AutomationTriggerConflict: Conflict,
	BotHasNoModel: Conflict,
	BotNameTaken: Conflict,
	ClaimLost: Conflict,
	ComputerInUse: Conflict,
	ComputerMadeMeanwhile: Conflict,
	ComputerProviderHasComputers: Conflict,
	ComputerUnavailable: Conflict,
	ComputersNotDestroyed: Conflict,
	ConnectorNameTaken: Conflict,
	LeadsProjects: Conflict,
	MembershipRemovalPending: Conflict,
	MessageNotFinished: Conflict,
	MessageRetryKeyConflict: Conflict,
	ModelInUse: Conflict,
	ModelProviderNameConflict: Conflict,
	ProjectHasGitHubConnector: Conflict,
	ProjectHasPrivateBots: Conflict,
	ProjectSlugTaken: Conflict,
	ProviderModelAlreadyConfigured: Conflict,
	SlugTaken: Conflict,
	SubscriptionInUse: Conflict,
	TooManyAutomationTriggers: Conflict,
	TooManyReactionEmoji: Conflict,
	TooManyUnsentAttachments: Conflict,
	ToolApprovalConflict: Conflict,
	TurnEnded: Conflict,
	TurnExecutionSuperseded: Conflict,
	UpgradeFailed: Conflict,

	// Too large to take.
	FileTooLarge: PayloadTooLarge,

	// What was asked for can't be done as asked.
	AdministratorInEveryPrivateBot: BadRequest,
	AdministratorInEveryProject: BadRequest,
	AssistantHandleFixed: BadRequest,
	AssistantInstructionsManaged: BadRequest,
	AutomationRepositoryNotConnected: BadRequest,
	AutomationTriggerKindChanged: BadRequest,
	AutomationTriggerRejected: BadRequest,
	BotHandleReserved: BadRequest,
	BotNotPublic: BadRequest,
	ComputerHostBlocked: BadRequest,
	ComputerProviderBuiltInFixed: BadRequest,
	ComputerProviderIncomplete: BadRequest,
	ConnectorDoesNotUseOAuth: BadRequest,
	ConnectorNeededNoSignIn: BadRequest,
	ConnectorOAuthStartFailed: BadRequest,
	DiscoveryAddressRefused: BadRequest,
	DiscoveryCredentialsMissing: BadRequest,
	DiscoveryCredentialsRejected: BadRequest,
	DiscoverySignInLapsed: BadRequest,
	DiscoveryUnavailable: BadRequest,
	DiscoveryUnreachable: BadRequest,
	EmptyBotUpdate: BadRequest,
	EmptyProjectUpdate: BadRequest,
	FetchedModelCapabilitiesImmutable: BadRequest,
	GitHubAppNotInstalled: BadRequest,
	GitHubRequestFailed: BadRequest,
	InvalidCursor: BadRequest,
	InvalidRoutineSchedule: BadRequest,
	ModelListTooLarge: BadRequest,
	ModelListUnreadable: BadRequest,
	ModelNotEnabled: BadRequest,
	ModelProviderRemovalNotAllowed: BadRequest,
	NoComputerProvider: BadRequest,
	NoModelChosen: BadRequest,
	NoTemplates: BadRequest,
	NotInWorkspace: BadRequest,
	NotReadyToFinish: BadRequest,
	OwnerStays: BadRequest,
	PersonalBotInProject: BadRequest,
	PersonalVisibilityFixed: BadRequest,
	ProviderActivationRequiresCredential: BadRequest,
	ProviderModelsRequireCredential: BadRequest,
	ProviderSignInAttemptInvalid: BadRequest,
	ProviderSignInFailed: BadRequest,
	ProviderSignInNotOffered: BadRequest,
	ReplyTargetNotFound: BadRequest,
	RepositoryUnreachable: BadRequest,
	SearchProviderApiKeyRequired: BadRequest,
	SlugShapedLikeUuid: BadRequest,
	SystemBotImmutable: BadRequest,
	TimeZoneUnknown: BadRequest,
	UnknownConnectorTool: BadRequest,
	UnsentAttachmentsNotFound: BadRequest,
	UnusableProjectName: BadRequest,
	UploadInterrupted: BadRequest,
	UrlNotAllowed: BadRequest,
	WebhookDeliveryIdHeaderRejected: BadRequest,
	WebhookSecretTooShort: BadRequest,
} as const satisfies { readonly [Tag in ServedErrorTag]: ApiFailureClass };

/** The failure class that answers the error tagged `Tag`. */
export type FailureForError<Tag extends ServedErrorTag> = (typeof failureForError)[Tag];
