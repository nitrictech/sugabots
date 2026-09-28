import { Agent, Response as UndiciResponse } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClosableEgressHttpClient,
	type ClosableEgressHttpClients,
	createEgressHttpClient,
	createEgressHttpClients,
	type EgressDispatch,
	type EgressOptions,
} from "./egress.ts";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];
const openClients: Array<{ close(): Promise<void> }> = [];

function httpClient(options: EgressOptions): ClosableEgressHttpClient {
	const client = createEgressHttpClient(options);
	openClients.push(client);
	return client;
}

function httpClients(options: EgressOptions): ClosableEgressHttpClients {
	const clients = createEgressHttpClients(options);
	openClients.push(clients);
	return clients;
}

afterEach(async () => {
	await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("provider http client", () => {
	it("resolves the destination and disables redirects", async () => {
		const lookup = vi.fn(publicDns);
		const dispatch = vi.fn(async () => new Response(null, { status: 302 }));
		const client = httpClient({ lookup, fetch: dispatch });

		await expect(client("https://models.example/v1/models")).resolves.toHaveProperty("status", 302);
		expect(lookup).toHaveBeenCalledWith("models.example");
		expect(dispatch).toHaveBeenCalledWith(
			"https://models.example/v1/models",
			expect.objectContaining({ redirect: "manual", dispatcher: expect.any(Agent) }),
		);
	});

	it.each([
		["loopback IPv4", "127.0.0.1", 4],
		["private IPv4", "10.20.30.40", 4],
		["link-local IPv4", "169.254.1.2", 4],
		["reserved IPv4", "192.0.2.1", 4],
		["multicast IPv4", "224.0.0.1", 4],
		["loopback IPv6", "::1", 6],
		["private IPv6", "fd00::1", 6],
		["link-local IPv6", "fe80::1", 6],
		["reserved IPv6", "2001:db8::1", 6],
		["multicast IPv6", "ff02::1", 6],
	])("rejects %s after DNS resolution", async (_label, address, family) => {
		const dispatch = vi.fn<EgressDispatch>();
		const client = httpClient({
			lookup: async () => [{ address, family }],
			fetch: dispatch,
		});

		await expect(client("https://models.example")).rejects.toThrow("private or reserved");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects a hostname when any resolved address is unsafe", async () => {
		const client = httpClient({
			lookup: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
			fetch: vi.fn<EgressDispatch>(),
		});

		await expect(client("https://models.example")).rejects.toThrow("private or reserved");
	});

	it.each([
		["plain HTTP", "http://models.example"],
		["credentials", "https://user:secret@models.example"],
		["fragment", "https://models.example/v1#internal"],
		["another scheme", "ftp://models.example"],
	])("rejects %s by default", async (_label, url) => {
		const client = httpClient({ lookup: publicDns, fetch: vi.fn() });
		await expect(client(url)).rejects.toThrow();
	});

	it("allows an explicitly configured local HTTP gateway", async () => {
		const dispatch = vi.fn<EgressDispatch>(async () => new Response("ok"));
		const client = httpClient({ allowPrivateNetwork: true, fetch: dispatch });

		await client("http://127.0.0.1:11434/v1");
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("pins the validated address set in the dispatcher used by Undici", async () => {
		const dispatcher = new Agent();
		const dispatcherFactory = vi.fn(() => dispatcher);
		const dispatch = vi.fn<EgressDispatch>(async () => new Response("ok"));
		let addresses = [{ address: "93.184.216.34", family: 4 }];
		const client = httpClient({
			lookup: async () => addresses,
			fetch: dispatch,
			dispatcherFactory,
		});

		await client("https://models.example/v1/models");
		addresses = [{ address: "127.0.0.1", family: 4 }];

		expect(dispatcherFactory).toHaveBeenCalledWith("models.example", [
			{ address: "93.184.216.34", family: 4 },
		]);
		expect(dispatch.mock.calls[0]?.[1]?.dispatcher).toBe(dispatcher);
	});

	it("reuses and closes cached dispatchers", async () => {
		const close = vi.fn(async () => {});
		const dispatcher = { close } as unknown as Agent;
		const dispatcherFactory = vi.fn(() => dispatcher);
		const client = httpClient({
			lookup: publicDns,
			fetch: vi.fn(async () => new Response("ok")),
			dispatcherFactory,
		});

		await client("https://models.example/v1/models");
		await client("https://models.example/v1/chat");
		await client.close();

		expect(dispatcherFactory).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("what the client answers with", () => {
	it("is the runtime's own Response, whatever class the dispatcher used, with the final URL kept", async () => {
		const dispatch = vi.fn(
			async () =>
				new UndiciResponse('{"error":"invalid_client"}', {
					status: 401,
					headers: { "content-type": "application/json" },
				}) as unknown as Response,
		);
		const client = httpClient({ lookup: publicDns, fetch: dispatch });

		const answered = await client("https://auth.example/token");

		expect(answered).toBeInstanceOf(Response);
		expect(answered.status).toBe(401);
		expect(answered.headers.get("content-type")).toBe("application/json");
		expect(await answered.json()).toEqual({ error: "invalid_client" });
	});
});

describe("provider http clients", () => {
	const local = { baseUrl: "http://127.0.0.1:11434/v1" };
	const remote = { baseUrl: "https://models.example/v1" };

	it("reaches a private address when the installation allows it", async () => {
		const dispatch = vi.fn<EgressDispatch>(async () => new Response("ok"));
		const clients = httpClients({ allowPrivateNetwork: true, lookup: publicDns, fetch: dispatch });

		await clients.for(local)("http://127.0.0.1:11434/v1/models");

		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("holds every provider to the public-address policy when it does not", async () => {
		const dispatch = vi.fn<EgressDispatch>();
		const clients = httpClients({
			lookup: async () => [{ address: "127.0.0.1", family: 4 }],
			fetch: dispatch,
		});

		await expect(clients.for(local)("http://127.0.0.1:11434/v1/models")).rejects.toThrow();
		await expect(clients.for(remote)("https://models.example/v1/models")).rejects.toThrow(
			"private or reserved",
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each([
		["another origin", "http://169.254.169.254/latest/meta-data"],
		["a sibling path", "http://127.0.0.1:11434/v1x/models"],
		["a path above the base", "http://127.0.0.1:11434/admin"],
	])("refuses to leave the provider's base URL for %s", async (_label, url) => {
		const dispatch = vi.fn<EgressDispatch>();
		const clients = httpClients({ allowPrivateNetwork: true, lookup: publicDns, fetch: dispatch });

		await expect(clients.for(local)(url)).rejects.toThrow("outside the provider's configured URL");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("allows the paths a provider SDK builds under the base URL", async () => {
		const dispatch = vi.fn<EgressDispatch>(async () => new Response("ok"));
		const clients = httpClients({ lookup: publicDns, fetch: dispatch });

		await clients.for(remote)("https://models.example/v1/chat/completions");
		await clients.for(remote)("https://models.example/v1");

		expect(dispatch).toHaveBeenCalledTimes(2);
	});
});
