import type { ArtifactKind } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { thread } from "../conversations/sql.ts";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { agent, workspace } from "../workspaces/sql.ts";

/**
 * A file a bot made, such as a document or an HTML page, in the conversation
 * it was made in, through which it is reached.
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
		kind: text("kind").$type<ArtifactKind>().notNull(),
		title: text("title").notNull(),
		currentVersion: integer("current_version").notNull().default(1),
		// Kept when the bot goes, so the file survives it.
		createdByAgentId: uuid("created_by_agent_id").references(() => agent.id, {
			onDelete: "set null",
		}),
		// The conversation it was made in, which it goes with.
		createdInThreadId: uuid("created_in_thread_id")
			.notNull()
			.references(() => thread.id, { onDelete: "cascade" }),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		check("artifact_kind_valid", sql`${table.kind} in ('document', 'html')`),
		index("artifact_thread_updated_at_idx").on(table.createdInThreadId, table.updatedAt),
	],
);

export type ArtifactRow = typeof artifact.$inferSelect;

/**
 * One version of an artifact, numbered from 1. Its content is in the blob
 * store under `artifacts/<artifactId>/versions/<id>` (see `artifacts.ts`),
 * which the `artifact_blob_deletion` trigger queues for deletion with the
 * artifact.
 */
export const artifactVersion = pgTable(
	"artifact_version",
	{
		id: primaryKey(),
		artifactId: uuid("artifact_id")
			.notNull()
			.references(() => artifact.id, { onDelete: "cascade" }),
		number: integer("number").notNull(),
		contentType: text("content_type").notNull(),
		/** In bytes. */
		size: integer("size").notNull(),
		authorAgentId: uuid("author_agent_id").references(() => agent.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [uniqueIndex("artifact_version_number_idx").on(table.artifactId, table.number)],
);

export type ArtifactVersionRow = typeof artifactVersion.$inferSelect;
