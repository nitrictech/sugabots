export * as Accounts from "./accounts.ts";

import { randomBytes } from "node:crypto";
import { userText } from "@sugabots/errors";
import { and, eq, gt } from "drizzle-orm";
import { Config, Context, Data, DateTime, Effect, Layer } from "effect";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Database, query } from "../database/database.ts";
import { user, workspaceInvite } from "../database/schema.ts";
import { Installation } from "../installation/installation.ts";
import type { UserFacing } from "../user-message.ts";

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
	const referrals = mode === "referral" ? referralLinks(installation.webAppUrl) : undefined;

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
		return userText`Signups are invite only. Ask a member to invite you.`;
	}
}

export class ReferralLinkInvalid
	extends Data.TaggedError("ReferralLinkInvalid")
	implements UserFacing
{
	get userMessage() {
		return userText`This invite link isn't valid. Check you have all of it, or ask whoever sent it for a new one.`;
	}
}

export class ReferralsOff extends Data.TaggedError("ReferralsOff") implements UserFacing {
	get userMessage() {
		return userText`This installation does not sign people up by referral.`;
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

/** Crockford's base32, lowercased: no i, l, o or u, so a code read aloud or retyped survives. */
const REFERRAL_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 65 bits: out of reach of guessing even without sign-up's rate limit, and still short enough to paste. */
const REFERRAL_CODE_LENGTH = 13;

/**
 * Referral links: a random code kept on the member's row, made the first time
 * they ask for their link. Resetting replaces it, so the old one finds nobody.
 */
function referralLinks(webAppUrl: string) {
	const linkTo = (code: string) => `${webAppUrl}${REFERRAL_LINK_PATH}/${code}`;

	const replaceCode = (userId: string) =>
		query((db) =>
			db
				.update(user)
				.set({ referralCode: newReferralCode() })
				.where(eq(user.id, userId))
				.returning({ code: user.referralCode }),
		).pipe(
			Effect.flatMap(([member]) =>
				// Links are asked for by signed-in people, so a missing row is a defect rather than a refusal.
				member?.code
					? Effect.succeed(linkTo(member.code))
					: Effect.die(new Error(`No user ${userId}`)),
			),
		);

	return {
		linkFor: (userId: string) =>
			query((db) =>
				db.select({ code: user.referralCode }).from(user).where(eq(user.id, userId)),
			).pipe(
				Effect.flatMap(([member]) =>
					member?.code ? Effect.succeed(linkTo(member.code)) : replaceCode(userId),
				),
			),

		reset: replaceCode,

		/** The member whose link carries `code`, while they still have an account and have not reset it since. */
		referrerOf: (code: string) =>
			query((db) =>
				db.select({ id: user.id }).from(user).where(eq(user.referralCode, code.toLowerCase())),
			).pipe(
				Effect.flatMap(([referrer]) =>
					referrer ? Effect.succeed(referrer.id) : Effect.fail(new ReferralLinkInvalid()),
				),
			),
	};
}

function newReferralCode(): string {
	return Array.from(
		randomBytes(REFERRAL_CODE_LENGTH),
		// 256 is a multiple of 32, so every letter is equally likely.
		(byte) => REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length],
	).join("");
}
