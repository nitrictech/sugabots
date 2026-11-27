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
	type PathParameters,
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

/** The names of the input's fields that `Name`'s path names as parameters. */
type ParameterNames<Name extends Offered> = PathParameters<OfferOf<Name>["path"]> &
	keyof FieldsOf<Name>;

/** The input's fields that go in the path of the endpoint of `Name`. */
type ParameterFields<Name extends Offered> = Pick<FieldsOf<Name>, ParameterNames<Name>>;

/** The input's other fields, which go in the query or the body. */
type OtherFields<Name extends Offered> = Omit<FieldsOf<Name>, ParameterNames<Name>>;

/** Whether the endpoint of `Name` takes no body, so its other fields go in the query. */
type Bodiless<Name extends Offered> = OfferOf<Name>["method"] extends BodilessMethod ? true : false;

type ParamsOf<Name extends Offered> = [keyof ParameterFields<Name>] extends [never]
	? never
	: Schema.toCodecStringTree<Schema.Struct<ParameterFields<Name>>>;

type QueryOf<Name extends Offered> = [keyof OtherFields<Name>] extends [never]
	? never
	: Bodiless<Name> extends true
		? Schema.toCodecStringTree<Schema.Struct<OtherFields<Name>>>
		: never;

type PayloadOf<Name extends Offered> = [keyof OtherFields<Name>] extends [never]
	? never
	: Bodiless<Name> extends true
		? never
		: Schema.toCodecJson<Schema.Struct<OtherFields<Name>>>;

type ErrorsOf<Name extends Offered> =
	FailureForError<
		OperationContract.Failure<Contract<Name>>["_tag"] & ServedErrorTag
	> extends infer Failure
		? Failure extends Schema.Top
			? Schema.toCodecJson<Failure>
			: never
		: never;

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
 * as the router reads them, and as `PathParameters` reads them for the
 * endpoints' types. `checkExposure` keeps every name a plain identifier, so
 * no segment holds anything after its name.
 */
const pathParameters = (path: string): ReadonlyArray<string> =>
	path
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map((segment) => segment.slice(1));

/** The methods whose requests carry no body, so an input's other fields go in the query. */
type BodilessMethod = "GET" | "DELETE";
const bodilessMethods: ReadonlySet<HttpMethod> = new Set<BodilessMethod>(["GET", "DELETE"]);

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
 *
 * Built in a loop over the contracts, which TypeScript can't follow to the
 * union of distinct groups `OperationGroup` describes, so the result is cast
 * to it. Both read each endpoint's parts by the same rule: the path's `:name`
 * segments are its parameters, and the other fields its query or body by
 * method. `http-api.test.ts` records what the loop builds.
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
