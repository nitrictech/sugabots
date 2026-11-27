import { createServer, request as httpRequest } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { GITHUB_DELIVERY_MAX_BODY_BYTES } from "@sugabots/contracts/http";
import { WebhookAuthentication } from "@sugabots/core/authentication/webhook";
import { Operations } from "@sugabots/core/operations/registry";
import type { WebhookCall } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testRoutes } from "./app.test-support.ts";
import { MAX_JSON_BODY_BYTES } from "./validation.ts";

/**
 * Body limits over Node's own HTTP server, where a request read past its
 * limit could reset its socket before the refusal was sent. Each body is
 * sent chunked, with no length declared, so the limit is found while reading.
 */

const CONNECTOR_ID = "0199a3a0-0000-7000-8000-000000000001";
const signedByTheApp = Object.freeze({ _tag: "WebhookCall" }) as unknown as WebhookCall;
const authenticate = vi.fn<WebhookAuthentication.Interface["github"]>(() =>
	Effect.succeed(signedByTheApp),
);

const scope = Effect.runSync(Scope.make());
let port: number;

beforeAll(async () => {
	const routes = testRoutes(
		Layer.mergeAll(
			unimplemented(WebhookAuthentication.Service, { github: authenticate }),
			unimplemented(Operations.Service, {
				"gitHubWebhooks.delivery": () =>
					Effect.succeed({
						workspaceId: "0199a3a0-0000-7000-8000-000000000002",
						deliveryId: "delivery-1",
						activity: undefined,
					}),
			}),
		),
	);
	port = await Effect.runPromise(
		Effect.gen(function* () {
			const context = yield* Layer.buildWithScope(
				HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
					Layer.provideMerge(NodeHttpServer.layer(createServer, { port: 0 })),
				),
				scope,
			);
			const address = Context.get(context, HttpServer.HttpServer).address;
			return "port" in address ? address.port : 0;
		}).pipe(Effect.orDie) as Effect.Effect<number>,
	);
});

afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));

/** Posts a body of `bytes` bytes to `path` in 64 KiB chunks, and answers the response. */
function postChunked(path: string, bytes: number, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		const sent = httpRequest(
			{ port, path, method: "POST", headers: { "content-type": "application/json", ...headers } },
			(response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk) => {
					body += chunk;
				});
				response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
			},
		);
		sent.on("error", reject);
		const chunk = Buffer.alloc(64 * 1024, "x");
		let left = bytes;
		const write = () => {
			while (left > 0) {
				const piece = left >= chunk.length ? chunk : chunk.subarray(0, left);
				left -= piece.length;
				if (!sent.write(piece)) return void sent.once("drain", write);
			}
			sent.end();
		};
		write();
	});
}

describe("a body sent chunked to Node's server", () => {
	it("is refused with 413 at better-auth's routes", async () => {
		const response = await postChunked("/api/auth/sign-in/email", MAX_JSON_BODY_BYTES + 1);

		expect(response.status).toBe(413);
		expect(JSON.parse(response.body)).toMatchObject({
			_tag: "PayloadTooLarge",
			message: "The request body is over the 64 KiB limit",
		});
	});

	it("reaches a GitHub connector's deliveries whole when it is under the limit", async () => {
		const response = await postChunked(`/api/webhooks/connectors/${CONNECTOR_ID}`, 1024 * 1024, {
			"x-github-event": "push",
			"x-github-delivery": "delivery-1",
			"x-hub-signature-256": "sha256=good",
		});

		expect(response.status).toBe(204);
		expect(authenticate.mock.calls[0]?.[1].body).toBe("x".repeat(1024 * 1024));
	});

	it("is refused with 413 at a GitHub connector's deliveries, before its signature is checked", async () => {
		const response = await postChunked(
			`/api/webhooks/connectors/${CONNECTOR_ID}`,
			GITHUB_DELIVERY_MAX_BODY_BYTES + 1,
		);

		expect(response.status).toBe(413);
		expect(JSON.parse(response.body)).toMatchObject({
			_tag: "PayloadTooLarge",
			message: "The request body is over the 25 MiB limit",
		});
		expect(authenticate).not.toHaveBeenCalled();
	});
});
