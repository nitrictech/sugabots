import { Effect, Redacted } from "effect";
import { Agent } from "undici";
import { expect, it, onTestFinished, vi } from "vitest";
import { Ids } from "../../ids/ids.ts";
import {
	createEgressHttpClients,
	createEgressUrlValidator,
	type EgressDispatch,
	EgressRefused,
	urlValidation,
} from "../../providers/network/egress.ts";
import { Computers } from "../computers.ts";
import { fromE2b } from "./e2b.ts";
import { fromOpenSandbox } from "./opensandbox.ts";

const baseUrl = "https://provider.example";
const computerUrl = "https://computer.example";
const privateHostname = "private.example";

const access = {
	apiKey: Redacted.make("test-key"),
	size: { cpuCount: 2, memoryGiB: 4 },
	networkMode: "allowed-hosts-only",
} as const;

function network(dispatch: EgressDispatch) {
	const lookup = vi.fn(async (hostname: string) => [
		{ address: hostname === privateHostname ? "10.0.0.2" : "93.184.216.34", family: 4 },
	]);
	const providers = createEgressHttpClients({ lookup, fetch: dispatch });
	onTestFinished(() => providers.close());
	return {
		lookup,
		providers,
		validateProviderUrl: urlValidation(createEgressUrlValidator({ lookup })),
	};
}

const requestedUrl = (input: Parameters<EgressDispatch>[0]) =>
	new URL(input instanceof Request ? input.url : input.toString());

it("connects OpenSandbox through egress and checks the desktop address from the provider", async () => {
	const dispatch = vi.fn<EgressDispatch>(async (input) => {
		const url = requestedUrl(input);
		if (url.origin === computerUrl && url.pathname === "/ping") return new Response("ok");
		if (url.origin !== baseUrl) throw new Error(`Unexpected address ${url}`);
		if (url.pathname === "/v1/sandboxes/desktop") {
			return Response.json({
				id: "desktop",
				status: { state: "Running" },
				createdAt: "2026-01-01T00:00:00Z",
			});
		}
		if (url.pathname === "/v1/sandboxes/desktop/endpoints/5900") {
			return Response.json({ endpoint: privateHostname, headers: {} });
		}
		if (url.pathname.startsWith("/v1/sandboxes/desktop/endpoints/")) {
			return Response.json({ endpoint: new URL(computerUrl).host, headers: {} });
		}
		throw new Error(`Unexpected address ${url}`);
	});
	const egress = network(dispatch);
	const provider = fromOpenSandbox(
		{ ...access, provider: "opensandbox", baseUrl, image: "debian" },
		await Effect.runPromise(Ids.make),
		egress,
	);
	const { computer } = await Effect.runPromise(provider.open(Computers.ComputerId("desktop")));
	const refusal = new EgressRefused({ reason: "privateNetwork" });
	await expect(Effect.runPromise(computer.endpoint(5900))).rejects.toMatchObject({
		userMessage: expect.stringContaining(
			`${refusal.userMessage} On a trusted self-hosted server, set ALLOW_UNSAFE_WORKSPACE_URLS=true`,
		),
	});
	expect(egress.lookup).toHaveBeenCalledWith(privateHostname);
	expect(dispatch.mock.calls.map(([request]) => requestedUrl(request).host)).toContain(
		new URL(computerUrl).host,
	);
	expect(
		dispatch.mock.calls.every(
			([, init]) => init.dispatcher instanceof Agent && init.redirect === "manual",
		),
	).toBe(true);
});

it("uses pinned E2B transport for both the API and the computer's files", async () => {
	const dispatch = vi.fn<EgressDispatch>(async (input) => {
		const url = requestedUrl(input);
		if (url.origin === computerUrl && url.pathname === "/files") return new Response("hello");
		if (url.origin === baseUrl) {
			return Response.json({
				sandboxID: "desktop",
				templateID: "base",
				state: "running",
				envdVersion: "0.5.7",
			});
		}
		throw new Error(`Unexpected address ${url}`);
	});
	const egress = network(dispatch);
	const provider = fromE2b(
		{
			...access,
			provider: "e2b",
			template: "base",
			endpoints: { apiUrl: baseUrl, sandboxUrl: computerUrl },
		},
		await Effect.runPromise(Ids.make),
		egress,
	);
	const { computer } = await Effect.runPromise(provider.open(Computers.ComputerId("desktop")));
	expect(await Effect.runPromise(computer.downloadFile("/tmp/hello.txt"))).toEqual(
		new TextEncoder().encode("hello"),
	);
	expect(egress.lookup.mock.calls.flat()).toEqual([
		"provider.example",
		"provider.example",
		"computer.example",
	]);
	expect(
		dispatch.mock.calls.every(
			([, init]) => init.dispatcher instanceof Agent && init.redirect === "manual",
		),
	).toBe(true);
});

it("tells a self-hosting operator how to allow the computer provider's local address", async () => {
	const dispatch = vi.fn<EgressDispatch>();
	const egress = network(dispatch);
	const provider = fromOpenSandbox(
		{ ...access, provider: "opensandbox", baseUrl: "http://localhost:8090", image: "debian" },
		await Effect.runPromise(Ids.make),
		egress,
	);

	await expect(Effect.runPromise(provider.check)).rejects.toMatchObject({
		userMessage: expect.stringContaining("ALLOW_UNSAFE_WORKSPACE_URLS=true"),
	});
	expect(dispatch).not.toHaveBeenCalled();
});
