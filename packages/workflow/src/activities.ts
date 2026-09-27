export * as Activities from "./activities.ts";

import { type Context, Effect, Option, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";

/**
 * A workflow's activities, each one a method of a service, called with the
 * workflow's payload and, when the activity declares one, a typed input.
 *
 * An activity's name is its method's name, followed by the JSON encoding of its
 * input when it takes one (`segment` with input `3` is the activity
 * `segment/3`), so every distinct input is a separate activity that runs once.
 * An engine that runs activities somewhere other than the body, such as on a
 * separate worker, rebuilds the same activity from its full name and the
 * workflow payload with `resolve`. That is sound because an activity's
 * behaviour depends only on the service, the payload and the input.
 */
export interface Definition {
	/** The activity's input. Without one, the activity has a single name and runs once per execution. */
	readonly input?: Schema.ConstraintCodec<unknown, unknown, never, never>;
	readonly success?: Schema.Constraint;
	readonly error?: Schema.Constraint;
}

type InputArgs<D> = D extends { readonly input: infer I extends Schema.Constraint }
	? [input: I["Type"]]
	: [];
type SuccessOf<D> = D extends { readonly success: infer S extends Schema.Constraint }
	? S
	: typeof Schema.Void;
type ErrorOf<D> = D extends { readonly error: infer E extends Schema.Constraint }
	? E
	: typeof Schema.Never;
/** The services a method's effect needs. */
export type ServicesOf<Method> = Method extends (
	...args: never[]
) => Effect.Effect<unknown, unknown, infer R>
	? R
	: never;

/** The method an activity defined by `D` calls: with the payload, then the input if `D` declares one. */
type MethodFor<Payload, D> = (
	payload: Payload,
	...input: InputArgs<D>
) => Effect.Effect<SuccessOf<D>["Type"], ErrorOf<D>["Type"], unknown>;

/** Each definition, or, where the service's method does not fit it, the method it needs. */
type MatchingMethods<Payload, Shape, Definitions> = {
	readonly [Name in keyof Definitions]: Name extends keyof Shape
		? Shape[Name] extends MethodFor<Payload, Definitions[Name]>
			? Definitions[Name]
			: MethodFor<Payload, Definitions[Name]>
		: never;
};

/** The names of the activities in `Definitions` that take no input, return nothing and cannot fail. */
export type RecordingName<Shape, Definitions> = {
	[Name in keyof Definitions & keyof Shape & string]: Definitions[Name] extends
		| { readonly input: unknown }
		| { readonly success: unknown }
		| { readonly error: unknown }
		? never
		: Name;
}[keyof Definitions & keyof Shape & string];

export interface Set<Payload, Id, Shape, Definitions> {
	/** The activity `name` for this execution's payload, and its input if it takes one. */
	readonly activity: <Name extends keyof Definitions & keyof Shape & string>(
		name: Name,
		payload: Payload,
		...input: InputArgs<Definitions[Name]>
	) => Activity.Activity<
		SuccessOf<Definitions[Name]>,
		ErrorOf<Definitions[Name]>,
		Id | ServicesOf<Shape[Name]>
	>;
	/** The activity with this full name, rebuilt from the workflow payload; `undefined` if none. */
	readonly resolve: (
		fullName: string,
		payload: Payload,
	) => Activity.Activity<Schema.Constraint, Schema.Constraint, unknown> | undefined;
}

/**
 * Activities that call the methods of `service` with the same names. Each
 * definition gives the schemas of one method's input and result, and the
 * method must accept that input and return that result.
 */
export const fromService =
	<Payload>() =>
	<Id, Shape, const Definitions extends { readonly [Name in keyof Shape]?: Definition }>(
		service: Context.Key<Id, Shape>,
		definitions: Definitions & MatchingMethods<Payload, Shape, Definitions>,
	): Set<Payload, Id, Shape, Definitions> => {
		const definitionNamed = (name: string): Definition | undefined =>
			Object.hasOwn(definitions, name)
				? (definitions as Record<string, Definition>)[name]
				: undefined;
		const build = (name: string, definition: Definition, payload: Payload, input: unknown) =>
			Activity.make({
				name: definition.input
					? `${name}/${Schema.encodeSync(inJson(definition.input))(input)}`
					: name,
				...(definition.success ? { success: definition.success } : {}),
				...(definition.error ? { error: definition.error } : {}),
				execute: Effect.flatMap(service, (methods) => {
					const method = (methods as Record<string, UntypedMethod<Payload>>)[name];
					if (!method) return Effect.die(new Error(`The service has no method "${name}"`));
					return definition.input ? method(payload, input) : method(payload);
				}),
			});
		return {
			// The per-name types are carried by the `Set` signature.
			activity: (name: string, payload: Payload, input?: unknown) =>
				build(name, definitionNamed(name) ?? {}, payload, input) as never,
			resolve: (fullName, payload) => {
				const slash = fullName.indexOf("/");
				const name = slash === -1 ? fullName : fullName.slice(0, slash);
				const definition = definitionNamed(name);
				if (!definition) return undefined;
				if (!definition.input) {
					return slash === -1 ? build(name, definition, payload, undefined) : undefined;
				}
				if (slash === -1) return undefined;
				return Option.getOrUndefined(
					Option.map(
						Schema.decodeOption(inJson(definition.input))(fullName.slice(slash + 1)),
						(input) => build(name, definition, payload, input),
					),
				);
			},
		};
	};

type UntypedMethod<Payload> = (
	payload: Payload,
	input?: unknown,
) => Effect.Effect<unknown, unknown, unknown>;

/** An input's codec to and from the JSON text in an activity's name. */
const inJson = (input: Schema.ConstraintCodec<unknown, unknown, never, never>) =>
	Schema.fromJsonString(Schema.toCodecJson(input));
