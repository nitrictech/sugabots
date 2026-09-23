import type { Database } from "@sugabots/core/database/database";
import { query } from "@sugabots/core/database/database";
import { user, workspaceInvite } from "@sugabots/core/database/schema";
import { APIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import { Effect } from "effect";

const signUpsOpen = (allowOpenSignUp: boolean): Effect.Effect<boolean, never, Database> =>
	allowOpenSignUp
		? Effect.succeed(true)
		: // Reads rather than locks: two sign-ups in the same instant against an
			// empty database would both be let in, and the window closes as soon as
			// anybody has an account.
			Effect.map(
				query((db) => db.select({ id: user.id }).from(user).limit(1)),
				([existing]) => existing === undefined,
			);

/**
 * Fails with `APIError` unless this address may create an account.
 *
 * A closed installation with nobody in it could never be opened, so an empty
 * user table admits one person: the first to arrive owns the place. Everybody
 * after that needs an invitation.
 */
export const admitSignUp = (
	allowOpenSignUp: boolean,
	email: string,
): Effect.Effect<void, APIError, Database> =>
	Effect.gen(function* () {
		if (yield* signUpsOpen(allowOpenSignUp)) return;
		if (yield* hasPendingInvitation(email)) return;
		return yield* Effect.fail(
			new APIError("FORBIDDEN", {
				code: "SIGN_UP_CLOSED",
				message: "Signups are invite only. Ask a member to invite you.",
			}),
		);
	});

const hasPendingInvitation = (email: string): Effect.Effect<boolean, never, Database> =>
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
