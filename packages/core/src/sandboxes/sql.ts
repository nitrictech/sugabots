import type { SandboxProviderPresetId } from "@sugabots/contracts";
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
import type { Sandboxes } from "./sandboxes.ts";

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
		preset: text("preset").$type<SandboxProviderPresetId>().notNull(),
		/** OpenSandbox's server, or E2B Embed's API; null for E2B Cloud. */
		baseUrl: text("base_url"),
		/** E2B Embed's address for reaching sandboxes; null otherwise. */
		sandboxUrl: text("sandbox_url"),
		/**
		 * The image or template sandboxes are made from; null follows the
		 * preset's default, so a new default reaches every provider not set to
		 * something else.
		 */
		image: text("image"),
		enabled: boolean("enabled").notNull().default(false),
		apiKeyEncrypted: text("api_key_encrypted"),
		/** The last build of its template that Sugabots started, for a provider that builds them (E2B). */
		templateBuild: jsonb("template_build").$type<Sandboxes.TemplateBuild>(),
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
		 * The provider that made it. A provider is removed only after its
		 * sandboxes are destroyed, so this never points at nothing.
		 */
		sandboxProviderId: uuid("sandbox_provider_id").notNull(),
		/** The provider's own id for it. */
		providerSandboxId: text("provider_sandbox_id").$type<Sandboxes.SandboxId>().notNull(),
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
		}),
		uniqueIndex("sandbox_pod_id_idx").on(table.podId),
	],
);

export type SandboxRow = typeof sandbox.$inferSelect;

/**
 * A turn using a sandbox, which keeps it from being paused. The turn renews
 * it while it runs and deletes it when it ends; one left behind by a process
 * that stopped simply expires.
 */
export const sandboxLease = pgTable(
	"sandbox_lease",
	{
		sandboxId: uuid("sandbox_id")
			.notNull()
			.references(() => sandbox.id, { onDelete: "cascade" }),
		/** The turn holding it. */
		holder: text("holder").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [compositePrimaryKey({ columns: [table.sandboxId, table.holder] })],
);

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
