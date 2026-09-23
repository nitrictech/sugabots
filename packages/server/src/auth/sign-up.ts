import { user, workspaceInvite } from "@sugabots/core/database/schema";
import { APIError } from "better-auth/api";
import { and, eq, gt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

async function signUpsOpen(db: NodePgDatabase, allowOpenSignUp: boolean): Promise<boolean> {
	if (allowOpenSignUp) return true;
	// Reads rather than locks: two sign-ups in the same instant against an
	// empty database would both be let in, and the window closes as soon as
	// anybody has an account.
	const [existing] = await db.select({ id: user.id }).from(user).limit(1);
	return existing === undefined;
}

/**
 * Throws `APIError` unless this address may create an account.
 *
 * A closed installation with nobody in it could never be opened, so an empty
 * user table admits one person: the first to arrive owns the place. Everybody
 * after that needs an invitation.
 */
export async function admitSignUp(
	db: NodePgDatabase,
	allowOpenSignUp: boolean,
	email: string,
): Promise<void> {
	if (await signUpsOpen(db, allowOpenSignUp)) return;
	if (await hasPendingInvitation(db, email)) return;
	throw new APIError("FORBIDDEN", {
		code: "SIGN_UP_CLOSED",
		message: "Signups are invite only. Ask a member to invite you.",
	});
}

async function hasPendingInvitation(db: NodePgDatabase, email: string): Promise<boolean> {
	const [pending] = await db
		.select({ id: workspaceInvite.id })
		.from(workspaceInvite)
		.where(
			and(
				eq(workspaceInvite.email, email),
				eq(workspaceInvite.status, "pending"),
				gt(workspaceInvite.expiresAt, new Date()),
			),
		)
		.limit(1);
	return pending !== undefined;
}
