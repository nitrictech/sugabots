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
import { pod, user, workspace } from "../workspaces/sql.ts";

/**
 * A sandbox provider a workspace has configured: an account at a service that
 * makes Linux machines. A workspace may have several, but at most one is
 * enabled, and that one makes its pods' sandboxes.
 */
export const sandboxProvider = pgTable(
	"sandbox_provider",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		/** Follows `settings`, so the preset and its settings can't disagree. */
		preset: text("preset")
			.$type<SandboxProviderSettings["preset"]>()
			.generatedAlwaysAs(sql`settings->>'preset'`)
			.notNull(),
		/** What the workspace configured: where the provider is, and what to make sandboxes from. */
		settings: jsonb("settings").$type<SandboxProviderSettings>().notNull(),
		enabled: boolean("enabled").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		/**
		 * What Sugabots made in the provider's account for these settings and
		 * key, such as E2B's template build; null until it makes something, and
		 * again once the settings or key change.
		 */
		managedResources: jsonb("managed_resources").$type<SandboxManagedResources>(),
		lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
		lastTestError: text("last_test_error"),
		createdById: uuid("created_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		uniqueIndex("sandbox_provider_enabled_idx").on(table.workspaceId).where(sql`${table.enabled}`),
		uniqueIndex("sandbox_provider_id_workspace_id_idx").on(table.id, table.workspaceId),
		check("sandbox_provider_preset_check", sql`${table.preset} in ('opensandbox', 'e2b')`),
	],
);

export type SandboxProviderRow = typeof sandboxProvider.$inferSelect;

/**
 * A provider's settings, by preset. A provider may be saved before it has
 * every address it needs; it can't be enabled until it has. An image or
 * template left out follows the preset's default, so a new default reaches
 * every provider not set to something else.
 */
export type SandboxProviderSettings =
	| {
			readonly preset: "opensandbox";
			readonly serverUrl?: string;
			readonly image?: string;
	  }
	| {
			readonly preset: "e2b";
			/** E2B Embed's API and its address for reaching sandboxes; both left out for E2B Cloud. */
			readonly apiUrl?: string;
			readonly sandboxUrl?: string;
			readonly template?: string;
	  };

/** What Sugabots made in a provider's account, by preset. */
export type SandboxManagedResources = {
	readonly preset: "e2b";
	/** The last build of its template that Sugabots started, by E2B's ids for it. */
	readonly templateBuild: { readonly templateId: string; readonly buildId: string };
};

/**
 * A pod's sandbox: the machine its agents run commands on, at the provider
 * that made it. One per pod, made the first time an agent there needs it.
 */
export const sandbox = pgTable(
	"sandbox",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		/**
		 * The provider that made it. Removing a provider destroys its sandboxes
		 * first; the row cascades only so that deleting a workspace, which
		 * reaches it through both the provider and the pod, never fails.
		 */
		sandboxProviderId: uuid("sandbox_provider_id").notNull(),
		/** The provider's own id for it. */
		providerSandboxId: text("provider_sandbox_id").notNull(),
		/** When it was paused for sitting idle; null while it runs. */
		pausedAt: timestamp("paused_at", { withTimezone: true }),
		/** When a turn last let go of it, which is when its idle time starts. */
		lastUsedAt: stamp("last_used_at"),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "sandbox_pod_workspace_fkey",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.sandboxProviderId, table.workspaceId],
			foreignColumns: [sandboxProvider.id, sandboxProvider.workspaceId],
			name: "sandbox_provider_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("sandbox_pod_id_idx").on(table.podId),
	],
);

export type SandboxRow = typeof sandbox.$inferSelect;

/**
 * A turn using a sandbox, or a person viewing its desktop, which keeps it
 * from being paused. The holder renews it while it uses the sandbox and
 * deletes it when done; one left behind by a process that stopped simply
 * expires.
 */
export const sandboxLease = pgTable(
	"sandbox_lease",
	{
		sandboxId: uuid("sandbox_id")
			.notNull()
			.references(() => sandbox.id, { onDelete: "cascade" }),
		/** Only a turn's lease stops a reset or upgrade; a viewer's just keeps the sandbox awake. */
		holderKind: text("holder_kind").$type<SandboxLeaseHolderKind>().notNull(),
		/** The turn's id, or the viewer's connection: one per connection, so closing one tab leaves the others' leases. */
		holderId: text("holder_id").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.sandboxId, table.holderKind, table.holderId] }),
		check("sandbox_lease_holder_kind_check", sql`${table.holderKind} in ('turn', 'viewer')`),
	],
);

export type SandboxLeaseHolderKind = "turn" | "viewer";

/**
 * A host every pod's sandbox in a workspace may reach, beyond the trusted ones
 * every workspace's sandboxes reach. Added in settings by someone who manages
 * the workspace's sandboxes.
 */
export const sandboxAllowedHost = pgTable(
	"sandbox_allowed_host",
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
 * A host one pod's sandbox may reach, beyond what the workspace lets every
 * pod's reach. Added in the pod's settings, or by approving an agent's
 * request there.
 */
export const sandboxPodAllowedHost = pgTable(
	"sandbox_pod_allowed_host",
	{
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		host: text("host").notNull(),
		/** Who added it, or approved the request for it. */
		addedById: uuid("added_by_id").references(() => user.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.podId, table.host] }),
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "sandbox_pod_allowed_host_pod_workspace_fkey",
		}).onDelete("cascade"),
	],
);

/**
 * A host no sandbox in the workspace may reach, whatever the workspace or a
 * pod allows: blocking it takes it, and any wildcard that covers it, out of
 * every pod's allowed hosts, and agents' requests for it are refused.
 */
export const sandboxBlockedHost = pgTable(
	"sandbox_blocked_host",
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
