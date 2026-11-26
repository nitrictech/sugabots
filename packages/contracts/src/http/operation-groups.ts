/**
 * The HTTP API's endpoints for the operations it offers, derived from their
 * contracts, so an operation is written once and its endpoint follows it.
 *
 * Each domain's operations are one group, named for the domain: `chats.send`
 * is the endpoint `send` of the group `chats`, which the client calls as
 * `client.api.chats.send(…)`. An endpoint is at its contract's method and
 * path. Its path parameters are the input's fields named in the path; the
 * other fields are the query of a `GET` or `DELETE`, and the JSON body
 * otherwise. It answers with the operation's output, at the status the
 * contract gives, and fails with the failures `failureForError` answers the
 * operation's errors with. Every one needs a session.
 */

import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	type HttpMethod,
	type HttpOffer,
	type HttpOperationName,
	type OperationContract,
	type OperationContracts,
	operationContracts,
	requireTrue,
} from "../operations/index.ts";
import { type FailureForError, failureForError, type ServedErrorTag } from "./errors.ts";
import { Session } from "./middleware.ts";

/** An operation the HTTP API offers at a method and path. */
type Offered = HttpOperationName<OperationContracts>;

type Contract<Name extends Offered> = OperationContracts[Name];

/** The domain of an operation, such as `chats` for `chats.send`: the group it belongs to. */
type DomainOf<Name extends string> = Name extends `${infer Domain}.${string}` ? Domain : never;

/** The verb of an operation, such as `send` for `chats.send`: its endpoint's name in the group. */
type VerbOf<Name extends string> = Name extends `${string}.${infer Verb}` ? Verb : never;

type OfferOf<Name extends Offered> = Contract<Name>["http"] & HttpOffer;

type FieldsOf<Name extends Offered> =
	Contract<Name>["input"] extends Schema.Struct<infer Fields> ? Fields : never;

/**
 * The record of the public HTTP API, which `http-api.test.ts` writes from
 * the endpoints `endpointOf` builds. The types below read where each field
 * goes from it, rather than working it out a second time, so the endpoints
 * and their types are derived once, by `endpointOf`, and the test fails
 * while the record disagrees with it.
 */
type HttpApiRecord = typeof import("./http-api.json");

type RecordedOperations = HttpApiRecord["operations"];

/** The names of the fields the record puts at `Part` of the endpoint of `Name`. */
type RecordedAt<
	Name extends Offered,
	Part extends "params" | "query" | "body",
> = Name extends keyof RecordedOperations ? keyof RecordedOperations[Name][Part] : never;

/** The input's fields the record puts at `Part` of the endpoint of `Name`. */
type FieldsAt<Name extends Offered, Part extends "params" | "query" | "body"> = Pick<
	FieldsOf<Name>,
	RecordedAt<Name, Part> & keyof FieldsOf<Name>
>;

type ParamsOf<Name extends Offered> = [keyof FieldsAt<Name, "params">] extends [never]
	? never
	: Schema.toCodecStringTree<Schema.Struct<FieldsAt<Name, "params">>>;

type QueryOf<Name extends Offered> = [keyof FieldsAt<Name, "query">] extends [never]
	? never
	: Schema.toCodecStringTree<Schema.Struct<FieldsAt<Name, "query">>>;

type PayloadOf<Name extends Offered> = [keyof FieldsAt<Name, "body">] extends [never]
	? never
	: Schema.toCodecJson<Schema.Struct<FieldsAt<Name, "body">>>;

type ErrorsOf<Name extends Offered> =
	FailureForError<
		OperationContract.Failure<Contract<Name>>["_tag"] & ServedErrorTag
	> extends infer Failure
		? Failure extends Schema.Top
			? Schema.toCodecJson<Failure>
			: never
		: never;

/**
 * `true` when the record has every offered operation; otherwise the
 * operations it lacks, which a new operation is until the record is written
 * again with `bun run test --project contracts -u`.
 */
type EveryOperationRecorded = [Exclude<Offered, keyof RecordedOperations>] extends [never]
	? true
	: {
			readonly "operations missing from http-api.json, until `bun run test --project contracts -u` writes it again": Exclude<
				Offered,
				keyof RecordedOperations
			>;
		};

requireTrue<EveryOperationRecorded>();

/** The endpoint of the operation `Name`. */
type EndpointOf<Name extends Offered> = HttpApiEndpoint.HttpApiEndpoint<
	VerbOf<Name>,
	OfferOf<Name>["method"],
	OfferOf<Name>["path"],
	ParamsOf<Name>,
	QueryOf<Name>,
	PayloadOf<Name>,
	never,
	Schema.toCodecJson<Contract<Name>["output"]>,
	ErrorsOf<Name>
>;

/** The domains that have an operation the HTTP API offers. */
type OfferingDomain = DomainOf<Offered>;

/** The groups whose endpoints the client calls at its top level, as `client.api.workspaceAccess(…)`. */
const topLevelDomains = ["system"] as const;

type TopLevel<Domain extends string> = Domain extends (typeof topLevelDomains)[number]
	? true
	: false;

/** The group of the domain `Domain`'s offered operations, each behind a session. */
type GroupOf<Domain extends OfferingDomain> = HttpApiGroup.HttpApiGroup<
	Domain,
	HttpApiEndpoint.AddMiddleware<
		{ [Name in Offered]: DomainOf<Name> extends Domain ? EndpointOf<Name> : never }[Offered],
		Session
	>,
	TopLevel<Domain>
>;

/** One group per domain with an operation the HTTP API offers. */
export type OperationGroup = { [Domain in OfferingDomain]: GroupOf<Domain> }[OfferingDomain];

/**
 * The names of the parameters in `path`: its segments that start with `:`,
 * as the router reads them. `checkExposure` keeps every name a plain
 * identifier, so no segment holds anything after its name.
 */
const pathParameters = (path: string): ReadonlyArray<string> =>
	path
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map((segment) => segment.slice(1));

/** The methods whose requests carry no body, so an input's other fields go in the query. */
const bodilessMethods: ReadonlySet<HttpMethod> = new Set<HttpMethod>(["GET", "DELETE"]);

/** The endpoint of `contract`, which the HTTP API offers as `offer` says. */
function endpointOf(contract: OperationContract.Contract, offer: HttpOffer) {
	const verb = contract.name.slice(contract.name.indexOf(".") + 1);
	// `checkExposure` holds every offered operation's input to a struct.
	const { fields } = contract.input as Schema.Struct<Schema.Struct.Fields>;
	const parameterNames = new Set(pathParameters(offer.path));
	const fieldsWhere = (isParameter: boolean) =>
		Object.fromEntries(
			Object.entries(fields).filter(([field]) => parameterNames.has(field) === isParameter),
		);
	const parameters = fieldsWhere(true);
	const others = fieldsWhere(false);
	const hasOthers = Object.keys(others).length > 0;
	const bodiless = bodilessMethods.has(offer.method);
	const answersNothing = contract.output.ast._tag === "Void";
	const errors = [
		...new Set(
			contract.errors.map(
				(error) => failureForError[(error as unknown as { identifier: ServedErrorTag }).identifier],
			),
		),
	];
	return HttpApiEndpoint.make(offer.method)(verb, offer.path, {
		params: parameterNames.size > 0 ? parameters : undefined,
		query: bodiless && hasOthers ? others : undefined,
		payload: !bodiless && hasOthers ? Schema.Struct(others) : undefined,
		success: answersNothing
			? HttpApiSchema.Empty(offer.status ?? NO_CONTENT)
			: contract.output.pipe(HttpApiSchema.status(offer.status ?? OK)),
		error: errors,
	});
}

const OK = 200;
const NO_CONTENT = 204;

/**
 * The groups of the operations the HTTP API offers, one per domain, built
 * from their contracts. `Api` adds them beside the endpoints written by hand.
 */
export const operationGroups = (() => {
	const endpointsByDomain = new Map<string, Array<HttpApiEndpoint.Constraint>>();
	for (const contract of Object.values<OperationContract.Contract>(operationContracts)) {
		if (contract.http.kind !== "offered") continue;
		const domain = contract.name.slice(0, contract.name.indexOf("."));
		const endpoints = endpointsByDomain.get(domain) ?? [];
		endpoints.push(endpointOf(contract, contract.http));
		endpointsByDomain.set(domain, endpoints);
	}
	return [...endpointsByDomain].map(([domain, [first, ...rest]]) =>
		HttpApiGroup.make(domain, {
			topLevel: (topLevelDomains as ReadonlyArray<string>).includes(domain),
		})
			// Every domain in the map has at least one endpoint.
			.add(first as HttpApiEndpoint.Constraint, ...rest)
			.middleware(Session),
	);
})() as unknown as readonly [OperationGroup, ...Array<OperationGroup>];
