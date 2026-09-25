import {
	foreignKey,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { turn } from "../conversations/sql.ts";
import { primaryKey, stamp } from "../database/sql.ts";
import { pod } from "../workspaces/sql.ts";
import type { Isolation } from "./sandbox.ts";

/**
 * A pod's sandbox: the one machine every agent in the pod runs commands in.
 *
 * Made the first time an agent in the pod needs it, and never replaced behind
 * anyone's back: a sandbox the provider no longer has is marked `missing`, and
 * the work that was in it is reported lost rather than silently started over.
 */
export const podSandbox = pgTable(
	"pod_sandbox",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		podId: uuid("pod_id").notNull(),
		/** The `SANDBOX_PROVIDER` that made it, which is the only one that can reach it. */
		provider: text("provider").notNull(),
		/** The provider's own name for the sandbox. */
		providerSandboxId: text("provider_sandbox_id").notNull(),
		status: text("status").$type<PodSandboxStatus>().notNull(),
		/** What the provider declared when the sandbox was made. */
		isolation: text("isolation").$type<Isolation>().notNull(),
		/** When the last lease on it ended, for deciding when it has been idle long enough to pause. */
		lastLeaseEndedAt: timestamp("last_lease_ended_at", { withTimezone: true }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "pod_sandbox_pod_workspace_fkey",
		}).onDelete("cascade"),
		uniqueIndex("pod_sandbox_pod_idx").on(table.podId),
	],
);

export type PodSandboxStatus = "running" | "missing";
export type PodSandboxRow = typeof podSandbox.$inferSelect;

/**
 * A turn using a pod's sandbox. "Is anybody using it" is whether any lease is
 * unexpired, rather than a stored count, so a process that dies holding one
 * only keeps the sandbox busy until the lease runs out.
 */
export const sandboxLease = pgTable(
	"sandbox_lease",
	{
		id: primaryKey(),
		podSandboxId: uuid("pod_sandbox_id")
			.notNull()
			.references(() => podSandbox.id, { onDelete: "cascade" }),
		turnId: uuid("turn_id")
			.notNull()
			.references(() => turn.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [index("sandbox_lease_pod_sandbox_idx").on(table.podSandboxId, table.expiresAt)],
);
