import type {
	AutomationRunNotifications,
	NotificationContent,
	NotificationLevel,
	QuietHours,
} from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	primaryKey as compositePrimaryKey,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { chat, toolCall } from "../chats/sql.ts";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { bot, member, project } from "../workspaces/sql.ts";
import type { NotificationCause } from "./notifications.ts";

const notificationLevel = (name: string) => text(name).$type<NotificationLevel>();

const levelIsValid = (name: string, column: Parameters<typeof sql>[1]) =>
	check(name, sql`${column} in ('all', 'mentions', 'nothing')`);

/** What a member is notified about, once they have chosen. Without a row they get the defaults. */
export const notificationSettings = pgTable(
	"notification_settings",
	{
		memberId: uuid("member_id")
			.primaryKey()
			.references(() => member.id, { onDelete: "cascade" }),
		level: notificationLevel("level").notNull(),
		pausedUntil: timestamp("paused_until", { withTimezone: true }),
		quietHours: jsonb("quiet_hours").$type<QuietHours>(),
		turnFailures: boolean("turn_failures").notNull().default(true),
		automationRuns: text("automation_runs")
			.$type<AutomationRunNotifications>()
			.notNull()
			.default("failures"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		levelIsValid("notification_settings_level_valid", table.level),
		check(
			"notification_settings_automation_runs_valid",
			sql`${table.automationRuns} in ('failures', 'all', 'none')`,
		),
	],
);

/**
 * What a member chose for one project or one bot: a level, in place of the one
 * above it, a mute until `mutedUntil`, or both.
 */
export const notificationOverride = pgTable(
	"notification_override",
	{
		id: primaryKey(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		projectId: uuid("project_id").references(() => project.id, { onDelete: "cascade" }),
		botId: uuid("bot_id").references(() => bot.id, { onDelete: "cascade" }),
		level: notificationLevel("level"),
		mutedUntil: timestamp("muted_until", { withTimezone: true }),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		levelIsValid("notification_override_level_valid", table.level),
		check(
			"notification_override_chooses_something",
			sql`num_nonnulls(${table.level}, ${table.mutedUntil}) > 0`,
		),
		check(
			"notification_override_one_place",
			sql`num_nonnulls(${table.projectId}, ${table.botId}) = 1`,
		),
		uniqueIndex("notification_override_project_idx")
			.on(table.memberId, table.projectId)
			.where(sql`${table.projectId} is not null`),
		uniqueIndex("notification_override_bot_idx")
			.on(table.memberId, table.botId)
			.where(sql`${table.botId} is not null`),
	],
);

/**
 * Each notification sent to a member, once: recording it is what keeps it
 * from going twice, and it is sent once that record commits.
 */
export const notificationDelivery = pgTable(
	"notification_delivery",
	{
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		deliveryId: text("delivery_id").notNull(),
		memberId: uuid("member_id")
			.notNull()
			.references(() => member.id, { onDelete: "cascade" }),
		notification: jsonb("notification").$type<NotificationContent>().notNull(),
		/**
		 * The call waiting for approval that this notification asks the member
		 * to decide; null for any other notification. Whether they may still be
		 * told it depends on whether they can still decide it.
		 */
		approvalCallId: uuid("approval_call_id").references(() => toolCall.id, {
			onDelete: "cascade",
		}),
		createdAt: stamp("created_at"),
		/** When it went to the member's tabs; null until then, so one that didn't is sent again. */
		sentAt: timestamp("sent_at", { withTimezone: true }),
		/**
		 * Until when the sweep sending it again has it to itself: one whose
		 * sweep stopped, or failed to publish it, is sent again once this passes.
		 */
		claimedUntil: timestamp("claimed_until", { withTimezone: true }),
	},
	(table) => [
		compositePrimaryKey({ columns: [table.chatId, table.deliveryId, table.memberId] }),
		index("notification_delivery_unsent_idx")
			.on(table.createdAt)
			.where(sql`${table.sentAt} is null`),
	],
);

/**
 * A chat event's notifications, not yet all sent: written in the transaction
 * of the change that causes them, so a process that stops after it commits
 * leaves them to be sent, and deleted once they have been. `cause` is what
 * the event says about whom to notify.
 */
export const pendingNotification = pgTable(
	"pending_notification",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		deliveryId: text("delivery_id").notNull(),
		cause: jsonb("cause").$type<NotificationCause>().notNull(),
		createdAt: stamp("created_at"),
		/** When the sweep next sends it: once whoever wrote it has had time to, then after each try. */
		dueAt: stamp("due_at"),
	},
	(table) => [index("pending_notification_due_idx").on(table.dueAt, table.id)],
);
