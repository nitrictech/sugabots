import { NodeRuntime } from "@effect/platform-node";
import { handleFromName, PERSONAL_POD_SLUG } from "@sugabots/contracts";
import { Accounts } from "@sugabots/core/accounts/accounts";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import {
	agent,
	pod,
	podMember,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { Email } from "@sugabots/core/email/email";
import { Installation } from "@sugabots/core/installation/installation";
import { provisionDefaultSearchProvider } from "@sugabots/core/providers/search-providers/store";
import { ensureSystemAgents } from "@sugabots/core/workspaces/agents/system-agents";
import { and, eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer } from "effect";
import { Authentication } from "./auth/authentication.ts";
import { API_BASE_PATH } from "./http/api.ts";

/**
 * Development seed: the smallest amount of data that makes the app worth
 * opening. Run it with `bun run db:seed`, against a migrated database.
 *
 * It creates an account you can sign in as, the workspace everything else
 * hangs off, the membership joining them, two pods, and the three agents
 * the design's artboards show.
 *
 * Every step must be idempotent, because this is run repeatedly against a
 * database that already has data in it, not only against an empty one.
 */

const EMAIL = "dev@sugabots.local";
const PASSWORD = "development";

const seed = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	if (installation.isProduction) {
		return yield* Effect.die(new Error("The development seed cannot run in production."));
	}
	const [existingAccount] = yield* query((db) =>
		db.select({ id: user.id }).from(user).where(eq(user.email, EMAIL)),
	);
	if (!existingAccount) {
		yield* signUp;
	}

	yield* query((db) =>
		Effect.gen(function* () {
			const [person] = yield* db.select().from(user).where(eq(user.email, EMAIL));
			if (!person) {
				return yield* Effect.die(new Error(`could not create ${EMAIL}`));
			}
			if (!person.emailVerified) {
				yield* db.update(user).set({ emailVerified: true }).where(eq(user.id, person.id));
			}

			const [inserted] = yield* db
				.insert(workspace)
				.values({ name: "Development", slug: "dev" })
				.onConflictDoNothing({ target: workspace.slug })
				.returning();
			const [existing] = inserted
				? [inserted]
				: yield* db.select().from(workspace).where(eq(workspace.slug, "dev"));
			if (!existing) {
				throw new Error("could not create the dev workspace");
			}

			yield* db
				.insert(workspaceMember)
				.values({ workspaceId: existing.id, userId: person.id, role: "admin" })
				.onConflictDoNothing({ target: [workspaceMember.workspaceId, workspaceMember.userId] });

			yield* provisionDefaultSearchProvider(db, existing.id, person.id);

			const pods = new Map<string, string>();
			for (const [name, slug, kind] of [
				["Personal", PERSONAL_POD_SLUG, "personal"],
				["Support", "support", "shared"],
			] as const) {
				const [made] = yield* db
					.insert(pod)
					.values({
						workspaceId: existing.id,
						// A shared pod has no owner; a Personal one is its owner's alone.
						ownerId: kind === "personal" ? person.id : null,
						kind,
						name,
						slug,
						createdById: person.id,
					})
					// A shared pod conflicts on its slug, a Personal one on its owner.
					.onConflictDoNothing()
					.returning();

				const [row] = made
					? [made]
					: yield* db
							.select()
							.from(pod)
							.where(
								and(
									eq(pod.workspaceId, existing.id),
									eq(pod.slug, slug),
									// Every Personal pod is `personal`; this person's is the one they own.
									kind === "personal" ? eq(pod.ownerId, person.id) : undefined,
								),
							);
				if (!row) {
					throw new Error(`could not create #${slug}`);
				}
				pods.set(slug, row.id);

				yield* db
					.insert(podMember)
					.values({ workspaceId: existing.id, podId: row.id, userId: person.id })
					.onConflictDoNothing({ target: [podMember.podId, podMember.userId] });
			}

			const model = "claude-sonnet-4-20250514";

			// One pair for the workspace, serving every pod above, and left unset: the
			// seed provisions no model provider, so naming a model here would only make
			// them look ready while nothing they need is configured. Choosing one is
			// what the Built-in agents screen is for.
			yield* ensureSystemAgents(db, { workspaceId: existing.id, createdById: person.id });

			for (const seedling of [
				{
					name: "Linear Handler",
					color: "green" as const,
					face: "pill" as const,
					description: "Reads and writes Linear on the team's behalf.",
					pod: PERSONAL_POD_SLUG,
				},
				{
					name: "Issue Triager",
					color: "purple" as const,
					face: "dot" as const,
					description: "Sorts incoming issues every weekday morning.",
					pod: PERSONAL_POD_SLUG,
				},
				{
					name: "Customer Research",
					color: "orange" as const,
					face: "arc" as const,
					description: "Digs through calls and notes for what customers asked for.",
					pod: "support",
				},
			]) {
				const podId = pods.get(seedling.pod);
				if (!podId) throw new Error(`could not find #${seedling.pod}`);
				const [made] = yield* db
					.insert(agent)
					.values({
						workspaceId: existing.id,
						podId,
						createdById: person.id,
						name: seedling.name,
						handle: handleFromName(seedling.name),
						description: seedling.description,
						color: seedling.color,
						face: seedling.face,
						model,
					})
					.onConflictDoNothing({ target: [agent.podId, agent.name] })
					.returning();

				const [row] = made
					? [made]
					: yield* db
							.select()
							.from(agent)
							.where(and(eq(agent.podId, podId), eq(agent.name, seedling.name)));
				if (!row) {
					throw new Error(`could not create ${seedling.name}`);
				}
			}

			console.log(`workspace ${existing.slug}, administered by ${EMAIL} (password: ${PASSWORD})`);
			console.log("pods Personal and Support, three agents between them");
		}),
	);
});

/** Through the same route the web app signs up with. */
const signUp = Effect.gen(function* () {
	const installation = yield* Installation.Service;
	const authentication = yield* Authentication.Service;
	const response = yield* authentication.handler(
		new Request(`${installation.publicUrl}${API_BASE_PATH}/auth/sign-up/email`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: new URL(installation.publicUrl).origin,
			},
			body: JSON.stringify({ name: "Development", email: EMAIL, password: PASSWORD }),
		}),
	);
	if (!response.ok) {
		const reason = yield* Effect.promise(() => response.text());
		return yield* Effect.die(new Error(`could not sign up ${EMAIL}: ${reason}`));
	}
});

/** Whoever may sign up and whether they must verify is the installation's to configure, so the seed configures its own. */
const seedAccounts = Accounts.layerNoDeps.pipe(
	Layer.provide(
		ConfigProvider.layer(
			ConfigProvider.fromEnv({
				env: { ALLOW_OPEN_SIGNUP: "true", REQUIRE_EMAIL_VERIFICATION: "false" },
			}),
		),
	),
);

seed.pipe(
	Effect.scoped,
	Effect.provide(
		Authentication.layerNoDeps.pipe(
			Layer.provide([
				seedAccounts,
				Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
			]),
			Layer.provideMerge(Layer.mergeAll(databaseLayer, Installation.layer)),
		),
	),
	NodeRuntime.runMain,
);
