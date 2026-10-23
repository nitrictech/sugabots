import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import type { DeviceToServer, ServerToDevice } from "@sugabots/contracts";
import { DeviceLinks } from "@sugabots/core/devices/device-links";
import { Devices } from "@sugabots/core/devices/devices";
import { unimplemented } from "@sugabots/core/testing";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testRoutes } from "./app.test-support.ts";

/**
 * A device's link, served on a real port: a stand-in desktop dials in with
 * its token, and requests made through `fetchThrough` reach it and come back
 * streamed.
 */
const DEVICE_ID = "0199a3a0-0000-7000-8000-0000000000d1";
const TOKEN = "device-token";
const AGENT = {
	url: "http://agent.agents.invalid",
	name: "Claude Code in notes",
	description: null,
	workingDirectory: "/home/sam/notes",
};
const LENDS = {
	lent: [AGENT],
	installed: [{ kind: "claude-code" as const, name: "Claude Code", version: "2.1.300" }],
};

const links = Effect.runSync(DeviceLinks.make);
const scope = Effect.runSync(Scope.make());
let port: number;

beforeAll(async () => {
	const routes = testRoutes(
		Layer.mergeAll(
			Layer.succeed(DeviceLinks.Service, links),
			unimplemented(Devices.Service, {
				authenticate: (token) =>
					Effect.succeed(
						token === TOKEN
							? {
									id: DEVICE_ID,
									ownerId: "0199a3a0-0000-7000-8000-0000000000ff",
									name: "Laptop",
									tokenDigest: "",
									createdAt: new Date(),
								}
							: undefined,
					),
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

/** A stand-in desktop: connects with `token`, is told which device it is, lends {@link AGENT}, and records what it's sent after that. */
async function connectDevice(token = TOKEN) {
	const received: ServerToDevice[] = [];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/devices/link`, {
		headers: { authorization: `Bearer ${token}` },
	} as unknown as string[]);
	socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
	await new Promise<void>((resolve, reject) => {
		socket.onopen = () => resolve();
		socket.onerror = () => reject(new Error("The device couldn't connect"));
	});
	await until(() => received.length > 0);
	expect(received.shift()).toEqual({ type: "hello", deviceId: DEVICE_ID });
	const send = (message: DeviceToServer) => socket.send(JSON.stringify(message));
	send({ type: "agents", agents: LENDS });
	await until(() => links.agents(DEVICE_ID)?.lent.length === 1);
	return { socket, received, send };
}

async function until(condition: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting");
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("a device's link", () => {
	it("refuses a desktop without a paired device's token", async () => {
		const response = await fetch(`http://127.0.0.1:${port}/api/devices/link`, {
			headers: { authorization: "Bearer someone-else" },
		});
		expect(response.status).toBe(401);
	});

	it("carries a request to the device and streams its response back", async () => {
		const device = await connectDevice();
		expect(links.agents(DEVICE_ID)).toEqual(LENDS);

		const answered = links.fetchThrough(DEVICE_ID)(`${AGENT.url}/a2a`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"hello":true}',
		});
		await until(() => device.received.length > 0);
		const [request] = device.received;
		if (request?.type !== "request") throw new Error("Expected a request");
		expect(request).toMatchObject({ method: "POST", url: `${AGENT.url}/a2a` });
		expect(Buffer.from(request.body ?? "", "base64").toString()).toBe('{"hello":true}');

		device.send({
			type: "response",
			id: request.id,
			status: 200,
			headers: [["content-type", "text/event-stream"]],
		});
		const response = await answered;
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		device.send({ type: "body", id: request.id, chunk: base64("data: one\n\n") });
		expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: one\n\n");
		device.send({ type: "body", id: request.id, chunk: base64("data: two\n\n") });
		device.send({ type: "end", id: request.id });
		expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: two\n\n");
		expect((await reader?.read())?.done).toBe(true);
		device.socket.close();
	});

	it("tells the device when a request is called off", async () => {
		const device = await connectDevice();
		const aborts = new AbortController();
		const answered = links.fetchThrough(DEVICE_ID)(`${AGENT.url}/a2a`, { signal: aborts.signal });
		await until(() => device.received.length > 0);
		aborts.abort();
		await expect(answered).rejects.toThrow();
		await until(() => device.received.some(({ type }) => type === "cancel"));
		device.socket.close();
	});

	it("fails what's in flight when the device goes, and stops lending its agents", async () => {
		const device = await connectDevice();
		const answered = links.fetchThrough(DEVICE_ID)(`${AGENT.url}/a2a`);
		await until(() => device.received.length > 0);
		device.socket.close();
		await expect(answered).rejects.toThrow("The device disconnected");
		await until(() => links.agents(DEVICE_ID) === undefined);
		await expect(links.fetchThrough(DEVICE_ID)(AGENT.url)).rejects.toThrow("isn't connected");
	});

	it("asks the device to lend an agent and waits for its owner's answer", async () => {
		const device = await connectDevice();
		const lent = {
			...AGENT,
			url: "http://second.agents.invalid",
			workingDirectory: "/home/sam/code",
		};
		const answered = Effect.runPromise(Effect.exit(links.lend(DEVICE_ID, "claude-code")));
		await until(() => device.received.some(({ type }) => type === "lend"));
		const asked = device.received.find((message) => message.type === "lend");
		if (asked?.type !== "lend") throw new Error("Expected a lend");
		expect(asked.kind).toBe("claude-code");
		device.send({ type: "lent", id: asked.id, agent: lent });
		expect(await answered).toEqual(Exit.succeed(lent));

		const declined = Effect.runPromise(Effect.flip(links.lend(DEVICE_ID, "claude-code")));
		await until(() => device.received.filter(({ type }) => type === "lend").length === 2);
		const second = device.received.filter((message) => message.type === "lend")[1];
		if (second?.type !== "lend") throw new Error("Expected a lend");
		device.send({ type: "lent", id: second.id, agent: null });
		expect((await declined)._tag).toBe("LendingDeclined");

		const abandoned = Effect.runPromise(Effect.flip(links.lend(DEVICE_ID, "claude-code")));
		await until(() => device.received.filter(({ type }) => type === "lend").length === 3);
		device.socket.close();
		expect((await abandoned)._tag).toBe("DeviceOffline");
		await until(() => links.agents(DEVICE_ID) === undefined);
	});
});
