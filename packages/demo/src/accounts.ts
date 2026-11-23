import { API_BASE_PATH } from "@sugabots/contracts/http";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { query } from "@sugabots/core/database/database";
import { person } from "@sugabots/core/database/schema";
import { ServerSettings } from "@sugabots/core/server-settings/server-settings";
import { Authentication } from "@sugabots/server/auth/authentication";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer } from "effect";

/** Someone a development seed signs in as. */
interface SeedPerson {
	name: string;
	email: string;
	password: string;
}

/**
 * The id of `seed`'s account, with their address verified. Signs them up
 * first if there is no account, through the same route the web app signs up
 * with.
 */
export const ensureAccount = (seed: SeedPerson) =>
	Effect.gen(function* () {
		const [existing] = yield* query((db) =>
			db.select({ id: person.id }).from(person).where(eq(person.email, seed.email)),
		);
		if (!existing) {
			yield* signUp(seed);
		}
		const [account] = yield* query((db) =>
			db
				.select({ id: person.id, emailVerified: person.emailVerified })
				.from(person)
				.where(eq(person.email, seed.email)),
		);
		if (!account) {
			return yield* Effect.die(new Error(`could not create ${seed.email}`));
		}
		if (!account.emailVerified) {
			yield* query((db) =>
				db.update(person).set({ emailVerified: true }).where(eq(person.id, account.id)),
			);
		}
		return account.id;
	});

const signUp = (seed: SeedPerson) =>
	Effect.gen(function* () {
		const serverSettings = yield* ServerSettings.Service;
		const authentication = yield* Authentication.Service;
		const response = yield* authentication.handler(
			new Request(`${serverSettings.publicUrl}${API_BASE_PATH}/auth/sign-up/email`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: new URL(serverSettings.publicUrl).origin,
				},
				body: JSON.stringify(seed),
			}),
		);
		if (!response.ok) {
			const reason = yield* Effect.promise(() => response.text());
			return yield* Effect.die(new Error(`could not sign up ${person.email}: ${reason}`));
		}
	});

/** Whoever may sign up and whether they must verify is the server's to configure, so a seed configures its own. */
export const seedAccountsLayer = Accounts.layer.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromEnv({
				env: { SIGNUP_MODE: "open", REQUIRE_EMAIL_VERIFICATION: "false" },
			}),
		),
	),
);
