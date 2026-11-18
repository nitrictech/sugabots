import type { ComputerProviderSettings } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	primaryKey as compositePrimaryKey,
	foreignKey,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { bot, user, workspace } from "../workspaces/sql.ts";
import type { DiskUsage } from "./computer-disk.ts";
import type { Computers } from "./computers.ts";

/**
 * A computer provider a workspace has configured: an account at a service that
 * makes Linux machines. A workspace may have several, but at most one is
 * enabled, and that one makes its bots' computers.
 */
export const computerProvider = pgTable(
	"computer_provider",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		/** Follows `settings`, so the preset and its settings can't disagree. */
		preset: text("preset")
			.$type<ComputerProviderSettings["preset"]>()
			.generatedAlwaysAs(sql`settings->>'preset'`)
			.notNull(),
		/** What the workspace configured: where the provider is, and what to make computers from. */
		settings: jsonb("settings").$type<ComputerProviderSettings>().notNull(),
		enabled: boolean("enabled").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		/**
		 * What Sugabots made in the provider's account for these settings and
		 * key, such as E2B's template build; null until it makes something, and
		 * again once the settings or key change.
		 */
		managedResources: jsonb("managed_resources").$type<ComputerManagedResources>(),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("computer_provider_enabled_idx").on(table.workspaceId).where(sql`${table.enabled}`),
		uniqueIndex("computer_provider_id_workspace_id_idx").on(table.id, table.workspaceId),
		check("computer_provider_preset_check", sql`${table.preset} in ('opensandbox', 'e2b')`),
	],
);

export type ComputerProviderRow = typeof computerProvider.$inferSelect;

/** What Sugabots made in a provider's account, by preset. */
export type ComputerManagedResources = {
	readonly preset: "e2b";
	/** The last build of its template that Sugabots started, by E2B's ids for it. */
	readonly templateBuild: { readonly templateId: string; readonly buildId: string };
};

/**
 * A bot's computer: the machine it runs commands on, at the provider that
 * made it. One per bot, made the first time the bot needs it.
 */
export const computer = pgTable(
	"computer",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		botId: uuid("bot_id").notNull(),
		/**
		 * The provider that made it. Removing a provider destroys its computers
		 * first; the row cascades only so that deleting a workspace, which
		 * reaches it through both the provider and the bot, never fails.
		 */
		computerProviderId: uuid("computer_provider_id").notNull(),
		/** The provider's own id for it. */
		providerComputerId: text("provider_computer_id").$type<Computers.ComputerId>().notNull(),
		/**
		 * What it was made from, as Sugabots asked its provider: an image the
		 * provider takes as it is pinned to its digest where the registry said
		 * one, or a template's name. Null for one made before this was recorded.
		 */
		image: text("image"),
		/** When it was paused for sitting idle; null while it runs. */
		pausedAt: timestamp("paused_at", { withTimezone: true }),
		/** When it was last opened or let go of, which is when its idle time starts. */
		lastUsedAt: stamp("last_used_at"),
		/** How full its disk was at `diskMeasuredAt`; null until it is measured, and again once it is replaced. */
		diskUsage: jsonb("disk_usage").$type<DiskUsage>(),
		diskMeasuredAt: timestamp("disk_measured_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "computer_bot_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.computerProviderId, table.workspaceId],
			foreignColumns: [computerProvider.id, computerProvider.workspaceId],
			name: "computer_provider_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("computer_bot_id_idx").on(table.botId),
		check(
			"computer_disk_measured_check",
			sql`(${table.diskUsage} is null) = (${table.diskMeasuredAt} is null)`,
		),
	],
);

export type ComputerRow = typeof computer.$inferSelect;

/**
 * A turn using a computer, or a person viewing its desktop, which keeps it
 * from being paused. The holder renews it while it uses the computer and
 * deletes it when done; one left behind by a process that stopped simply
 * expires.
 */
export const computerLease = pgTable(
	"computer_lease",
	{
		computerId: uuid("computer_id")
			.notNull()
			.references(() => computer.id, { onDelete: "cascade" }),
		/** Only a turn's lease stops a reset or upgrade; a viewer's just keeps the computer awake. */
		holderKind: text("holder_kind").$type<ComputerLeaseHolderKind>().notNull(),
		/** The turn's id, or the viewer's connection: one per connection, so closing one tab leaves the others' leases. */
		holderId: text("holder_id").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.computerId, table.holderKind, table.holderId] }),
		check("computer_lease_holder_kind_check", sql`${table.holderKind} in ('turn', 'viewer')`),
	],
);

export type ComputerLeaseHolderKind = "turn" | "viewer";

/**
 * A host every computer in a workspace may reach, beyond the trusted ones
 * every workspace's computers reach. Added in settings by someone who manages
 * the workspace's computers.
 */
export const allowedHost = pgTable(
	"allowed_host",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		host: text("host").notNull(),
		/** Who added it, or approved the request for it. */
		addedById: uuid("added_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [compositePrimaryKey({ columns: [table.workspaceId, table.host] })],
);

/**
 * A host one bot's computer may reach, beyond what the workspace lets every
 * computer reach. Added in the bot's settings, or by approving the bot's
 * request for it.
 */
export const botAllowedHost = pgTable(
	"bot_allowed_host",
	{
		workspaceId: uuid("workspace_id").notNull(),
		botId: uuid("bot_id").notNull(),
		host: text("host").notNull(),
		addedById: uuid("added_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.botId, table.host] }),
		foreignKey({
			columns: [table.botId, table.workspaceId],
			foreignColumns: [bot.id, bot.workspaceId],
			name: "bot_allowed_host_bot_workspace_fkey",
		}).onDelete("cascade"),
	],
);

/**
 * A host no computer in the workspace may reach, whatever the workspace or a
 * bot allows: blocking it takes it, and any wildcard that covers it, out of
 * every bot's allowed hosts, and bots' requests for it are refused.
 */
export const blockedHost = pgTable(
	"blocked_host",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		host: text("host").notNull(),
		blockedById: uuid("blocked_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [compositePrimaryKey({ columns: [table.workspaceId, table.host] })],
);
