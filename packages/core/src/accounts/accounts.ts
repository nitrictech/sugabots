export * as Accounts from "./accounts.ts";

import { hkdfSync } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { Config, Context, Data, DateTime, Effect, Layer, Redacted } from "effect";
import { jwtVerify, SignJWT } from "jose";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Database, query } from "../database/database.ts";
import { user, workspaceInvite } from "../database/schema.ts";
import { Installation } from "../installation/installation.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";

/** Who may have an account here. */
export interface Interface {
	/**
	 * Fails unless `applicant` may create an account, whichever sign-up method
	 * it uses. An applicant let in by a referral link is told who sent it.
	 */
	readonly admit: (
		applicant: Applicant,
	) => Effect.Effect<Admission, SignUpClosed | ReferralLinkInvalid>;
	/** Whether an account must prove its address before it gets a session or joins a workspace. */
	readonly requireEmailVerification: boolean;
	/** The link the actor can send people to let them sign up, or `undefined` when sign-up is not by referral. */
	readonly referralLink: Effect.Effect<string | undefined, never, CurrentActor.Service>;
	/** Stops the actor's referral link working, and returns the one that replaces it. */
	readonly resetReferralLink: Effect.Effect<string, ReferralsOff, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Accounts") {}

/**
 * Sign-up follows `SIGNUP_MODE`, closed unless set. Verification is
 * off by default, so a self-hoster needs no mail service to sign in.
 */
export const make = Effect.gen(function* () {
	const database = yield* Database;
	const installation = yield* Installation.Service;
	const mode = yield* Config.Literals(SIGNUP_MODES, "SIGNUP_MODE").pipe(
		Config.withDefault("closed"),
	);
	const requireEmailVerification = yield* Config.Boolean("REQUIRE_EMAIL_VERIFICATION").pipe(
		Config.withDefault(false),
	);
	const referrals =
		mode === "referral"
			? referralLinks(
					yield* Config.Redacted("BETTER_AUTH_SECRET"),
					installation.webAppUrl,
					installation.publicUrl,
				)
			: undefined;

	return Service.of({
		admit: ({ email, referralCode }) =>
			Effect.gen(function* () {
				if (mode === "open" || (yield* isEmpty)) return {};
				if (yield* hasPendingInvitation(email)) return {};
				if (referrals && referralCode !== undefined) {
					return { referredBy: yield* referrals.referrerOf(referralCode) };
				}
				return yield* new SignUpClosed();
			}).pipe(Effect.provideService(Database, database)),
		requireEmailVerification,
		referralLink: referrals
			? Effect.flatMap(CurrentActor.Service, ({ userId }) => referrals.linkFor(userId)).pipe(
					Effect.provideService(Database, database),
				)
			: Effect.undefined,
		resetReferralLink: referrals
			? Effect.flatMap(CurrentActor.Service, ({ userId }) => referrals.reset(userId)).pipe(
					Effect.provideService(Database, database),
				)
			: Effect.fail(new ReferralsOff()),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * `closed`: nobody signs themselves up. People arrive by invitation to a workspace, except
 * the installation's first account.
 * `referral`: those, and anybody holding a member's referral link.
 * `open`: anybody.
 */
export const SIGNUP_MODES = ["closed", "referral", "open"] as const;

export type SignUpMode = (typeof SIGNUP_MODES)[number];

export interface Applicant {
	email: string;
	/** The code from a referral link, when the applicant arrived with one. */
	referralCode?: string;
}

export interface Admission {
	/** The member whose referral link let the applicant in. */
	referredBy?: string;
}

export class SignUpClosed extends Data.TaggedError("SignUpClosed") implements UserFacing {
	get userMessage() {
		return UserMessage.of`Signups are invite only. Ask a member to invite you.`;
	}
}

export class ReferralLinkInvalid
	extends Data.TaggedError("ReferralLinkInvalid")
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`This referral link no longer works. Ask whoever sent it for a new one.`;
	}
}

export class ReferralsOff extends Data.TaggedError("ReferralsOff") implements UserFacing {
	get userMessage() {
		return UserMessage.of`This installation does not sign people up by referral.`;
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
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) =>
			db
				.select({ id: workspaceInvite.id })
				.from(workspaceInvite)
				.where(
					and(
						eq(workspaceInvite.email, email),
						eq(workspaceInvite.status, "pending"),
						gt(workspaceInvite.expiresAt, now),
					),
				)
				.limit(1),
		).pipe(Effect.map(([pending]) => pending !== undefined)),
	);

/** Where a referral link opens the web app. */
const REFERRAL_LINK_PATH = "/join";

/** Separates the referral links' key from the other keys drawn from the same secret. */
const REFERRAL_KEY_INFO = "sugabots referral link";

const REFERRAL_KEY_BYTES = 32;

const REFERRAL_ALGORITHM = "HS256";

/**
 * Referral links: a JWT naming the member who sent it and the version of their
 * link, signed with a key drawn from `secret`. With no issue time or expiry,
 * a member's link is the same every time it is asked for until they reset it.
 * `audience` keeps a link to one installation.
 */
function referralLinks(secret: Redacted.Redacted, webAppUrl: string, audience: string) {
	const key = new Uint8Array(
		hkdfSync("sha256", Redacted.value(secret), "", REFERRAL_KEY_INFO, REFERRAL_KEY_BYTES),
	);

	const sign = (userId: string, version: number) =>
		Effect.promise(() =>
			new SignJWT({ version })
				.setProtectedHeader({ alg: REFERRAL_ALGORITHM })
				.setSubject(userId)
				.setAudience(audience)
				.sign(key),
		).pipe(
			Effect.map((code) => {
				const link = new URL(`${webAppUrl}${REFERRAL_LINK_PATH}`);
				link.searchParams.set("code", code);
				return link.toString();
			}),
		);

	/** Links are asked for by signed-in people, so a missing row is a defect rather than a refusal. */
	const signExisting = (userId: string, member: { version: number } | undefined) =>
		member ? sign(userId, member.version) : Effect.die(new Error(`No user ${userId}`));

	const verified = (code: string) =>
		Effect.tryPromise({
			try: () => jwtVerify(code, key, { algorithms: [REFERRAL_ALGORITHM], audience }),
			catch: () => new ReferralLinkInvalid(),
		}).pipe(
			Effect.flatMap(({ payload }) =>
				typeof payload.sub === "string" && Number.isInteger(payload.version)
					? Effect.succeed({ referrer: payload.sub, version: payload.version as number })
					: Effect.fail(new ReferralLinkInvalid()),
			),
		);

	return {
		linkFor: (userId: string) =>
			query((db) =>
				db.select({ version: user.referralLinkVersion }).from(user).where(eq(user.id, userId)),
			).pipe(Effect.flatMap(([member]) => signExisting(userId, member))),

		reset: (userId: string) =>
			query((db) =>
				db
					.update(user)
					.set({ referralLinkVersion: sql`${user.referralLinkVersion} + 1` })
					.where(eq(user.id, userId))
					.returning({ version: user.referralLinkVersion }),
			).pipe(Effect.flatMap(([member]) => signExisting(userId, member))),

		/** The member who sent `code`, while they still have an account and have not reset their link since. */
		referrerOf: (code: string) =>
			Effect.gen(function* () {
				const { referrer, version } = yield* verified(code);
				const [current] = yield* query((db) =>
					db.select({ version: user.referralLinkVersion }).from(user).where(eq(user.id, referrer)),
				);
				if (current?.version !== version) return yield* new ReferralLinkInvalid();
				return referrer;
			}),
	};
}
