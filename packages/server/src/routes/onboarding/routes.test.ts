import { unimplemented } from "@sugabots/core/testing";
import { Onboarding } from "@sugabots/core/workspaces/onboarding/onboarding";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { UserResolver } from "../../http/app.test-support.ts";
import { createTestApp, identifiedBy } from "../../http/app.test-support.ts";

const USER_ID = "0199a3a0-0000-7000-8000-0000000000ff";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const POD_ID = "0199a3a0-0000-7000-8000-000000000002";
const AGENT_ID = "0199a3a0-0000-7000-8000-000000000003";

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

const app = (onboarding: Partial<Onboarding.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(Onboarding.Service, onboarding)),
	);

const authorization = { authorization: "Bearer good-token", "content-type": "application/json" };

describe("onboarding routes", () => {
	it("reports resources that do not form a valid setup as a bad request", async () => {
		const response = await app({
			complete: () => Effect.fail(new Onboarding.NotReadyToFinish()),
		}).request("/onboarding/complete", {
			method: "POST",
			headers: authorization,
			body: JSON.stringify({ workspaceId: WORKSPACE_ID, podId: POD_ID, agentId: AGENT_ID }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: "Finish creating your pod and agent first",
		});
	});
});
