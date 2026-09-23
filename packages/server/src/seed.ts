import { handleFromName } from "@sugabots/contracts";
import { layer as databaseLayer, effectRunner, query } from "@sugabots/core/database/database";
import {
	agent,
	pod,
	podMember,
	user,
	workspace,
	workspaceMember,
} from "@sugabots/core/database/schema";
import { provisionDefaultSearchProvider } from "@sugabots/core/providers/search-providers/store";
import { ensureSystemAgents } from "@sugabots/core/workspaces/agents/system-agents";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, ManagedRuntime } from "effect";
import { Pool } from "pg";
import { createAuth } from "./auth/auth.ts";
import { configFromEnv } from "./config.ts";

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

const config = configFromEnv();
if (config.environment !== "development") {
	throw new Error("The development seed cannot turn in production.");
}

const database = ManagedRuntime.make(databaseLayer(config.databaseUrl));
// better-auth's adapter only speaks node-postgres.
const authPool = new Pool({ connectionString: config.databaseUrl });

/** Signs the development account up. */
const signUp = Effect.promise(() => {
	// The seed is the bootstrap, so it is not subject to the installation's policy.
	const auth = createAuth({
		...config,
		db: drizzle({ client: authPool }),
		run: effectRunner(database),
		allowOpenSignUp: true,
		requireEmailVerification: false,
	});
	return auth.api.signUpEmail({ body: { name: "Development", email: EMAIL, password: PASSWORD } });
});

const seed = query((db) =>
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
			["Personal", `personal-${person.id}`, "personal"],
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
				.onConflictDoNothing({ target: [pod.workspaceId, pod.slug] })
				.returning();

			const [row] = made
				? [made]
				: yield* db
						.select()
						.from(pod)
						.where(and(eq(pod.workspaceId, existing.id), eq(pod.slug, slug)));
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
				hue: 158,
				face: "bar" as const,
				description: "Reads and writes Linear on the team's behalf.",
				pod: `personal-${person.id}`,
			},
			{
				name: "Issue Triager",
				hue: 272,
				face: "dots" as const,
				description: "Sorts incoming issues every weekday morning.",
				pod: `personal-${person.id}`,
			},
			{
				name: "Customer Research",
				hue: 62,
				face: "smile" as const,
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
					hue: seedling.hue,
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

try {
	await database.runPromise(seed);
} finally {
	await database.dispose();
	await authPool.end();
}
