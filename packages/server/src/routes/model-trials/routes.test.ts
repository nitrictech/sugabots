import { ModelTrials } from "@sugabots/core/conversations/model-trials/model-trials";
import { unimplemented } from "@sugabots/core/testing";
import { ActionForbidden } from "@sugabots/core/workspaces/access";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp } from "../../http/app.test-support.ts";

/**
 * The trial route, over a double of `ModelTrials`. How a model is judged is
 * `model-trials/trial.test.ts`'s.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Ada",
	email: "ada@example.com",
	image: null,
});

const trial = (run: ModelTrials.Interface["run"], body: unknown) =>
	createTestApp({ resolveUser, services: unimplemented(ModelTrials.Service, { run }) }).request(
		`/workspaces/${WORKSPACE}/model-trials`,
		{
			method: "POST",
			headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);

const report = {
	systemAgentKey: "facilitate" as const,
	model: "llama3.2:3b",
	rating: "terrible" as const,
	accuracy: { passed: 0, attempts: 3, share: 0, needed: 0.9, rating: "terrible" as const },
	speed: { typicalMs: 0, slowestMs: 0, budgetMs: 2_000, rating: "excellent" as const },
	cases: [],
	verdict: [],
};

describe("trying a model on a system agent", () => {
	it("tries the model in the workspace in the path, and returns the report", async () => {
		const run = vi.fn<ModelTrials.Interface["run"]>(() => Effect.succeed(report));

		const response = await trial(run, { systemAgentKey: "facilitate", model: "llama3.2:3b" });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ rating: "terrible" });
		expect(run).toHaveBeenCalledWith({
			workspace: WORKSPACE,
			systemAgentKey: "facilitate",
			model: "llama3.2:3b",
		});
	});

	it("answers somebody who may not choose the workspace's models as forbidden", async () => {
		const response = await trial(
			() => Effect.fail(new ActionForbidden({ permission: "workspace.providers.manage" })),
			{ systemAgentKey: "facilitate", model: "llama3.2:3b" },
		);

		expect(response.status).toBe(403);
	});

	it("refuses a system agent it does not have cases for", async () => {
		const run = vi.fn<ModelTrials.Interface["run"]>(() => Effect.succeed(report));

		const response = await trial(run, { systemAgentKey: "handwriting", model: "llama3.2:3b" });

		expect(response.status).toBe(400);
		expect(run).not.toHaveBeenCalled();
	});
});
