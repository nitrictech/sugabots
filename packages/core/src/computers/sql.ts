import type { ComputerProviderSettings } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	primaryKey as compositePrimaryKey,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { member, project, workspace } from "../workspaces/sql.ts";
import type { DiskUsage } from "./computer-disk.ts";
import type { Computers } from "./computers.ts";

/**
 * A computer provider a workspace has configured: an account at a service that
 * makes Linux machines. A workspace may have several, but at most one is
 * enabled, and that one makes its projects' computers.
 */
export const computerProvider = pgTable(
	"computer_provider",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		/** Follows `settings`, so the built-in provider and its settings can't disagree. */
		builtIn: text("built_in")
			.$type<ComputerProviderSettings["builtIn"]>()
			.generatedAlwaysAs(sql`settings->>'builtIn'`)
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
		createdById: uuid("created_by_id").references(() => member.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("computer_provider_enabled_idx").on(table.workspaceId).where(sql`${table.enabled}`),
		uniqueIndex("computer_provider_id_workspace_id_idx").on(table.id, table.workspaceId),
		check("computer_provider_built_in_check", sql`${table.builtIn} in ('opensandbox', 'e2b')`),
	],
);

export type ComputerProviderRow = typeof computerProvider.$inferSelect;

/** What Sugabots made in a provider's account, by built-in provider. */
type ComputerManagedResources = {
	readonly builtIn: "e2b";
	/** The last build of its template that Sugabots started, by E2B's ids for it. */
	readonly templateBuild: Computers.TemplateBuild;
};

/**
 * A project's online computer: the machine its bots run commands on while
 * they work in its chats, at the provider that made it. One per project,
 * made the first time one of its bots needs it; a bot's own is its default
 * project's.
 */
export const computer = pgTable(
	"computer",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		/**
		 * The provider that made it. Removing a provider destroys its computers
		 * first; the row cascades only so that deleting a workspace, which
		 * reaches it through both the provider and the project, never fails.
		 */
		computerProviderId: uuid("computer_provider_id").notNull(),
		/** The provider's own id for it. */
		providerComputerId: text("provider_computer_id").$type<Computers.ComputerId>().notNull(),
		/**
		 * What it was made from, as Sugabots asked its provider: an image the
		 * provider takes as it is pinned to its digest where the registry said
		 * one, or a template's name.
		 */
		image: text("image").notNull(),
		/** When it was asleep for sitting idle; null while it runs. */
		sleptAt: timestamp("slept_at", { withTimezone: true }),
		/** When it was last opened or let go of, which is when its idle time starts. */
		lastUsedAt: stamp("last_used_at"),
		intentId: uuid("intent_id"),
		intentExpiresAt: timestamp("intent_expires_at", { withTimezone: true }),
		/** How full its disk was at `diskMeasuredAt`; null until it is measured, and again once it is replaced. */
		diskUsage: jsonb("disk_usage").$type<DiskUsage>(),
		diskMeasuredAt: timestamp("disk_measured_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "computer_project_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.computerProviderId, table.workspaceId],
			foreignColumns: [computerProvider.id, computerProvider.workspaceId],
			name: "computer_provider_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("computer_project_id_idx").on(table.projectId),
		check(
			"computer_intent_check",
			sql`(${table.intentId} is null) = (${table.intentExpiresAt} is null)`,
		),
		check(
			"computer_disk_measured_check",
			sql`(${table.diskUsage} is null) = (${table.diskMeasuredAt} is null)`,
		),
	],
);

/**
 * A turn using a computer, or a member viewing its desktop, which keeps it
 * from sleeping. The holder renews it while it uses the computer and
 * deletes it when done; one left behind by a process that stopped simply
 * expires.
 */
export const computerLease = pgTable(
	"computer_lease",
	{
		computerId: uuid("computer_id")
			.notNull()
			.references(() => computer.id, { onDelete: "cascade" }),
		providerComputerId: text("provider_computer_id").$type<Computers.ComputerId>().notNull(),
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
 * A machine at a provider that no `computer` row records, which is destroyed
 * there and then forgotten: no transaction is held across a provider's call,
 * so what a call will leave behind is written down before it is made, and
 * survives the process stopping part-way.
 *
 * A row is written in the same transaction that last records the machine or
 * gives it up: before a computer is made, naming the label it will carry, and
 * deleted with the transaction that records it; when a project moves to
 * another computer, or its record is deleted without its machine, naming the
 * machine left. A migration writes one for a computer it found nothing to
 * keep for.
 */
export const computerDestruction = pgTable(
	"computer_destruction",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		/** The provider the machine is at; removing it destroys these first. */
		computerProviderId: uuid("computer_provider_id").notNull(),
		/** The provider's own id for the machine; null until a creation returns it. */
		providerComputerId: text("provider_computer_id").$type<Computers.ComputerId>(),
		/**
		 * The value of the machine's {@link CREATION_LABEL}, which finds it at the
		 * provider when its id was never recorded; null for one made without it.
		 */
		creationId: uuid("creation_id"),
		/** When it is next tried: a creation's grace runs out, or a retry's backoff. */
		dueAt: stamp("due_at"),
		/** Each claim adds one, so whoever claimed it last deletes it. */
		attempts: integer("attempts").notNull().default(0),
	},
	(table) => [
		foreignKey({
			columns: [table.computerProviderId, table.workspaceId],
			foreignColumns: [computerProvider.id, computerProvider.workspaceId],
			name: "computer_destruction_provider_workspace_fkey",
		}).onDelete("cascade"),
		index("computer_destruction_due_idx").on(table.dueAt, table.id),
		check(
			"computer_destruction_found_check",
			sql`${table.providerComputerId} is not null or ${table.creationId} is not null`,
		),
	],
);

/** The label a computer is made with, whose value is its creation's id. */
export const CREATION_LABEL = "sugabots.creation";

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
		addedById: uuid("added_by_id").references(() => member.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [compositePrimaryKey({ columns: [table.workspaceId, table.host] })],
);

/**
 * A host one project's computer may reach, beyond what the workspace lets
 * every computer reach. Added in the project's settings, or by approving a
 * request for it from one of its bots.
 */
export const projectAllowedHost = pgTable(
	"project_allowed_host",
	{
		workspaceId: uuid("workspace_id").notNull(),
		projectId: uuid("project_id").notNull(),
		host: text("host").notNull(),
		addedById: uuid("added_by_id").references(() => member.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.projectId, table.host] }),
		foreignKey({
			columns: [table.projectId, table.workspaceId],
			foreignColumns: [project.id, project.workspaceId],
			name: "project_allowed_host_project_workspace_fkey",
		}).onDelete("cascade"),
	],
);

/**
 * A host no computer in the workspace may reach, whatever the workspace or a
 * project allows: blocking it takes it, and any wildcard that covers it, out of
 * every project's allowed hosts, and bots' requests for it are refused.
 */
export const blockedHost = pgTable(
	"blocked_host",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		host: text("host").notNull(),
		blockedById: uuid("blocked_by_id").references(() => member.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [compositePrimaryKey({ columns: [table.workspaceId, table.host] })],
);
