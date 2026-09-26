import { NodeRuntime } from "@effect/platform-node";
import { handleFromName, PERSONAL_POD_SLUG } from "@sugabots/contracts";
import {
	type Database,
	layer as databaseLayer,
	effectRunner,
	query,
} from "@sugabots/core/database/database";
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
import { drizzle } from "drizzle-orm/node-postgres";
import { Config, Effect, Layer, Redacted } from "effect";
import { Pool } from "pg";
import { createAuth } from "./auth/auth.ts";
import { ServerConfig } from "./config.ts";

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
	const config = yield* ServerConfig.Service;
	const email = yield* Email.Service;
	const database = yield* Effect.context<Database>();
	// better-auth's adapter only speaks node-postgres.
	const authPool = yield* Effect.acquireRelease(
		Effect.map(
			Config.Redacted("DATABASE_URL"),
			(url) => new Pool({ connectionString: Redacted.value(url) }),
		),
		(pool) => Effect.promise(() => pool.end()),
	);
	// The seed is the bootstrap, so it is not subject to the installation's policy.
	const auth = createAuth({
		secret: Redacted.value(config.secret),
		installation,
		db: drizzle({ client: authPool }),
		run: effectRunner({ runPromiseExit: Effect.runPromiseExitWith(database) }),
		mailer: (message) => Effect.runPromiseWith(database)(email.send(message)),
		allowOpenSignUp: true,
		requireEmailVerification: false,
		emailFrom: config.transactionalSender,
	});
	// The password has to be hashed the way sign-in will hash it, so the account
	// is created through better-auth rather than inserted.
	const signUp = Effect.promise(() =>
		auth.api.signUpEmail({ body: { name: "Development", email: EMAIL, password: PASSWORD } }),
	);

	yield* query((db) =>
		Effect.gen(function* () {
			// The password has to be hashed the way sign-in will hash it, so the account
			// is created through better-auth rather than inserted.
			let [person] = yield* db.select().from(user).where(eq(user.email, EMAIL));
			if (!person) {
				yield* signUp;
				[person] = yield* db.select().from(user).where(eq(user.email, EMAIL));
			}
			if (!person) {
				throw new Error(`could not create ${EMAIL}`);
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

seed.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(databaseLayer, Email.layer, Installation.layer, ServerConfig.layer),
	),
	NodeRuntime.runMain,
);
