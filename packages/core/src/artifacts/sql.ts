import type { ArtifactKind } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { thread } from "../conversations/sql.ts";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { agent, pod, workspace } from "../workspaces/sql.ts";

/**
 * Something an agent made for a pod to keep: a document or an HTML page.
 * Its content is in `artifact_version`; `currentVersion` is the number of the
 * latest one, and a write names the version it started from so a stale write
 * is refused rather than overwriting a newer one.
 */
export const artifact = pgTable(
	"artifact",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspace.id, { onDelete: "cascade" }),
		podId: uuid("pod_id").notNull(),
		kind: text("kind").$type<ArtifactKind>().notNull(),
		title: text("title").notNull(),
		currentVersion: integer("current_version").notNull().default(1),
		// Kept when the agent or thread goes, so the artifact survives them.
		createdByAgentId: uuid("created_by_agent_id").references(() => agent.id, {
			onDelete: "set null",
		}),
		createdInThreadId: uuid("created_in_thread_id").references(() => thread.id, {
			onDelete: "set null",
		}),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check("artifact_kind_valid", sql`${table.kind} in ('document', 'html')`),
		foreignKey({
			columns: [table.podId, table.workspaceId],
			foreignColumns: [pod.id, pod.workspaceId],
			name: "artifact_pod_workspace_fkey",
		}).onDelete("cascade"),
		index("artifact_pod_updated_at_idx").on(table.podId, table.updatedAt),
	],
);

export type ArtifactRow = typeof artifact.$inferSelect;

/** One version of an artifact's content, numbered from 1. */
export const artifactVersion = pgTable(
	"artifact_version",
	{
		id: primaryKey(),
		artifactId: uuid("artifact_id")
			.notNull()
			.references(() => artifact.id, { onDelete: "cascade" }),
		number: integer("number").notNull(),
		content: text("content").notNull(),
		authorAgentId: uuid("author_agent_id").references(() => agent.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [uniqueIndex("artifact_version_number_idx").on(table.artifactId, table.number)],
);

export type ArtifactVersionRow = typeof artifactVersion.$inferSelect;
