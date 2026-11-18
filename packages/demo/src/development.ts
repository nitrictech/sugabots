import { NodeRuntime } from "@effect/platform-node";
import { CurrentActor } from "@sugabots/core/authorization/current-actor";
import { ComputerCredentials } from "@sugabots/core/computers/computer-credentials";
import { Credentials } from "@sugabots/core/credentials/credentials";
import { layer as databaseLayer, query } from "@sugabots/core/database/database";
import { bot as botTable, channel, workspace } from "@sugabots/core/database/schema";
import { Email } from "@sugabots/core/email/email";
import { Ids } from "@sugabots/core/ids/ids";
import { Installation } from "@sugabots/core/installation/installation";
import { Egress } from "@sugabots/core/providers/network/egress";
import { BotRepository } from "@sugabots/core/workspaces/bots/bot-repository";
import { PersonalAssistants } from "@sugabots/core/workspaces/bots/personal-assistants";
import { ChannelRepository } from "@sugabots/core/workspaces/channels/channel-repository";
import { Membership } from "@sugabots/core/workspaces/membership/membership";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Authentication } from "@sugabots/server/auth/authentication";
import { and, eq, type SQL } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { ensureAccount, seedAccountsLayer } from "./accounts.ts";

/**
 * Development seed: the smallest amount of data that makes the app worth
 * opening. Run it with `bun run db:seed`, against a migrated database.
 *
 * It creates an account you can sign in as, the workspace everything else
 * hangs off, the membership joining them, the person's Personal Assistant,
 * a channel, and the three bots the design's artboards show: two private to
 * the person and one public bot in the channel.
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
	const personalAssistants = yield* PersonalAssistants.Service;
	const channels = yield* ChannelRepository.Service;
	const bots = yield* BotRepository.Service;
	const personId = yield* ensureAccount({ name: "Development", email: EMAIL, password: PASSWORD });

	// Made the way the app makes one, so it has its system bots, search
	// provider and the person's Personal Assistant. The system bots are left unset:
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

	// Already made with a new workspace; this makes it when a run before
	// the Personal Assistant existed made the workspace.
	yield* personalAssistants.provision({ workspaceId, userId: personId });
	const supportId = yield* channels
		.create(workspaceId, { creatorId: personId, name: "Support", slug: "support" })
		.pipe(
			Effect.map((created) => created.id),
			Effect.catchTag("ChannelSlugTaken", () =>
				idOf(channel, and(eq(channel.workspaceId, workspaceId), eq(channel.slug, "support"))),
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
			visibility: "private" as const,
		},
		{
			name: "Issue Triager",
			color: "purple" as const,
			face: "dot" as const,
			shape: "hexagon" as const,
			description: "Sorts incoming issues every weekday morning.",
			visibility: "private" as const,
		},
		{
			name: "Customer Research",
			color: "orange" as const,
			face: "arc" as const,
			shape: "blob" as const,
			description: "Digs through calls and notes for what customers asked for.",
			visibility: "public" as const,
			channelId: supportId,
		},
	]) {
		const { channelId, ...bot } = seedling;
		const botId = yield* bots
			.create(workspaceId, { createdById: personId, bot: { ...bot, model } })
			.pipe(
				Effect.map((created) => created.id),
				Effect.catchTag("BotNameTaken", () =>
					idOf(botTable, and(eq(botTable.workspaceId, workspaceId), eq(botTable.name, bot.name))),
				),
			);
		if (channelId) yield* channels.addBot(workspaceId, channelId, botId);
	}

	console.log(`workspace dev, administered by ${EMAIL} (password: ${PASSWORD})`);
	console.log("channel Support, and three bots: two private, one public in Support");
});

/** The id of the one row of `table` matching `where`, which a previous run made. */
const idOf = (table: typeof workspace | typeof channel | typeof botTable, where: SQL | undefined) =>
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
			PersonalAssistants.layer,
			ChannelRepository.layer,
			BotRepository.layer,
		).pipe(
			Layer.provideMerge(
				Layer.mergeAll(
					Ids.layer,
					Credentials.layer,
					// Leaving and deleting go through the bots' computers; the seed never makes one.
					Egress.layer,
					ComputerCredentials.none,
					seedAccountsLayer,
					Layer.succeed(Email.Service, Email.Service.of({ send: () => Effect.void })),
				).pipe(Layer.provideMerge(Installation.layer), Layer.provideMerge(databaseLayer)),
			),
		),
	),
	NodeRuntime.runMain,
);
