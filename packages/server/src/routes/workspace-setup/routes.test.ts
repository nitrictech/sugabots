import { NotReadyToFinish } from "@sugabots/contracts/errors/workspace";
import { Operations } from "@sugabots/core/operations/registry";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { MemberResolver } from "../../http/app.test-support.ts";
import {
	createTestApp,
	identifiedBy,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

const USER_ID = "0199a3a0-0000-7000-8000-0000000000ff";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const PROJECT_ID = "0199a3a0-0000-7000-8000-000000000002";
const BOT_ID = "0199a3a0-0000-7000-8000-000000000003";

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "good-token"
		? { id: USER_ID, name: "Sam", email: "sam@example.com", image: null }
		: null;

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

const authorization = { ...signedInWith("good-token"), "content-type": "application/json" };

describe("workspace setup routes", () => {
	it("reports resources that do not form a valid setup as a bad request", async () => {
		const response = await app({
			"workspaceSetup.complete": () => Effect.fail(new NotReadyToFinish()),
		}).request("/workspace-setup/complete", {
			method: "POST",
			headers: authorization,
			body: JSON.stringify({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, botId: BOT_ID }),
		});

		expect(response.status).toBe(400);
		const message = "Finish creating your bot first";
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message,
			error: { _tag: "NotReadyToFinish", userMessage: message, isRetryable: false },
		});
	});
});
