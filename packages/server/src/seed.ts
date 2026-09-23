import { handleFromName } from "@sugabots/contracts";
import { closePool, getDb } from "@sugabots/core/database/client";
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

async function seed(): Promise<void> {
	const config = configFromEnv();
	if (config.environment !== "development") {
		throw new Error("The development seed cannot turn in production.");
	}
	const db = getDb();

	// The password has to be hashed the way sign-in will hash it, so the account
	// is created through better-auth rather than inserted.
	let [person] = await db.select().from(user).where(eq(user.email, EMAIL));
	if (!person) {
		// The seed is the bootstrap, so it is not subject to the installation's policy.
		const auth = createAuth({
			...config,
			db,
			allowOpenSignUp: true,
			requireEmailVerification: false,
		});
		await auth.api.signUpEmail({ body: { name: "Development", email: EMAIL, password: PASSWORD } });
		[person] = await db.select().from(user).where(eq(user.email, EMAIL));
	}
	if (!person) {
		throw new Error(`could not create ${EMAIL}`);
	}
	if (!person.emailVerified) {
		await db.update(user).set({ emailVerified: true }).where(eq(user.id, person.id));
	}

	const [inserted] = await db
		.insert(workspace)
		.values({ name: "Development", slug: "dev" })
		.onConflictDoNothing({ target: workspace.slug })
		.returning();
	const [existing] = inserted
		? [inserted]
		: await db.select().from(workspace).where(eq(workspace.slug, "dev"));
	if (!existing) {
		throw new Error("could not create the dev workspace");
	}

	await db
		.insert(workspaceMember)
		.values({ workspaceId: existing.id, userId: person.id, role: "admin" })
		.onConflictDoNothing({ target: [workspaceMember.workspaceId, workspaceMember.userId] });

	await provisionDefaultSearchProvider(db, existing.id, person.id);

	const pods = new Map<string, string>();
	for (const [name, slug, kind] of [
		["Personal", `personal-${person.id}`, "personal"],
		["Support", "support", "shared"],
	] as const) {
		const [made] = await db
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
			: await db
					.select()
					.from(pod)
					.where(and(eq(pod.workspaceId, existing.id), eq(pod.slug, slug)));
		if (!row) {
			throw new Error(`could not create #${slug}`);
		}
		pods.set(slug, row.id);

		await db
			.insert(podMember)
			.values({ workspaceId: existing.id, podId: row.id, userId: person.id })
			.onConflictDoNothing({ target: [podMember.podId, podMember.userId] });
	}

	const model = "claude-sonnet-4-20250514";

	// One pair for the workspace, serving every pod above, and left unset: the
	// seed provisions no model provider, so naming a model here would only make
	// them look ready while nothing they need is configured. Choosing one is
	// what the Built-in agents screen is for.
	await ensureSystemAgents(db, { workspaceId: existing.id, createdById: person.id });

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
		const [made] = await db
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
			: await db
					.select()
					.from(agent)
					.where(and(eq(agent.podId, podId), eq(agent.name, seedling.name)));
		if (!row) {
			throw new Error(`could not create ${seedling.name}`);
		}
	}

	console.log(`workspace ${existing.slug}, administered by ${EMAIL} (password: ${PASSWORD})`);
	console.log("pods Personal and Support, three agents between them");
}

try {
	await seed();
} finally {
	await closePool();
}
