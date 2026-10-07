import { GitHosts } from "@sugabots/core/git-hosts/git-hosts";
import { unimplemented } from "@sugabots/core/testing";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../http/app.test-support.ts";

const GIT_HOST_ID = "0199a3a0-0000-7000-8000-000000000001";

function webhookApp() {
	const delivery = vi.fn<GitHosts.Interface["delivery"]>(({ signature }) =>
		signature === "sha256=good" ? Effect.void : Effect.fail(new GitHosts.DeliveryRefused()),
	);
	return { app: createTestApp(unimplemented(GitHosts.Service, { delivery })), delivery };
}

function deliver(app: ReturnType<typeof webhookApp>["app"], body: string, signature: string) {
	return app.request(`/hooks/git-hosts/${GIT_HOST_ID}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": "pull_request",
			"x-hub-signature-256": signature,
		},
		body,
	});
}

describe("Git host webhooks", () => {
	it("checks the signature against the body exactly as GitHub sent it", async () => {
		const { app, delivery } = webhookApp();
		const body = '{ "action":"opened",  "number": 1 }';

		const response = await deliver(app, body, "sha256=good");

		expect(response.status).toBe(204);
		expect(delivery).toHaveBeenCalledWith({
			gitHostId: GIT_HOST_ID,
			event: "pull_request",
			body,
			signature: "sha256=good",
		});
	});

	it("refuses a delivery whose signature doesn't hold", async () => {
		const { app } = webhookApp();

		const response = await deliver(app, "{}", "sha256=forged");

		expect(response.status).toBe(401);
	});
});
