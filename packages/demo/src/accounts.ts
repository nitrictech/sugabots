import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { query } from "@sugabots/core/database/database";
import { user } from "@sugabots/core/database/schema";
import { Installation } from "@sugabots/core/installation/installation";
import { Authentication } from "@sugabots/server/auth/authentication";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer } from "effect";

/** Someone a development seed signs in as. */
export interface SeedPerson {
	name: string;
	email: string;
	password: string;
}

/**
 * The id of `person`'s account, with their address verified. Signs them up
 * first if there is no account, through the same route the web app signs up
 * with.
 */
export const ensureAccount = (person: SeedPerson) =>
	Effect.gen(function* () {
		const [existing] = yield* query((db) =>
			db.select({ id: user.id }).from(user).where(eq(user.email, person.email)),
		);
		if (!existing) {
			yield* signUp(person);
		}
		const [account] = yield* query((db) =>
			db
				.select({ id: user.id, emailVerified: user.emailVerified })
				.from(user)
				.where(eq(user.email, person.email)),
		);
		if (!account) {
			return yield* Effect.die(new Error(`could not create ${person.email}`));
		}
		if (!account.emailVerified) {
			yield* query((db) =>
				db.update(user).set({ emailVerified: true }).where(eq(user.id, account.id)),
			);
		}
		return account.id;
	});

const signUp = (person: SeedPerson) =>
	Effect.gen(function* () {
		const installation = yield* Installation.Service;
		const authentication = yield* Authentication.Service;
		const response = yield* authentication.handler(
			new Request(`${installation.publicUrl}${API_BASE_PATH}/auth/sign-up/email`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: new URL(installation.publicUrl).origin,
				},
				body: JSON.stringify(person),
			}),
		);
		if (!response.ok) {
			const reason = yield* Effect.promise(() => response.text());
			return yield* Effect.die(new Error(`could not sign up ${person.email}: ${reason}`));
		}
	});

/** Whoever may sign up and whether they must verify is the installation's to configure, so a seed configures its own. */
export const seedAccountsLayer = Accounts.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromEnv({
				env: { SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "false" },
			}),
		),
	),
);
