import type { TurnModel } from "@sugabots/core/conversations/turns/model";
import { testAuthorization } from "@sugabots/core/workspaces/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const user = {
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
};

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer admin-token" ? user : null;

const asRole = (role: "admin" | "member") =>
	testAuthorization({ id: WORKSPACE, roles: { [user.id]: role } });

const answering = (text: string): TurnModel => ({
	stream: () =>
		Effect.succeed({
			text: (async function* () {
				yield text;
			})(),
			accounting: Effect.succeed({ usage: {} }),
		}),
});

const trial = (app: ReturnType<typeof createTestApp>, body: unknown) =>
	app.request(`/workspaces/${WORKSPACE}/model-trials`, {
		method: "POST",
		headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("trying a model on a system agent", () => {
	it("reports how often the model did what the system agent needs", async () => {
		const app = createTestApp({
			resolveUser,
			authorization: asRole("admin"),
			model: answering("nobody"),
		});

		const response = await trial(app, {
			systemAgentKey: "facilitate",
			model: "llama3.2:3b",
		});

		expect(response.status).toBe(200);
		const report = (await response.json()) as { rating: string; cases: unknown[] };
		// Always answering nobody passes the two "stay quiet" cases and fails the
		// three that need an agent: two in five, which is terrible — a facilitator
		// that never routes is no more useful than one that never stops.
		expect(report.rating).toBe("terrible");
		expect(report.cases).toHaveLength(6);
	});

	it("refuses a member, since choosing a system agent's model is an admin's decision", async () => {
		const app = createTestApp({
			resolveUser,
			authorization: asRole("member"),
			model: answering("nobody"),
		});

		expect((await trial(app, { systemAgentKey: "facilitate", model: "llama3.2:3b" })).status).toBe(
			403,
		);
	});

	it("refuses a system agent it does not have cases for", async () => {
		const app = createTestApp({
			resolveUser,
			authorization: asRole("admin"),
			model: answering("nobody"),
		});

		expect((await trial(app, { systemAgentKey: "handwriting", model: "llama3.2:3b" })).status).toBe(
			400,
		);
	});
});
