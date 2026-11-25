import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { apiAnswers, mount, prefersReducedMotion } from "@/api.test-support.tsx";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

type TransitionRequest = { update: () => Promise<void>; types: string[] } | (() => Promise<void>);

/**
 * A browser that runs view transitions and can tell their types, which jsdom
 * cannot: each transition started is recorded, and its update applied at once.
 */
function recordViewTransitions() {
	const started = vi.fn((request: TransitionRequest) => {
		const update = typeof request === "function" ? request : request.update;
		return { updateCallbackDone: update(), ready: Promise.resolve(), finished: Promise.resolve() };
	});
	Object.defineProperty(document, "startViewTransition", { configurable: true, value: started });
	vi.stubGlobal("CSS", { supports: () => true });
	onTestFinished(() => {
		Reflect.deleteProperty(document, "startViewTransition");
		vi.unstubAllGlobals();
	});
	return started;
}

beforeEach(() => {
	apiAnswers();
});

describe("moving between pages on a phone", () => {
	it("slides a page further in over the one it was opened from", async () => {
		const started = recordViewTransitions();
		const { router } = mount("/suga/settings");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({
			to: "/$workspace/settings/$section",
			params: { workspace: "suga", section: "account" },
		});

		expect(started).toHaveBeenCalledWith(expect.objectContaining({ types: ["forward"] }));
	});

	it("starts no transition for somebody who asks for reduced motion", async () => {
		const started = recordViewTransitions();
		prefersReducedMotion();
		const { router } = mount("/suga/settings");
		await waitFor(() => expect(router.state.status).toBe("idle"));

		await router.navigate({
			to: "/$workspace/settings/$section",
			params: { workspace: "suga", section: "account" },
		});

		expect(router.state.location.pathname).toBe("/suga/settings/account");
		expect(started).not.toHaveBeenCalled();
	});
});
