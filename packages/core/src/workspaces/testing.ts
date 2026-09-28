import { type Context, Effect, type Layer } from "effect";
import { CurrentActor } from "../authorization/current-actor.ts";
import {
	type Promised,
	promising,
	runOnPostgres,
	type TestInfrastructure,
} from "../database/testing.ts";

/**
 * `service` with its methods returning promises, each run against the test
 * database as the person `userId`.
 */
export const onPostgresAs = (userId: string) =>
	promising<CurrentActor.Service | TestInfrastructure>((effect) =>
		runOnPostgres(
			effect.pipe(CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(userId))),
		),
	);

/**
 * `service`, built by `layer` over the test infrastructure, with its methods
 * returning promises and called as the person the returned function is given.
 * Call it from `beforeAll`, so a file whose cases skip without a database
 * never connects.
 */
export async function servedOnPostgresAs<
	Identifier,
	Shape extends Record<
		keyof Shape,
		(...args: never[]) => Effect.Effect<unknown, unknown, CurrentActor.Service>
	>,
>(
	service: Context.Key<Identifier, Shape>,
	layer: Layer.Layer<Identifier, never, TestInfrastructure>,
): Promise<(userId: string) => Promised<Shape>> {
	const served = await runOnPostgres(Effect.provide(service, layer));
	return (userId) => onPostgresAs(userId)(served);
}
