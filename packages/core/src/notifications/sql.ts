import type { NotificationKind, NotificationSubject } from "@sugabots/contracts";
import {
	boolean,
	foreignKey,
	index,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { user, workspaceMember } from "../workspaces/sql.ts";

/**
 * Something one person was told, in a workspace they belong to. Leaving the
 * workspace takes their notifications with it.
 *
 * `kind` is a copy of `subject.kind`, for choosing by kind without reading the
 * subject. Kinds are not checked here, so adding one needs no migration.
 */
export const notification = pgTable(
	"notification",
	{
		id: primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		userId: uuid("user_id").notNull(),
		kind: text("kind").$type<NotificationKind>().notNull(),
		subject: jsonb("subject").$type<NotificationSubject>().notNull(),
		createdAt: stamp("created_at"),
	},
	(table) => [
		foreignKey({
			columns: [table.workspaceId, table.userId],
			foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
			name: "notification_workspace_member_fkey",
		}).onDelete("cascade"),
		index("notification_user_created_at_idx").on(table.userId, table.createdAt),
	],
);

export type NotificationRow = typeof notification.$inferSelect;

/**
 * Whether a person wants to hear about a kind, in every workspace. Only a
 * choice they made is stored: no row means the kind's `defaultOn`.
 */
export const notificationPreference = pgTable(
	"notification_preference",
	{
		id: primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		kind: text("kind").$type<NotificationKind>().notNull(),
		enabled: boolean("enabled").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("notification_preference_idx").on(table.userId, table.kind)],
);

/**
 * How a person is told, in every workspace. Only a person who changed a
 * setting has a row: no row means `defaultNotificationDelivery`.
 */
export const notificationDelivery = pgTable(
	"notification_delivery",
	{
		id: primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		desktop: boolean("desktop").notNull(),
		quietOnWeekends: boolean("quiet_on_weekends").notNull(),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [uniqueIndex("notification_delivery_user_idx").on(table.userId)],
);
