/**
 * The exposure manifest: each operation's contract carries an explicit
 * decision for the HTTP API and one for the bot loop. Offering an operation
 * grants nothing by itself; it makes the operation reachable through that
 * entrypoint, where it proves access like any other caller.
 *
 * A contract without both decisions fails to compile, and `checkExposure`
 * fails to compile when a reason isn't written out, two operations are
 * offered at one method and path, a path names a parameter its input lacks,
 * an operation that changes something is offered as a `GET`, the bot loop is
 * said to be covered by an operation it isn't offered directly, or a tool
 * that manages a project outside member bounds runs without the asker's
 * approval.
 */

import type { Schema } from "effect";
import type { OperationContract } from "./operation.ts";

/** The HTTP methods an operation can be offered with. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Where the HTTP API offers an operation: at `method` and `path`, where each
 * `:name` in the path is a field of its input. Its other fields are the query
 * of a `GET` or `DELETE`, and the JSON body otherwise. It answers with its
 * output, as `200`, or `204` when it returns nothing, unless `status` says
 * otherwise.
 */
export interface HttpOffer {
	readonly kind: "offered";
	readonly method: HttpMethod;
	readonly path: `/${string}`;
	readonly status?: 201 | 202;
}

/**
 * The HTTP API's decision: offer the operation at a method and path; serve it
 * at an endpoint of its own, written by hand, because a request for it can't
 * be decoded into its input or answered with its output like the others; or
 * hold it back. Both of the last say why.
 */
export type HttpDecision =
	| HttpOffer
	| { readonly kind: "ownEndpoint"; readonly reason: string }
	| { readonly kind: "heldBack"; readonly reason: string };

/**
 * When a bot's call waits for an approver before it runs. A personal bot's
 * call to an operation that changes something always waits, and
 * so does every call in its runs that a webhook or GitHub event started,
 * whatever this says.
 *
 * - `never`: it runs at once.
 * - `always`: it waits for an approver. `turn`: by the turn's rule, its
 *   asker, or for a personal bot's call its creator, or for a run's call
 *   admins and the managers of its bot. `computerManagers`: a request to
 *   change a computer, such as a host request, which those who may manage its
 *   project decide.
 * - `outsideRunsOrMemberBounds`: the turn's approvers decide in runs started by
 *   webhooks or GitHub and in turns with member bounds.
 * - `outsideRuns`: the run's approvers decide in runs started by webhooks or GitHub.
 * - `byToolAccess`: a connector's tool, which runs, waits or is refused by its
 *   tool access, set as data.
 */
export type Approval =
	| { readonly kind: "never" }
	| { readonly kind: "always"; readonly approvers: "turn" | "computerManagers" }
	| { readonly kind: "outsideRunsOrMemberBounds" }
	| { readonly kind: "outsideRuns" }
	| { readonly kind: "byToolAccess" };

/** Waiting for the turn's approver: for a turn with an asker, the asker's own say. */
type AskersApproval = { readonly kind: "always"; readonly approvers: "turn" };

/**
 * In which turns' bounds the bot loop offers a tool.
 *
 * - `everywhere`: every turn and run. Asking for a host, and everything that
 *   manages nothing.
 * - `chatBounds`: every turn with an asker, never a run. Ways of managing a
 *   project other than those below, such as making an automation.
 * - `ownChats`: only in the bot's own chats. Its own interview-written
 *   settings and its own automations.
 * - `memberBounds`: only in member bounds, where each change asks the member.
 *   Managing the workspace or a bot, and changing who reaches what, tool
 *   access, computer use or allowed hosts.
 */
export type OfferedIn = "everywhere" | "chatBounds" | "ownChats" | "memberBounds";

/**
 * The bot loop's decision: offer the operation as a tool, in some bounds; hold
 * it back and say why; name the operation whose tool already does the same; or
 * mark it as called by the loop itself, offered to no model, as loading a turn
 * and recording its steps are.
 *
 * A tool offered in `chatBounds` or `ownChats` manages a project for the
 * asker, so it always waits for the asker's approval.
 */
export type BotLoopDecision =
	| {
			readonly kind: "offered";
			readonly tool: string;
			readonly offeredIn: "everywhere" | "memberBounds";
			readonly approval: Approval;
	  }
	| {
			readonly kind: "offered";
			readonly tool: string;
			readonly offeredIn: "chatBounds" | "ownChats";
			readonly approval: AskersApproval;
	  }
	| { readonly kind: "heldBack"; readonly reason: string }
	| { readonly kind: "coveredBy"; readonly operation: string; readonly reason: string }
	| { readonly kind: "calledByLoop" };

/** The segments of an HTTP path, between its slashes. */
type Segments<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
	? Segment | Segments<Rest>
	: Path;

/** The names of the `:name` parameters in an HTTP path, such as `chatId` in `/chats/:chatId/name`. */
export type PathParameters<Path extends string> =
	Segments<Path> extends infer Segment ? (Segment extends `:${infer Name}` ? Name : never) : never;

/** Characters the router reads as more than a plain segment or a parameter's name. */
type RouteSyntax = ":" | "*" | "?" | "(" | ")" | "+" | "." | "{" | "}" | " " | "#";

/**
 * Whether `Path` is in the one grammar offered paths use: segments after a
 * leading slash, none empty, each either plain or `:` and a name, with
 * nothing the router reads as more. The endpoint's parameters are then
 * exactly its `:` segments, however they are read.
 */
type PlainPath<Path extends string> = Path extends `/${infer Rest}`
	? Segments<Rest> extends infer Segment extends string
		? true extends (
				Segment extends ""
					? true
					: Segment extends `:${infer Name}`
						? Name extends "" | `${string}${RouteSyntax | "-"}${string}`
							? true
							: false
						: Segment extends `${string}${RouteSyntax}${string}`
							? true
							: false
			)
			? false
			: true
		: false
	: false;

type Whitespace = " " | "\n" | "\t";
type Trimmed<Text extends string> = Text extends `${Whitespace}${infer Rest}`
	? Trimmed<Rest>
	: Text extends `${infer Rest}${Whitespace}`
		? Trimmed<Rest>
		: Text;

/** Whether `Decision` has a reason that isn't written out: typed as `string`, or blank. */
type ReasonUnwritten<Decision> = Decision extends { readonly reason: infer Reason extends string }
	? string extends Reason
		? true
		: Trimmed<Reason> extends ""
			? true
			: false
	: false;

type WithUnwrittenReasons<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? true extends
				| ReasonUnwritten<Contracts[Name]["http"]>
				| ReasonUnwritten<Contracts[Name]["botLoop"]>
			? Name
			: never
		: never;
}[keyof Contracts];

type CoveringOperation<Decision> = Decision extends {
	readonly kind: "coveredBy";
	readonly operation: infer Operation;
}
	? Operation
	: never;

/** Operations the bot loop says are covered by one it isn't offered directly, or by themselves. */
type WithBadCover<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? CoveringOperation<Contracts[Name]["botLoop"]> extends infer Covering
			? [Covering] extends [never]
				? never
				: Covering extends Name
					? Name
					: Covering extends keyof Contracts
						? Contracts[Covering] extends { readonly botLoop: { readonly kind: "offered" } }
							? never
							: Name
						: Name
			: never
		: never;
}[keyof Contracts];

type RouteSegment<Segment extends string> = Segment extends `:${string}` ? ":" : Lowercase<Segment>;

/** RoutePattern mirrors the HTTP router's matching of static and named path segments. */
export type RoutePattern<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
	? Segment extends ""
		? RoutePattern<Rest>
		: `/${RouteSegment<Segment>}${RoutePattern<Rest>}`
	: Path extends ""
		? ""
		: `/${RouteSegment<Path>}`;

/** Where `Decision` offers its operation, as `<method> <path>`, matched as the router matches it. */
export type OfferedRoute<Decision> = Decision extends {
	readonly kind: "offered";
	readonly method: infer Method extends string;
	readonly path: infer Path extends string;
}
	? `${Method} ${RoutePattern<Path>}`
	: never;

type RoutesOfOthers<Contracts, Name extends keyof Contracts> = {
	[Other in Exclude<keyof Contracts, Name>]: Contracts[Other] extends OperationContract.Contract
		? OfferedRoute<Contracts[Other]["http"]>
		: never;
}[Exclude<keyof Contracts, Name>];

type WithSharedRoute<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? [OfferedRoute<Contracts[Name]["http"]>] extends [never]
			? never
			: OfferedRoute<Contracts[Name]["http"]> extends RoutesOfOthers<Contracts, Name>
				? Name
				: never
		: never;
}[keyof Contracts];

/**
 * Operations offered over HTTP whose path is outside the grammar, whose
 * input isn't a struct, or whose path names a parameter that isn't a field
 * of it.
 */
type WithUnfitPath<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? Contracts[Name]["http"] extends {
				readonly kind: "offered";
				readonly path: infer Path extends string;
			}
			? PlainPath<Path> extends false
				? Name
				: Contracts[Name]["input"] extends Schema.Struct<infer Fields>
					? [Exclude<PathParameters<Path>, keyof Fields>] extends [never]
						? never
						: Name
					: Name
			: never
		: never;
}[keyof Contracts];

/**
 * Operations that may change something but are offered as a `GET`. A `GET`
 * is a safe method, which the server lets through without checking a
 * cookie's request came from a trusted origin, so another site could make
 * a member's browser call it.
 */
type WithChangingGet<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends OperationContract.Contract
		? true extends Contracts[Name]["changes"]
			? Contracts[Name]["http"] extends { readonly kind: "offered"; readonly method: "GET" }
				? Name
				: never
			: never
		: never;
}[keyof Contracts];

/**
 * Nothing when `Contracts` is sound. Otherwise, for each contract at fault, a
 * property named with what is wrong, so the compiler prints the sentence
 * beside the operation; and one naming the operations that share a route.
 * TypeScript has no custom errors.
 */
type ExposureCheck<Contracts> = {
	readonly [Name in WithUnwrittenReasons<Contracts>]: {
		readonly "a decision that holds back an operation, serves it at its own endpoint or covers it needs its reason written out here, not blank or typed as string": Name;
	};
} & {
	readonly [Name in WithBadCover<Contracts>]: {
		readonly "covered by an operation the bot loop must offer directly: not this one, and not one held back or covered": Name;
	};
} & {
	readonly [Name in WithChangingGet<Contracts>]: {
		readonly "changes something, so it can't be offered as a GET, which skips the check that a cookie's request came from a trusted origin: offer it with POST, PUT, PATCH or DELETE": Name;
	};
} & {
	readonly [Name in WithUnfitPath<Contracts>]: {
		readonly "offered over HTTP: its path must be plain segments and `:name` parameters, and its input a struct with a field for each parameter": Name;
	};
} & ([WithSharedRoute<Contracts>] extends [never]
		? unknown
		: {
				readonly "one operation per method and path: these operations are offered at the same one": WithSharedRoute<Contracts>;
			});

/**
 * Checks every operation's contract against the others and returns them:
 * `checkExposure({ ...chatsContracts, … })`. Each contract must be filed under
 * its own name.
 */
export const checkExposure = <
	const Contracts extends {
		readonly [Name in keyof Contracts]: OperationContract.Contract<Name & string>;
	},
>(
	contracts: Contracts & ExposureCheck<Contracts>,
): Contracts => contracts;

/** Fails to compile unless `Check` is `true`: how a type-level check is applied to the API as written. */
export const requireTrue = <_Check extends true>(): void => {};

/** The operations among `Contracts` that the HTTP API offers at a method and path. */
export type HttpOperationName<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends { readonly http: { readonly kind: "offered" } }
		? Name
		: never;
}[keyof Contracts] &
	string;

/** The operations among `Contracts` that the HTTP API serves at endpoints of their own. */
export type OwnEndpointOperationName<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends {
		readonly http: { readonly kind: "ownEndpoint" };
	}
		? Name
		: never;
}[keyof Contracts] &
	string;

/** The operations among `Contracts` that the bot loop offers directly, as tools. */
export type BotLoopOperationName<Contracts> = {
	[Name in keyof Contracts]: Contracts[Name] extends {
		readonly botLoop: { readonly kind: "offered" };
	}
		? Name
		: never;
}[keyof Contracts] &
	string;

/**
 * Each operation the bot loop offers as a tool, with the tool's name, the
 * bounds it is offered in and its approval, in tool name order: a stable order
 * keeps the model's prompt cache. An operation covered by another, or called by
 * the loop, offers no tool of its own.
 */
export const botLoopTools = <
	Contracts extends { readonly [name: string]: { readonly botLoop: BotLoopDecision } },
>(
	contracts: Contracts,
): ReadonlyArray<{
	readonly operation: BotLoopOperationName<Contracts>;
	readonly tool: string;
	readonly offeredIn: OfferedIn;
	readonly approval: Approval;
}> =>
	Object.entries(contracts)
		.flatMap(([operation, { botLoop }]) =>
			botLoop.kind === "offered"
				? [
						{
							operation: operation as BotLoopOperationName<Contracts>,
							tool: botLoop.tool,
							offeredIn: botLoop.offeredIn,
							approval: botLoop.approval,
						},
					]
				: [],
		)
		.sort((a, b) => a.tool.localeCompare(b.tool));
