export { ReferralsOff } from "@sugabots/contracts/errors/workspace";
export * as Accounts from "./accounts.ts";

import { randomBytes } from "node:crypto";
import { ReferralsOff } from "@sugabots/contracts/errors/workspace";
import { userText } from "@sugabots/errors";
import { and, eq, gt } from "drizzle-orm";
import { Config, Context, Data, DateTime, Effect, Layer } from "effect";
import { Database, query } from "../database/database.ts";
import { invitation, member } from "../database/schema.ts";
import type { IsMember } from "../proofs/is-member.ts";
import { ServerSettings } from "../server-settings/server-settings.ts";
import { referralPath } from "../server-settings/web-app-paths.ts";
import { processLayer, Tier } from "../tiers.ts";
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
	/** The link the member can send others to let them sign up, or `undefined` when sign-up is not by referral. */
	readonly referralLink: <P>(isMember: IsMember<P>) => Effect.Effect<string | undefined>;
	/** Stops the member's referral link working, and returns the one that replaces it. */
	readonly resetReferralLink: <P>(isMember: IsMember<P>) => Effect.Effect<string, ReferralsOff>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Accounts") {
	declare readonly [Tier]: "process";
}

/**
 * Sign-up follows `SIGNUP_MODE`, closed unless set. Verification is
 * off by default, so a self-hoster needs no mail service to sign in.
 */
export const make = Effect.gen(function* () {
	const database = yield* Database;
	const serverSettings = yield* ServerSettings.Service;
	const mode = yield* Config.Literals(SIGNUP_MODES, "SIGNUP_MODE").pipe(
		Config.withDefault("closed"),
	);
	const requireEmailVerification = yield* Config.Boolean("REQUIRE_EMAIL_VERIFICATION").pipe(
		Config.withDefault(false),
	);
	const referrals = mode === "referral" ? referralLinks(serverSettings.webAppUrl) : undefined;

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
		referralLink: (isMember) =>
			referrals
				? referrals.linkFor(isMember.member).pipe(Effect.provideService(Database, database))
				: Effect.undefined,
		resetReferralLink: (isMember) =>
			referrals
				? referrals.reset(isMember.member).pipe(Effect.provideService(Database, database))
				: Effect.fail(new ReferralsOff()),
	});
});

export const layer = processLayer(Layer.effect(Service, make));

/**
 * `closed`: nobody signs themselves up. Members arrive by invitation to a workspace, except
 * the server's first account.
 * `referral`: those, and anybody holding a member's referral link.
 * `open`: anybody.
 */
const SIGNUP_MODES = ["closed", "referral", "open"] as const;

export type SignUpMode = (typeof SIGNUP_MODES)[number];

interface Applicant {
	email: string;
	/** The code from a referral link, when the applicant arrived with one. */
	referralCode?: string;
}

interface Admission {
	/** The member whose referral link let the applicant in. */
	referredBy?: string;
}

export class SignUpClosed extends Data.TaggedError("SignUpClosed") implements UserFacing {
	get userMessage() {
		return userText`Sign-up is by invitation only. Ask someone in a workspace to invite you.`;
	}
}

export class ReferralLinkInvalid
	extends Data.TaggedError("ReferralLinkInvalid")
	implements UserFacing
{
	get userMessage() {
		return userText`This referral link isn't valid. Check you have all of it, or ask whoever sent it for a new one.`;
	}
}

/**
 * An empty server admits its first account, or it could never be opened.
 * Unlocked: two simultaneous first sign-ups would both get in, which is harmless.
 */
const isEmpty = Effect.map(
	query((db) => db.select({ id: member.id }).from(member).limit(1)),
	([existing]) => existing === undefined,
);

const hasPendingInvitation = (email: string) =>
	Effect.flatMap(DateTime.nowAsDate, (now) =>
		query((db) =>
			db
				.select({ id: invitation.id })
				.from(invitation)
				.where(
					and(
						eq(invitation.email, email),
						eq(invitation.status, "pending"),
						gt(invitation.expiresAt, now),
					),
				)
				.limit(1),
		).pipe(Effect.map(([pending]) => pending !== undefined)),
	);

/** Crockford's base32, lowercased: no i, l, o or u, so a code read aloud or retyped survives. */
const REFERRAL_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 65 bits: out of reach of guessing even without sign-up's rate limit, and still short enough to paste. */
const REFERRAL_CODE_LENGTH = 13;

/**
 * Referral links: a random code kept on the member's row, made the first time
 * they ask for their link. Resetting replaces it, so the old one finds nobody.
 */
function referralLinks(webAppUrl: string) {
	const linkTo = (code: string) => `${webAppUrl}${referralPath(code)}`;

	const replaceCode = (memberId: string) =>
		query((db) =>
			db
				.update(member)
				.set({ referralCode: newReferralCode() })
				.where(eq(member.id, memberId))
				.returning({ code: member.referralCode }),
		).pipe(
			Effect.flatMap(([referrer]) =>
				// Links are asked for by signed-in members, so a missing row is a defect rather than a refusal.
				referrer?.code
					? Effect.succeed(linkTo(referrer.code))
					: Effect.die(new Error(`No member ${memberId}`)),
			),
		);

	return {
		linkFor: (memberId: string) =>
			query((db) =>
				db.select({ code: member.referralCode }).from(member).where(eq(member.id, memberId)),
			).pipe(
				Effect.flatMap(([referrer]) =>
					referrer?.code ? Effect.succeed(linkTo(referrer.code)) : replaceCode(memberId),
				),
			),

		reset: replaceCode,

		/** The member whose link carries `code`, while they still have an account and have not reset it since. */
		referrerOf: (code: string) =>
			// Longer than any code, such as a link pasted with a character after it.
			code.length > REFERRAL_CODE_LENGTH
				? Effect.fail(new ReferralLinkInvalid())
				: query((db) =>
						db
							.select({ id: member.id })
							.from(member)
							.where(eq(member.referralCode, code.toLowerCase())),
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
