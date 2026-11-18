import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Automations } from "../../conversations/automations/automations.ts";
import { anAutomationOwner } from "../../conversations/automations/testing.ts";
import { conversationsForTests } from "../../conversations/testing.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../../database/testing.ts";
import { onPostgresAs } from "../testing.ts";
import { WorkspaceTimeZone } from "./workspace-time-zone.ts";

/** Moving a workspace to another time zone, with its automations' schedules, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)(
	"a workspace's time zone, against Postgres",
	async () => {
		const conversations = await conversationsForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		let workspaceId: string;
		let botId: string;
		let timeZones: Promised<WorkspaceTimeZone.Interface>;
		let automations: Promised<Automations.Interface>;

		const atNine = (timezone: string) => ({
			kind: "schedule" as const,
			schedule: { repeat: "cron" as const, expression: "0 9 * * *" },
			timezone,
		});

		afterAll(async () => {
			await closeDatabase();
		});

		beforeEach(async () => {
			let userId: string;
			({ workspaceId, botId, userId } = await anAutomationOwner());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
			timeZones = onPostgresAs(userId)(Context.get(conversations, WorkspaceTimeZone.Service));
			automations = onPostgresAs(userId)(Context.get(conversations, Automations.Service));
		});

		it("moves the schedules in the workspace's zone, and leaves the ones set for another", async () => {
			const local = await automations.create(
				{ botId },
				{ name: "Standup", instructions: "Ask.", triggers: [atNine("Australia/Sydney")] },
			);
			const paused = await automations.create(
				{ botId },
				{
					name: "Paused standup",
					instructions: "Ask.",
					state: "paused",
					triggers: [atNine("Australia/Sydney")],
				},
			);
			const elsewhere = await automations.create(
				{ botId },
				{ name: "London report", instructions: "Report.", triggers: [atNine("Europe/London")] },
			);
			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Australia/Sydney",
				scheduledAutomations: 2,
			});

			await timeZones.change({ workspace: workspaceId, timeZone: "Asia/Tokyo" });

			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Asia/Tokyo",
				scheduledAutomations: 2,
			});
			const moved = await automations.get({ botId, automationId: local.automation.id });
			expect(moved.triggers).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: expect.any(String) }),
			]);
			// Nine in Tokyo is midnight UTC.
			const [trigger] = moved.triggers;
			const nextScheduledAt = trigger?.kind === "schedule" ? trigger.nextScheduledAt : null;
			expect(nextScheduledAt && new Date(nextScheduledAt).getUTCHours()).toBe(0);
			expect(
				(await automations.get({ botId, automationId: paused.automation.id })).triggers,
			).toEqual([expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: null })]);
			expect(
				(await automations.get({ botId, automationId: elsewhere.automation.id })).triggers,
			).toEqual([expect.objectContaining({ timezone: "Europe/London" })]);
		});

		it("refuses a zone the database does not know, and stays where it was", async () => {
			await expect(
				timeZones.change({ workspace: workspaceId, timeZone: "Mars/Olympus" }),
			).rejects.toMatchObject({ _tag: "TimeZoneUnknown" });
			expect(await timeZones.get({ workspace: workspaceId })).toMatchObject({
				timeZone: "Australia/Sydney",
			});
		});
	},
);
