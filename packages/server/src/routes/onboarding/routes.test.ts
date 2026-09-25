import type { OnboardingStore } from "@sugabots/core/workspaces/onboarding/store";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { SessionResolver } from "../../auth/session.ts";
import { createTestApp } from "../../http/app.test-support.ts";

const USER_ID = "0199a3a0-0000-7000-8000-0000000000ff";
const WORKSPACE_ID = "0199a3a0-0000-7000-8000-000000000001";
const POD_ID = "0199a3a0-0000-7000-8000-000000000002";
const AGENT_ID = "0199a3a0-0000-7000-8000-000000000003";
const INVITATION_ID = "0199a3a0-0000-7000-8000-000000000004";

const resolveSession: SessionResolver = async (headers) =>
	headers.get("authorization") === "Bearer good-token"
		? { user: { id: USER_ID, name: "Sam", email: "sam@example.com", image: null } }
		: null;

/** A store that says nobody has finished, apart from what a case overrides. */
function onboardingStoreWith(overrides: Partial<OnboardingStore> = {}): OnboardingStore {
	return {
		isCompleted: () => Effect.succeed(false),
		complete: () => Effect.succeed(false),
		completeAcceptedInvite: () => Effect.undefined,
		...overrides,
	};
}

const authorization = { authorization: "Bearer good-token", "content-type": "application/json" };

describe("onboarding routes", () => {
	it("does not complete when the resources do not form a valid setup", async () => {
		const app = createTestApp({ resolveSession, stores: { onboarding: onboardingStoreWith() } });

		const response = await app.request("/onboarding/complete", {
			method: "POST",
			headers: authorization,
			body: JSON.stringify({ workspaceId: WORKSPACE_ID, podId: POD_ID, agentId: AGENT_ID }),
		});

		expect(response.status).toBe(400);
	});

	it("returns the workspace belonging to an accepted invitation", async () => {
		const completeAcceptedInvite = vi.fn(() => Effect.succeed(WORKSPACE_ID));
		const app = createTestApp({
			resolveSession,
			stores: { onboarding: onboardingStoreWith({ completeAcceptedInvite }) },
		});

		const response = await app.request("/onboarding/complete-invite", {
			method: "POST",
			headers: authorization,
			body: JSON.stringify({ invitationId: INVITATION_ID }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ workspaceId: WORKSPACE_ID });
		expect(completeAcceptedInvite).toHaveBeenCalledWith(USER_ID, INVITATION_ID);
	});
});
