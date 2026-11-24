import type { InputOf } from "@sugabots/contracts/operations";
import { eq } from "drizzle-orm";
import { Context } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Automations } from "../../chats/automations/automations.ts";
import { anAutomationAdmin } from "../../chats/automations/testing.ts";
import { chatServicesForTests } from "../../chats/testing.ts";
import { EventBus } from "../../database/events/bus.ts";
import { EventStore } from "../../database/events/store.ts";
import { workspace } from "../../database/schema.ts";
import { closeDatabase, onDatabase, type Promised } from "../../database/testing.ts";
import { type CallOperation, servedOperations } from "../../operations/testing.ts";
import { authenticators, principals } from "../../proofs/world.test-support.ts";
import { onPostgresAs } from "../testing.ts";

/** Moving a workspace to another time zone, with its automations' routines, against Postgres. */
describe.skipIf(!process.env.DATABASE_URL)(
	"a workspace's time zone, against Postgres",
	async () => {
		const services = await chatServicesForTests(
			EventBus.inProcess({ store: EventStore.inMemory() }),
		);
		let callOperation: CallOperation;
		let signedIn: ReturnType<typeof principals>;
		let workspaceId: string;
		let ownProjectId: string;
		let timeZones: TimeZonesAs;
		let automations: Promised<Automations.Interface>;

		const atNine = (timezone: string) => ({
			kind: "routine" as const,
			schedule: { repeat: "cron" as const, expression: "0 9 * * *" },
			timezone,
		});

		beforeAll(async () => {
			// The registry takes the time zone service from the chat services, as `index.ts` does.
			callOperation = await servedOperations({ chats: services });
			signedIn = principals(await authenticators());
		});

		afterAll(async () => {
			await closeDatabase();
		});

		/** The time zone operations, called for `memberId` signed in. */
		const timeZonesAs = async (memberId: string) => {
			const principal = await signedIn.member(memberId);
			return {
				get: (input: InputOf<"workspaces.timeZone">) =>
					callOperation(principal, "workspaces.timeZone", input),
				change: (input: InputOf<"workspaces.changeTimeZone">) =>
					callOperation(principal, "workspaces.changeTimeZone", input),
			};
		};
		type TimeZonesAs = Awaited<ReturnType<typeof timeZonesAs>>;

		beforeEach(async () => {
			let memberId: string;
			({ workspaceId, memberId, ownProjectId } = await anAutomationAdmin());
			await onDatabase((db) =>
				db
					.update(workspace)
					.set({ timeZone: "Australia/Sydney" })
					.where(eq(workspace.id, workspaceId)),
			);
			timeZones = await timeZonesAs(memberId);
			automations = onPostgresAs(memberId)(Context.get(services, Automations.Service));
		});

		it("moves the routines in the workspace's zone, and leaves the ones set for another", async () => {
			const local = await automations.create(
				{ projectId: ownProjectId },
				{ name: "Standup", instructions: "Ask.", triggers: [atNine("Australia/Sydney")] },
			);
			const paused = await automations.create(
				{ projectId: ownProjectId },
				{
					name: "Paused standup",
					instructions: "Ask.",
					state: "paused",
					triggers: [atNine("Australia/Sydney")],
				},
			);
			const elsewhere = await automations.create(
				{ projectId: ownProjectId },
				{ name: "London report", instructions: "Report.", triggers: [atNine("Europe/London")] },
			);
			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Australia/Sydney",
				automationsWithRoutines: 2,
			});

			await timeZones.change({ workspace: workspaceId, timeZone: "Asia/Tokyo" });

			expect(await timeZones.get({ workspace: workspaceId })).toEqual({
				timeZone: "Asia/Tokyo",
				automationsWithRoutines: 2,
			});
			const listed = await automations.list({ projectId: ownProjectId });
			const triggersOf = (automationId: string) =>
				listed.find((automation) => automation.id === automationId)?.triggers;
			const moved = triggersOf(local.automation.id);
			expect(moved).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: expect.any(String) }),
			]);
			// Nine in Tokyo is midnight UTC.
			const [trigger] = moved ?? [];
			const nextScheduledAt = trigger?.kind === "routine" ? trigger.nextScheduledAt : null;
			expect(nextScheduledAt && new Date(nextScheduledAt).getUTCHours()).toBe(0);
			expect(triggersOf(paused.automation.id)).toEqual([
				expect.objectContaining({ timezone: "Asia/Tokyo", nextScheduledAt: null }),
			]);
			expect(triggersOf(elsewhere.automation.id)).toEqual([
				expect.objectContaining({ timezone: "Europe/London" }),
			]);
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
