/**
 * The exposure manifest: for every operation, an explicit decision for the
 * HTTP API and one for the bot loop. Offering an operation grants nothing by
 * itself; it makes the operation reachable through that entrypoint, where it
 * proves access like any other caller.
 *
 * `defineManifest` fails to compile when an operation has no entry, a reason
 * isn't written out, an endpoint is misspelt or named twice, or the bot loop
 * is said to be covered by an operation it isn't offered directly.
 */

import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import type { Api } from "../http/api.ts";
import type { OperationContract } from "./operation.ts";

type ApiGroups = typeof Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;

type EndpointNamesOf<Group> = Group extends HttpApiGroup.Constraint
	? `${Group["identifier"]}.${HttpApiEndpoint.Identifier<HttpApiGroup.Endpoints<Group>>}`
	: never;

/** An endpoint of `Api`, as `<group>.<endpoint>`, such as `chats.setResolved`. */
export type EndpointName = EndpointNamesOf<ApiGroups>;

/** The HTTP API's decision: offer the operation at one endpoint, or hold it back and say why. */
export type HttpDecision =
	| { readonly kind: "offered"; readonly endpoint: EndpointName }
	| { readonly kind: "heldBack"; readonly reason: string };

/**
 * Who must allow a bot's call before it runs.
 *
 * - `never`: it runs at once.
 * - `always`: it waits for someone allowed to decide: those who decide
 *   approvals in the chat, or for changes to a computer, those who manage its
 *   project.
 * - `byToolAccess`: a connector's tool, which runs, waits or is refused by its
 *   tool access, set as data.
 */
export type Approval =
	| { readonly kind: "never" }
	| { readonly kind: "always"; readonly approvers: "chat" | "computerManagers" }
	| { readonly kind: "byToolAccess" };

/**
 * The bot loop's decision: offer the operation as a tool, hold it back and say
 * why, or name the operation whose tool already does the same.
 */
export type BotLoopDecision =
	| { readonly kind: "offered"; readonly tool: string; readonly approval: Approval }
	| { readonly kind: "heldBack"; readonly reason: string }
	| { readonly kind: "coveredBy"; readonly operation: string; readonly reason: string };

export interface Decisions {
	readonly http: HttpDecision;
	readonly botLoop: BotLoopDecision;
}

/** One domain's entries: a decision for each of its operations. */
export type DomainExposure<Contracts> = { readonly [Name in keyof Contracts]: Decisions };

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

type WithUnwrittenReasons<Manifest> = {
	[Name in keyof Manifest]: Manifest[Name] extends Decisions
		? true extends
				| ReasonUnwritten<Manifest[Name]["http"]>
				| ReasonUnwritten<Manifest[Name]["botLoop"]>
			? Name
			: never
		: never;
}[keyof Manifest];

type CoveringOperation<Decision> = Decision extends {
	readonly kind: "coveredBy";
	readonly operation: infer Operation;
}
	? Operation
	: never;

/** Operations the bot loop says are covered by one it isn't offered directly, or by themselves. */
type WithBadCover<Manifest> = {
	[Name in keyof Manifest]: Manifest[Name] extends Decisions
		? CoveringOperation<Manifest[Name]["botLoop"]> extends infer Covering
			? [Covering] extends [never]
				? never
				: Covering extends Name
					? Name
					: Covering extends keyof Manifest
						? Manifest[Covering] extends { readonly botLoop: { readonly kind: "offered" } }
							? never
							: Name
						: Name
			: never
		: never;
}[keyof Manifest];

type OfferedEndpoint<Decision> = Decision extends {
	readonly kind: "offered";
	readonly endpoint: infer Endpoint;
}
	? Endpoint
	: never;

type EndpointsOfOthers<Manifest, Name extends keyof Manifest> = {
	[Other in Exclude<keyof Manifest, Name>]: Manifest[Other] extends Decisions
		? OfferedEndpoint<Manifest[Other]["http"]>
		: never;
}[Exclude<keyof Manifest, Name>];

type WithSharedEndpoint<Manifest> = {
	[Name in keyof Manifest]: Manifest[Name] extends Decisions
		? [OfferedEndpoint<Manifest[Name]["http"]>] extends [never]
			? never
			: OfferedEndpoint<Manifest[Name]["http"]> extends EndpointsOfOthers<Manifest, Name>
				? Name
				: never
		: never;
}[keyof Manifest];

/**
 * Nothing when `Manifest` is sound. Otherwise, the properties it lacks: an
 * entry for each registered operation; for each entry at fault, a property
 * named with what is wrong, so the compiler prints the sentence beside the
 * operation; and one naming the operations that share an endpoint. TypeScript
 * has no custom errors.
 *
 * Checks nothing once `Manifest` has fallen back to its constraint after
 * another error, so that error is the only one shown.
 */
type ManifestCheck<Contracts, Manifest> = string extends keyof Manifest
	? unknown
	: { readonly [Name in Exclude<keyof Contracts, keyof Manifest>]: Decisions } & {
			readonly [Name in Exclude<keyof Manifest, keyof Contracts>]: {
				readonly "no operation is registered under this name": Name;
			};
		} & {
			readonly [Name in WithUnwrittenReasons<Manifest>]: {
				readonly "a decision that holds back or covers an operation needs its reason written out here, not blank or typed as string": Name;
			};
		} & {
			readonly [Name in WithBadCover<Manifest>]: {
				readonly "covered by an operation the bot loop must offer directly: not this one, and not one held back or covered": Name;
			};
		} & ([WithSharedEndpoint<Manifest>] extends [never]
				? unknown
				: {
						readonly "one operation per endpoint: these operations name the same endpoint": WithSharedEndpoint<Manifest>;
					});

/**
 * Checks the whole manifest against the registered operations and returns it:
 * `defineManifest<typeof operationContracts>()({ ...chatsExposure, … })`.
 * Each contract must be filed under its own name.
 */
export const defineManifest =
	<
		Contracts extends {
			readonly [Name in keyof Contracts]: OperationContract.Contract<Name & string>;
		},
	>() =>
	<const Manifest extends { readonly [name: string]: Decisions }>(
		manifest: Manifest & ManifestCheck<Contracts, Manifest>,
	): Manifest =>
		manifest;

/** The operations `Manifest` offers through the HTTP API. */
export type HttpOperationName<Manifest> = {
	[Name in keyof Manifest]: Manifest[Name] extends { readonly http: { readonly kind: "offered" } }
		? Name
		: never;
}[keyof Manifest] &
	string;

/** The operations `Manifest` offers the bot loop directly, as tools. */
export type BotLoopOperationName<Manifest> = {
	[Name in keyof Manifest]: Manifest[Name] extends {
		readonly botLoop: { readonly kind: "offered" };
	}
		? Name
		: never;
}[keyof Manifest] &
	string;

/** Each operation the HTTP API offers, with its endpoint, in name order. */
export const httpOperations = <Manifest extends { readonly [name: string]: Decisions }>(
	manifest: Manifest,
): ReadonlyArray<{
	readonly operation: HttpOperationName<Manifest>;
	readonly endpoint: EndpointName;
}> =>
	Object.entries(manifest)
		.flatMap(([operation, { http }]) =>
			http.kind === "offered"
				? [{ operation: operation as HttpOperationName<Manifest>, endpoint: http.endpoint }]
				: [],
		)
		.sort((a, b) => a.operation.localeCompare(b.operation));

/**
 * Each operation the bot loop offers as a tool, with the tool's name and its
 * approval, in tool name order: a stable order keeps the model's prompt cache.
 * An operation covered by another offers no tool of its own.
 */
export const botLoopTools = <Manifest extends { readonly [name: string]: Decisions }>(
	manifest: Manifest,
): ReadonlyArray<{
	readonly operation: BotLoopOperationName<Manifest>;
	readonly tool: string;
	readonly approval: Approval;
}> =>
	Object.entries(manifest)
		.flatMap(([operation, { botLoop }]) =>
			botLoop.kind === "offered"
				? [
						{
							operation: operation as BotLoopOperationName<Manifest>,
							tool: botLoop.tool,
							approval: botLoop.approval,
						},
					]
				: [],
		)
		.sort((a, b) => a.tool.localeCompare(b.tool));
