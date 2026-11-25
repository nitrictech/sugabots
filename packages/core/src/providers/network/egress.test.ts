import diagnosticsChannel from "node:diagnostics_channel";
import type { Socket } from "node:net";
import { Effect } from "effect";
import { Agent, type Dispatcher, Response as UndiciResponse } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClosableEgressHttpClient,
	type ClosableEgressHttpClients,
	createEgressHttpClient,
	createEgressHttpClients,
	createProviderWebSocket,
	type EgressDispatch,
	type EgressOptions,
	EgressRefused,
} from "./egress.ts";

/** Node's diagnostics channel for each TCP client socket made, TLS ones included. */
const NEW_CLIENT_SOCKET = "net.client.socket";
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
		["reserved IPv4", "192.0.2.1", 4],
		["multicast IPv4", "224.0.0.1", 4],
		["loopback IPv6", "::1", 6],
		["private IPv6", "fd00::1", 6],
		["reserved IPv6", "2001:db8::1", 6],
		["multicast IPv6", "ff02::1", 6],
	])("rejects %s after DNS resolution", async (_label, address, family) => {
		const dispatch = vi.fn<EgressDispatch>();
		const client = httpClient({
			lookup: async () => [{ address, family }],
			fetch: dispatch,
		});

		await expect(client("https://models.example")).rejects.toThrow("local or private network");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each([
		["IPv4", "169.254.1.2", 4, "169.254.1.2"],
		["IPv6", "febf::1", 6, "[febf::1]"],
		["IPv4-mapped IPv6", "::ffff:169.254.1.2", 6, "[::ffff:169.254.1.2]"],
		["IPv4-compatible IPv6", "::a9fe:a9fe", 6, "[::a9fe:a9fe]"],
		["NAT64 IPv6", "64:ff9b::a9fe:a9fe", 6, "[64:ff9b::a9fe:a9fe]"],
		["Alibaba Cloud metadata", "100.100.100.200", 4, "100.100.100.200"],
		["AWS IPv6 metadata", "fd00:ec2::254", 6, "[fd00:ec2::254]"],
	])(
		"refuses link-local and cloud metadata %s literals and DNS answers when local access is allowed",
		async (_label, address, family, host) => {
			const dispatch = vi.fn<EgressDispatch>(async () => new Response("ok"));
			const clients = httpClients({
				allowPrivateNetwork: true,
				lookup: async () => [
					{ address: "10.20.30.40", family: 4 },
					{ address, family },
				],
				fetch: dispatch,
			});
			const refusal = new EgressRefused({ reason: "linkLocal" });
			for (const target of [`http://${host}`, "http://models.example"]) {
				await expect(clients.for({ baseUrl: target })(target)).rejects.toMatchObject({
					userMessage: refusal.userMessage,
				});
			}
			expect(dispatch).not.toHaveBeenCalled();
		},
	);

	it("rejects a hostname when any resolved address is unsafe", async () => {
		const client = httpClient({
			lookup: async () => [
				{ address: "93.184.216.34", family: 4 },
				{ address: "127.0.0.1", family: 4 },
			],
			fetch: vi.fn<EgressDispatch>(),
		});

		await expect(client("https://models.example")).rejects.toThrow("local or private network");
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
		const client = httpClient({
			allowPrivateNetwork: true,
			lookup: async () => [{ address: "10.20.30.40", family: 4 }],
			fetch: dispatch,
		});

		await client("http://models.example:11434/v1");
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("gives each validated address set of a name its own connection pool, reuses it, and closes it with the client", async () => {
		const dispatchers: Dispatcher[] = [];
		let addresses = [{ address: "93.184.216.34", family: 4 }];
		const client = httpClient({
			lookup: async () => addresses,
			fetch: async (_input, { dispatcher }) => {
				dispatchers.push(dispatcher);
				return new Response("ok");
			},
		});

		await client("https://models.example/v1/models");
		await client("https://models.example/v1/chat");
		addresses = [{ address: "93.184.216.35", family: 4 }];
		await client("https://models.example/v1/chat");
		const [first, again, moved] = dispatchers;
		await client.close();

		expect(again).toBe(first);
		expect(moved).not.toBe(first);
		expect(dispatchers.map((dispatcher) => (dispatcher as Agent).closed)).toEqual([
			true,
			true,
			true,
		]);
	});
});

describe("the address a request connects to", () => {
	interface LookedUp {
		readonly address?: string;
		readonly family?: number;
		readonly error?: string;
	}

	/**
	 * Calls `send`, noting where each connection to `hostname` it makes was
	 * about to go once its socket had looked the host up, and stopping each
	 * there, so nothing is sent to the address.
	 */
	async function connectionsWhile(hostname: string, send: () => Promise<unknown>) {
		const lookedUp: LookedUp[] = [];
		const onSocket = (message: unknown) => {
			const { socket } = message as { socket: Socket };
			// The error the connection is stopped with reaches the request; this keeps it from also going unhandled.
			socket.on("error", () => {});
			socket.once(
				"lookup",
				(error: Error | null, address: string, family: number, host: string) => {
					if (host !== hostname) return;
					lookedUp.push(error ? { error: error.message } : { address, family });
					socket.destroy(new Error("Stopped once its address was known"));
				},
			);
		};
		diagnosticsChannel.subscribe(NEW_CLIENT_SOCKET, onSocket);
		try {
			await expect(send()).rejects.toThrow();
		} finally {
			diagnosticsChannel.unsubscribe(NEW_CLIENT_SOCKET, onSocket);
		}
		return lookedUp;
	}

	it("is the one validated when the request was checked, though the name resolves to a private address by the time it connects", async () => {
		const hostname = "rebinding.example";
		const answers = [
			[{ address: "93.184.216.34", family: 4 }],
			[{ address: "127.0.0.1", family: 4 }],
		];
		const client = httpClient({ lookup: async () => answers.shift() ?? [] });

		const lookedUp = await connectionsWhile(hostname, () =>
			client(`https://${hostname}/v1/models`),
		);

		expect(lookedUp).toEqual([{ address: "93.184.216.34", family: 4 }]);
	});
});

describe("what the client answers with", () => {
	it("is the runtime's own Response, whatever class the dispatcher used, with the final URL kept", async () => {
		const finalUrl = "https://auth.example/token/after-redirect";
		const dispatch = vi.fn(async () => {
			const answered = new UndiciResponse('{"error":"invalid_client"}', {
				status: 401,
				headers: { "content-type": "application/json" },
			});
			Object.defineProperty(answered, "url", { value: finalUrl });
			return answered as Response;
		});
		const client = httpClient({ lookup: publicDns, fetch: dispatch });

		const answered = await client("https://auth.example/token");

		expect(answered).toBeInstanceOf(Response);
		expect(answered.url).toBe(finalUrl);
		expect(answered.status).toBe(401);
		expect(answered.headers.get("content-type")).toBe("application/json");
		expect(await answered.json()).toEqual({ error: "invalid_client" });
	});
});

describe("provider http clients", () => {
	const local = { baseUrl: "http://127.0.0.1:11434/v1" };
	const remote = { baseUrl: "https://models.example/v1" };

	it("reaches a private address when the server allows it", async () => {
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
			"local or private network",
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

		await expect(clients.for(local)(url)).rejects.toThrow("isn't under the configured address");
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

it("refuses a desktop WebSocket before connecting when its address resolves to a private network", async () => {
	const lookup = vi.fn(async () => [{ address: "10.0.0.2", family: 4 }]);
	const connect = vi.fn(() => {
		throw new Error("The connection must be refused before dispatch");
	});
	const open = createProviderWebSocket({ lookup, connect });
	await expect(
		Effect.runPromise(Effect.scoped(open("https://desktop.example", ["binary"], {}))),
	).rejects.toMatchObject({
		userMessage: new EgressRefused({ reason: "privateNetwork" }).userMessage,
	});
	expect(lookup).toHaveBeenCalledExactlyOnceWith("desktop.example");
	expect(connect).not.toHaveBeenCalled();
});
