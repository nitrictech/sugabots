import { NodeRuntime } from "@effect/platform-node";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { pod, workspace } from "@sugabots/core/database/schema";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { AgentRepository } from "@sugabots/core/workspaces/agents/agent-repository";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { PersonalPods } from "@sugabots/core/workspaces/pods/personal-pods";
import { PodRepository } from "@sugabots/core/workspaces/pods/pod-repository";
import { Authentication } from "@sugabots/server/auth/authentication";
import { and, eq, type SQL } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ensureAccount, seedAccountsLayer } from "./accounts.ts";

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
	const membership = yield* Membership.Service;
	const personalPods = yield* PersonalPods.Service;
	const pods = yield* PodRepository.Service;
	const agents = yield* AgentRepository.Service;
	const personId = yield* ensureAccount({ name: "Development", email: EMAIL, password: PASSWORD });

	// Made the way the app makes one, so it has its system agents, search
	// provider and the person's Personal pod. The system agents are left unset:
	// the seed provisions no model provider, so naming a model would only make
	// them look ready while nothing they need is configured.
	const workspaceId = yield* membership
		.create({ details: { name: "Development", slug: "dev" } })
		.pipe(
			CurrentActor.provide(CurrentActor.AuthenticatedUserId.vouchedFor(personId)),
			Effect.map((created) => created.id),
			Effect.catchTag("SlugTaken", () => idOf(workspace, eq(workspace.slug, "dev"))),
		);
	// The seed stands in for setting it up, so it opens straight into the app.
	yield* Onboarding.recordSetupCompleted(workspaceId);

	const personal = yield* personalPods.provision({ workspaceId, userId: personId });
	const supportId = yield* pods
		.create(workspaceId, { creatorId: personId, name: "Support", slug: "support" })
		.pipe(
			Effect.map((created) => created.id),
			Effect.catchTag("PodSlugTaken", () =>
				idOf(pod, and(eq(pod.workspaceId, workspaceId), eq(pod.slug, "support"))),
			),
		);

	const model = "claude-sonnet-4-20250514";
	for (const seedling of [
		{
			name: "Linear Handler",
			color: "green" as const,
			face: "pill" as const,
			shape: "squircle" as const,
			description: "Reads and writes Linear on the team's behalf.",
			podId: personal.id,
		},
		{
			name: "Issue Triager",
			color: "purple" as const,
			face: "dot" as const,
			shape: "hexagon" as const,
			description: "Sorts incoming issues every weekday morning.",
			podId: personal.id,
		},
		{
			name: "Customer Research",
			color: "orange" as const,
			face: "arc" as const,
			shape: "blob" as const,
			description: "Digs through calls and notes for what customers asked for.",
			podId: supportId,
		},
	]) {
		yield* agents
			.create(workspaceId, { createdById: personId, agent: { ...seedling, model } })
			.pipe(Effect.catchTag("AgentNameTaken", () => Effect.void));
	}

	console.log(`workspace dev, administered by ${EMAIL} (password: ${PASSWORD})`);
	console.log("pods Personal and Support, three agents between them");
});

/** The id of the one row of `table` matching `where`, which a previous run made. */
const idOf = (table: typeof workspace | typeof pod, where: SQL | undefined) =>
	Effect.flatMap(
		query((db) => db.select({ id: table.id }).from(table).where(where).limit(1)),
		([row]) => (row ? Effect.succeed(row.id) : Effect.die(new Error("A seeded row is missing"))),
	);

seed.pipe(
	Effect.scoped,
	Effect.provide(
		Layer.mergeAll(
			Authentication.layer,
			Membership.layer,
			PersonalPods.layer,
			PodRepository.layer,
			AgentRepository.layer,
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					Ids.layer,
					Credentials.layer,
					seedAccountsLayer,
					Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
				).pipe(Layer.provideMerge(Installation.layer), Layer.provideMerge(databaseLayer)),
			),
		),
	),
	NodeRuntime.runMain,
);
