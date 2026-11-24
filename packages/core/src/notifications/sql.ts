import type {
	AutomationRunNotifications,
	NotificationLevel,
	QuietHours,
} from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKey, updatedStamp } from "../database/sql.ts";
import { bot, member, project } from "../workspaces/sql.ts";

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
