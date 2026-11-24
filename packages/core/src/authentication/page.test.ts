import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { file } from "../database/schema.ts";
import { closeDatabase, onDatabase, runOnPostgres } from "../database/testing.ts";
import { FilePages } from "../files/pages.ts";
import { Secrets } from "../secrets/secrets.ts";
import { PageAuthentication } from "./page.ts";
import {
	seedBot,
	seedMember,
	seedPage,
	seedProject,
	seedProjectChat,
	seedWorkspace,
} from "./seed.test-support.ts";

describe("PageAuthentication", () => {
	let auth: PageAuthentication.Interface;
	let secrets: Secrets.Interface;
	let workspaceId: string;
	let chatId: string;

	beforeAll(async () => {
		auth = await runOnPostgres(
			Effect.provide(PageAuthentication.Service, PageAuthentication.layer),
		);
		secrets = await runOnPostgres(
			Effect.gen(function* () {
				return yield* Secrets.Service;
			}),
		);
		workspaceId = await seedWorkspace();
		const memberId = await seedMember(workspaceId, "editor");
		const lead = await seedBot(workspaceId);
		const projectId = await seedProject(workspaceId, { leadBotId: lead.id, members: [memberId] });
		chatId = await seedProjectChat(workspaceId, projectId, memberId);
	});

	afterAll(async () => {
		await closeDatabase();
	});

	/** A page address's token, as `FilePages.address` makes one. */
	const tokenFor = (
		address: { fileId: string; version: number; expiresAt: number },
		purpose: string = FilePages.SECRET_PURPOSE,
	) => secrets.encrypt(JSON.stringify(address), purpose);

	const inTenMinutes = () => Date.now() + 10 * 60 * 1000;

	it("opens the version of the page its address names, in the page's workspace", async () => {
		const pageId = await seedPage(chatId, 2);

		const principal = await runOnPostgres(
			auth.open(tokenFor({ fileId: pageId, version: 1, expiresAt: inTenMinutes() })),
		);

		expect(principal._tag).toBe("PageAddress");
		expect(principal.workspace).toBe(workspaceId);
		expect(principal.file).toBe(pageId);
		expect(principal.version).toBe(1);
	});

	it("refuses an expired address, and one naming a version the page doesn't have", async () => {
		const pageId = await seedPage(chatId, 2);

		for (const address of [
			{ fileId: pageId, version: 1, expiresAt: Date.now() - 1000 },
			{ fileId: pageId, version: 3, expiresAt: inTenMinutes() },
			{ fileId: pageId, version: 0, expiresAt: inTenMinutes() },
		]) {
			await expect(runOnPostgres(auth.open(tokenFor(address)))).rejects.toBeInstanceOf(
				PageAuthentication.PageAddressUnavailable,
			);
		}
	});

	it("refuses a token that was tampered with or encrypted for another use", async () => {
		const pageId = await seedPage(chatId);
		const good = tokenFor({ fileId: pageId, version: 1, expiresAt: inTenMinutes() });

		for (const token of [
			`${good.slice(0, -2)}xx`,
			"not a token",
			tokenFor({ fileId: pageId, version: 1, expiresAt: inTenMinutes() }, "webhook-secret"),
			secrets.encrypt("not json", FilePages.SECRET_PURPOSE),
		]) {
			await expect(runOnPostgres(auth.open(token))).rejects.toBeInstanceOf(
				PageAuthentication.PageAddressUnavailable,
			);
		}
	});

	it("refuses an address once its page is no HTML page, or is gone", async () => {
		const markdownId = await seedPage(chatId);
		await onDatabase((db) =>
			db.update(file).set({ kind: "markdown" }).where(eq(file.id, markdownId)),
		);
		const goneId = await seedPage(chatId);
		await onDatabase((db) => db.delete(file).where(eq(file.id, goneId)));

		for (const fileId of [markdownId, goneId]) {
			await expect(
				runOnPostgres(auth.open(tokenFor({ fileId, version: 1, expiresAt: inTenMinutes() }))),
			).rejects.toBeInstanceOf(PageAuthentication.PageAddressUnavailable);
		}
	});
});
