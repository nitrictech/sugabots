export * as Activities from "./activities.ts";

import type { Effect, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";

/**
 * A workflow's activities, defined once as functions of the workflow payload
 * and a key.
 *
 * The body asks for an activity by name and key (`model` with key `3` is the
 * activity `model/3`). An engine that runs activities somewhere other than the
 * body, as Temporal runs them on a worker, rebuilds the same activity from its
 * full name and the workflow payload with `resolve`. That is only sound because
 * an activity's behaviour depends on nothing else: never capture values from
 * the body in `execute`.
 */
export interface Definition<Payload> {
	readonly success?: Schema.Constraint;
	readonly error?: Schema.Constraint;
	readonly execute: (payload: Payload, key: string) => Effect.Effect<unknown, unknown, unknown>;
}

type SuccessOf<D> = D extends { readonly success: infer S extends Schema.Constraint }
	? S
	: typeof Schema.Void;
type ErrorOf<D> = D extends { readonly error: infer E extends Schema.Constraint }
	? E
	: typeof Schema.Never;
type RequirementsOf<D> = D extends {
	readonly execute: (...args: never[]) => Effect.Effect<unknown, unknown, infer R>;
}
	? R
	: never;

export interface Set<Payload, Definitions extends Record<string, Definition<Payload>>> {
	/** The activity `name`, or `name/key`, for this execution's payload. */
	readonly activity: <Name extends keyof Definitions & string>(
		name: Name,
		payload: Payload,
		key?: string | number,
	) => Activity.Activity<
		SuccessOf<Definitions[Name]>,
		ErrorOf<Definitions[Name]>,
		RequirementsOf<Definitions[Name]>
	>;
	/** The activity with this full name, rebuilt from the workflow payload; `undefined` if none. */
	readonly resolve: (
		fullName: string,
		payload: Payload,
	) => Activity.Activity<Schema.Constraint, Schema.Constraint, unknown> | undefined;
}

export const make =
	<Payload>() =>
	<const Definitions extends Record<string, Definition<Payload>>>(
		definitions: Definitions,
	): Set<Payload, Definitions> => {
		const build = (name: string, payload: Payload, key: string) => {
			const definition = definitions[name];
			if (definition === undefined) return undefined;
			return Activity.make({
				name: key === "" ? name : `${name}/${key}`,
				...(definition.success ? { success: definition.success } : {}),
				...(definition.error ? { error: definition.error } : {}),
				execute: definition.execute(payload, key),
			});
		};
		return {
			// The per-name result types are carried by the `Set` signature.
			activity: (name, payload, key) =>
				build(name, payload, key === undefined ? "" : String(key)) as never,
			resolve: (fullName, payload) => {
				const slash = fullName.indexOf("/");
				return slash === -1
					? build(fullName, payload, "")
					: build(fullName.slice(0, slash), payload, fullName.slice(slash + 1));
			},
		};
	};
