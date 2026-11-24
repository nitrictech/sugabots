import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, runOnPostgres } from "../database/testing.ts";
import { encryptAppCredential } from "../providers/connectors/github/credential.ts";
import { Secrets } from "../secrets/secrets.ts";
import {
	seedAutomation,
	seedBot,
	seedConnector,
	seedProject,
	seedWebhookTrigger,
	seedWorkspace,
} from "./seed.test-support.ts";
import { WebhookAuthentication } from "./webhook.ts";

describe("WebhookAuthentication", () => {
	let auth: WebhookAuthentication.Interface;
	let secrets: Secrets.Interface;
	let workspaceId: string;
	let projectId: string;

	beforeAll(async () => {
		auth = await runOnPostgres(
			Effect.provide(WebhookAuthentication.Service, WebhookAuthentication.layer),
		);
		secrets = await runOnPostgres(
			Effect.gen(function* () {
				return yield* Secrets.Service;
			}),
		);
		workspaceId = await seedWorkspace();
		const lead = await seedBot(workspaceId);
		projectId = await seedProject(workspaceId, { leadBotId: lead.id });
	});

	afterAll(async () => {
		await closeDatabase();
	});

	const delivery = (headers: Record<string, string>) => ({
		headers,
		body: new TextEncoder().encode("{}"),
		payload: {},
	});

	describe("a trigger's webhook", () => {
		it("accepts a call that sends the trigger's secret, reaching only its automation", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				secrets.encrypt("whk_secret"),
			);

			const principal = await runOnPostgres(
				auth.trigger(triggerId, delivery({ authorization: "Bearer whk_secret" })),
			);

			expect(principal._tag).toBe("WebhookCall");
			expect(principal.workspace).toBe(workspaceId);
			expect(principal.source).toEqual({
				kind: "trigger",
				trigger: triggerId,
				automation: automationId,
				project: projectId,
			});
		});

		it("refuses a call with the wrong secret, and one to no trigger, alike", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				secrets.encrypt("whk_secret"),
			);

			for (const [id, headers] of [
				[triggerId, { authorization: "Bearer whk_guess" }],
				[triggerId, {}],
				[crypto.randomUUID(), { authorization: "Bearer whk_secret" }],
				["not-an-id", { authorization: "Bearer whk_secret" }],
			] as const) {
				await expect(runOnPostgres(auth.trigger(id, delivery(headers)))).rejects.toBeInstanceOf(
					WebhookAuthentication.WebhookRefused,
				);
			}
		});

		it("accepts any call to a webhook left without a secret", async () => {
			const automationId = await seedAutomation(workspaceId, projectId);
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				null,
			);

			const principal = await runOnPostgres(auth.trigger(triggerId, delivery({})));

			expect(principal.source).toMatchObject({ kind: "trigger", trigger: triggerId });
		});

		it("authenticates a paused automation's call, leaving whether it runs to the operation", async () => {
			const automationId = await seedAutomation(workspaceId, projectId, { state: "paused" });
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				null,
			);

			const principal = await runOnPostgres(auth.trigger(triggerId, delivery({})));

			expect(principal.source).toMatchObject({ automation: automationId });
		});

		it("refuses a call to a deleted automation's webhook", async () => {
			const automationId = await seedAutomation(workspaceId, projectId, { deleted: true });
			const triggerId = await seedWebhookTrigger(
				automationId,
				workspaceId,
				{ kind: "bearer" },
				null,
			);

			await expect(runOnPostgres(auth.trigger(triggerId, delivery({})))).rejects.toBeInstanceOf(
				WebhookAuthentication.WebhookRefused,
			);
		});
	});

	describe("a project's GitHub app", () => {
		const signed = (secret: string, body: string) => ({
			headers: {
				"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
			},
			body,
		});

		it("accepts a delivery signed with the app's webhook secret, reaching only its project", async () => {
			const connectorId = await seedConnector(workspaceId, projectId, {
				github: {
					appCredentialEncrypted: encryptAppCredential(secrets, {
						privateKey: "key",
						webhookSecret: "github-secret",
					}),
				},
			});

			const principal = await runOnPostgres(
				auth.github(connectorId, signed("github-secret", '{"zen":"hi"}')),
			);

			expect(principal.workspace).toBe(workspaceId);
			expect(principal.source).toEqual({
				kind: "github",
				connector: connectorId,
				project: projectId,
			});
		});

		it("refuses a delivery signed with another secret, or to a connector that isn't a GitHub app", async () => {
			const otherProject = await seedProject(workspaceId, {
				leadBotId: (await seedBot(workspaceId)).id,
			});
			const app = await seedConnector(workspaceId, otherProject, {
				github: {
					appCredentialEncrypted: encryptAppCredential(secrets, {
						privateKey: "key",
						webhookSecret: "github-secret",
					}),
				},
			});
			const server = await seedConnector(workspaceId, otherProject);
			const withoutWebhook = await seedConnector(
				workspaceId,
				await seedProject(workspaceId, { leadBotId: (await seedBot(workspaceId)).id }),
				{
					github: {
						appCredentialEncrypted: encryptAppCredential(secrets, {
							privateKey: "key",
							webhookSecret: null,
						}),
					},
				},
			);

			for (const [id, secret] of [
				[app, "another-secret"],
				[server, "github-secret"],
				[withoutWebhook, "github-secret"],
				[crypto.randomUUID(), "github-secret"],
			] as const) {
				await expect(runOnPostgres(auth.github(id, signed(secret, "{}")))).rejects.toBeInstanceOf(
					WebhookAuthentication.WebhookRefused,
				);
			}
		});
	});
});
