export * as Accounts from "./accounts.ts";

import { and, eq, gt } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer } from "effect";
import { type Database, layer as databaseLayer, query } from "../database/database.ts";
import { user, workspaceInvite } from "../database/schema.ts";

/** Who may have an account here. */
export interface Interface {
	/** Fails with `SignUpClosed` unless `email` may create an account, whichever sign-up method it uses. */
	readonly admit: (email: string) => Effect.Effect<void, SignUpClosed>;
	/** Whether an account must prove its address before it gets a session or joins a workspace. */
	readonly requireEmailVerification: boolean;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Accounts") {}

/** Sign-up is invite-only unless `ALLOW_OPEN_SIGNUP` is set. Verification is off by default, so a self-hoster needs no mail service to sign in. */
export const make = Effect.gen(function* () {
	const database = yield* Effect.context<Database>();
	const allowOpenSignUp = yield* Config.Boolean("ALLOW_OPEN_SIGNUP").pipe(
		Config.withDefault(false),
	);
	const requireEmailVerification = yield* Config.Boolean("REQUIRE_EMAIL_VERIFICATION").pipe(
		Config.withDefault(false),
	);
	return Service.of({
		admit: (email) =>
			Effect.gen(function* () {
				if (allowOpenSignUp || (yield* isEmpty)) return;
				if (yield* hasPendingInvitation(email)) return;
				return yield* new SignUpClosed();
			}).pipe(Effect.provide(database)),
		requireEmailVerification,
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(databaseLayer));

export class SignUpClosed extends Data.TaggedError("SignUpClosed") {
	override get message() {
		return "Signups are invite only. Ask a member to invite you.";
	}
}

/**
 * An empty installation admits its first account, or it could never be opened.
 * Unlocked: two simultaneous first sign-ups would both get in, which is harmless.
 */
const isEmpty = Effect.map(
	query((db) => db.select({ id: user.id }).from(user).limit(1)),
	([existing]) => existing === undefined,
);

const hasPendingInvitation = (email: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: workspaceInvite.id })
				.from(workspaceInvite)
				.where(
					and(
						eq(workspaceInvite.email, email),
						eq(workspaceInvite.status, "pending"),
						gt(workspaceInvite.expiresAt, new Date()),
					),
				)
				.limit(1),
		),
		([pending]) => pending !== undefined,
	);
