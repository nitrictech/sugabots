import { ResourceHidden } from "@sugabots/contracts/errors/proofs";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	seedBot,
	seedMember,
	seedPage,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "../authentication/seed.test-support.ts";
import { pageAddressForTests } from "../authentication/testing.ts";
import { project, workspace } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { named } from "./proof.ts";
import { proveReachesPage } from "./reaches-page.ts";

describe("proveReachesPage", () => {
	let workspaceId: string;
	let projectId: string;
	let fileId: string;

	beforeEach(async () => {
		workspaceId = await seedWorkspace();
		const memberId = await seedMember(workspaceId, "editor");
		const lead = await seedBot(workspaceId);
		projectId = await seedProject(workspaceId, { leadBotId: lead.id, members: [memberId] });
		const chatId = await seedProjectChat(workspaceId, projectId, memberId);
		fileId = await seedPage(chatId);
	});

	afterAll(closeDatabase);

	it("refuses an address once its project or workspace starts deleting", async () => {
		const address = pageAddressForTests({
			workspace: workspaceId,
			file: fileId,
			version: 1,
			expiresAt: 60_000,
		});
		const reach = () =>
			runOnPostgres(
				named(address, fileId, (principal, file) =>
					Effect.map(proveReachesPage(principal, file), (proof) => proof.version),
				).pipe(Effect.provide(TestClock.layer())),
			);

		expect(await reach()).toBe(1);
		await onDatabase((db) =>
			db.update(project).set({ deleting: true }).where(eq(project.id, projectId)),
		);
		await expect(reach()).rejects.toBeInstanceOf(ResourceHidden);
		await onDatabase((db) =>
			db.update(project).set({ deleting: false }).where(eq(project.id, projectId)),
		);
		await onDatabase((db) =>
			db.update(workspace).set({ deleting: true }).where(eq(workspace.id, workspaceId)),
		);
		await expect(reach()).rejects.toBeInstanceOf(ResourceHidden);
	});

	it("refuses a previously authenticated address at its expiry", async () => {
		const address = pageAddressForTests({
			workspace: workspaceId,
			file: fileId,
			version: 1,
			expiresAt: 60_000,
		});
		await expect(
			runOnPostgres(
				Effect.gen(function* () {
					yield* TestClock.setTime(address.expiresAt);
					return yield* named(address, fileId, (principal, file) =>
						Effect.map(proveReachesPage(principal, file), (proof) => proof.version),
					);
				}).pipe(Effect.provide(TestClock.layer())),
			),
		).rejects.toBeInstanceOf(ResourceHidden);
	});
});
