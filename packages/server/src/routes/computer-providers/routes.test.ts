import type { ComputerNetworkSettings, ComputerProvider } from "@sugabots/contracts";
import {
	ComputerMadeMeanwhile,
	ComputerProviderIncomplete,
	ComputerProviderNotFound,
	ComputersNotDestroyed,
	ComputerUnavailable,
} from "@sugabots/contracts/errors/computers";
import { UrlNotAllowed } from "@sugabots/contracts/errors/providers";
import type { FailureOf, RequestOperationName } from "@sugabots/contracts/operations";
import { Operations } from "@sugabots/core/operations/registry";
import type { Principal } from "@sugabots/core/principal";
import { unimplemented } from "@sugabots/core/testing";
import { userText } from "@sugabots/errors";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
	createTestApp,
	identifiedBy,
	type MemberResolver,
	sessionTokenIn,
	signedInWith,
} from "../../http/app.test-support.ts";

/**
 * The computer providers routes, over doubles of the computers operations, so
 * what is under test is the routing: which operation each endpoint calls,
 * with what input, for which member, and what each failure means over HTTP.
 * Who may do what is decided, and tested, in core.
 */

const WORKSPACE = "0199a3a0-0000-7000-8000-000000000001";
const PROVIDER = "0199a3a0-0000-7000-8000-0000000000c1";

const admin = {
	id: "0199a3a0-0000-7000-8000-000000000011",
	email: "ada@example.com",
	name: "Ada",
	image: null,
};

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "admin-token" ? admin : null;

const provider: ComputerProvider = {
	id: PROVIDER,
	workspaceId: WORKSPACE,
	builtIn: "e2b",
	name: "E2B",
	settings: { builtIn: "e2b" },
	enabled: false,
	status: "missing_key",
	hasApiKey: false,
	lastTestError: null,
	createdAt: "2026-09-09T00:00:00.000Z",
};

const network: ComputerNetworkSettings = {
	mode: "open",
	blocking: true,
	trustedHosts: [],
	addedHosts: [],
	blockedHosts: [],
};

/** What one request called: the operation, the member it was called for, and its input. */
interface Called {
	readonly name: RequestOperationName;
	readonly member: string | undefined;
	readonly input: unknown;
}

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

/**
 * The app with each computer providers operation answering with a fixed
 * output, recording what it was called with in `called`.
 */
function recordingApp(called: Called[]) {
	const answering =
		<const Output>(name: RequestOperationName, output: Output) =>
		(principal: Principal, input: unknown) =>
			Effect.sync(() => {
				called.push({ name, member: memberOf(principal), input });
				return output;
			});
	return app({
		"computerProviders.list": answering("computerProviders.list", [provider]),
		"computerProviders.access": answering("computerProviders.access", { enabled: true }),
		"computerProviders.create": answering("computerProviders.create", provider),
		"computerProviders.update": answering("computerProviders.update", provider),
		"computerProviders.remove": answering("computerProviders.remove", undefined),
		"computerProviders.template": answering("computerProviders.template", { state: null }),
		"computerProviders.prepareTemplate": answering("computerProviders.prepareTemplate", {
			state: "building",
		}),
		"computerProviders.test": answering("computerProviders.test", {
			reachable: true,
			latencyMs: 5,
		}),
		"computerProviders.disks": answering("computerProviders.disks", []),
		"computerProviders.network": answering("computerProviders.network", network),
		"computerProviders.addHost": answering("computerProviders.addHost", network),
		"computerProviders.removeHost": answering("computerProviders.removeHost", network),
		"computerProviders.blockHost": answering("computerProviders.blockHost", network),
		"computerProviders.unblockHost": answering("computerProviders.unblockHost", network),
	});
}

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

const asAdmin = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: { ...signedInWith("admin-token"), "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const providers = `/workspaces/${WORKSPACE}/computer-providers`;
const hosts = `/workspaces/${WORKSPACE}/computer-network`;
const ofProvider = { workspace: WORKSPACE, providerId: PROVIDER };

describe("the computer providers routes", () => {
	it("call each endpoint's operation with its input, for the member signed in", async () => {
		const cases: ReadonlyArray<{
			readonly request: readonly [path: string, init: RequestInit];
			readonly status: number;
			readonly name: RequestOperationName;
			readonly input: unknown;
		}> = [
			{
				request: [providers, asAdmin("GET")],
				status: 200,
				name: "computerProviders.list",
				input: { workspace: WORKSPACE },
			},
			{
				request: [`${providers}/access`, asAdmin("GET")],
				status: 200,
				name: "computerProviders.access",
				input: { workspace: WORKSPACE },
			},
			{
				request: [providers, asAdmin("POST", { settings: { builtIn: "e2b" }, enabled: true })],
				status: 201,
				name: "computerProviders.create",
				input: { workspace: WORKSPACE, settings: { builtIn: "e2b" }, enabled: true },
			},
			{
				request: [`${providers}/${PROVIDER}`, asAdmin("PATCH", { enabled: false })],
				status: 200,
				name: "computerProviders.update",
				input: { ...ofProvider, changes: { enabled: false } },
			},
			{
				request: [`${providers}/${PROVIDER}`, asAdmin("DELETE")],
				status: 204,
				name: "computerProviders.remove",
				input: ofProvider,
			},
			{
				request: [`${providers}/${PROVIDER}/template`, asAdmin("GET")],
				status: 200,
				name: "computerProviders.template",
				input: ofProvider,
			},
			{
				request: [`${providers}/${PROVIDER}/template`, asAdmin("POST")],
				status: 200,
				name: "computerProviders.prepareTemplate",
				input: ofProvider,
			},
			{
				request: [`${providers}/${PROVIDER}/test`, asAdmin("POST")],
				status: 200,
				name: "computerProviders.test",
				input: ofProvider,
			},
			{
				request: [`/workspaces/${WORKSPACE}/computer-disks`, asAdmin("GET")],
				status: 200,
				name: "computerProviders.disks",
				input: { workspace: WORKSPACE },
			},
			{
				request: [hosts, asAdmin("GET")],
				status: 200,
				name: "computerProviders.network",
				input: { workspace: WORKSPACE },
			},
			{
				request: [`${hosts}/hosts`, asAdmin("POST", { host: "api.example.com" })],
				status: 200,
				name: "computerProviders.addHost",
				input: { workspace: WORKSPACE, host: "api.example.com" },
			},
			{
				request: [`${hosts}/hosts/api.example.com`, asAdmin("DELETE")],
				status: 200,
				name: "computerProviders.removeHost",
				input: { workspace: WORKSPACE, host: "api.example.com" },
			},
			{
				request: [`${hosts}/blocked-hosts`, asAdmin("POST", { host: "*.example.org" })],
				status: 200,
				name: "computerProviders.blockHost",
				input: { workspace: WORKSPACE, host: "*.example.org" },
			},
			{
				request: [`${hosts}/blocked-hosts/*.example.org`, asAdmin("DELETE")],
				status: 200,
				name: "computerProviders.unblockHost",
				input: { workspace: WORKSPACE, host: "*.example.org" },
			},
		];

		for (const { request, status, name, input } of cases) {
			const called: Called[] = [];
			const response = await recordingApp(called).request(...request);

			expect({ name, status: response.status, called }).toEqual({
				name,
				status,
				called: [{ name, member: admin.id, input }],
			});
		}
	});

	it("answers computer errors with their statuses", async () => {
		const removing = (failure: FailureOf<"computerProviders.remove">) =>
			app({ "computerProviders.remove": () => Effect.fail(failure) })
				.request(`${providers}/${PROVIDER}`, asAdmin("DELETE"))
				.then((response) => response.status);
		const creating = (failure: FailureOf<"computerProviders.create">) =>
			app({ "computerProviders.create": () => Effect.fail(failure) })
				.request(providers, asAdmin("POST", { settings: { builtIn: "e2b" } }))
				.then((response) => response.status);

		expect({
			notFound: await removing(new ComputerProviderNotFound()),
			notDestroyed: await removing(new ComputersNotDestroyed({ reason: "incomplete" })),
			madeMeanwhile: await removing(new ComputerMadeMeanwhile()),
			urlNotAllowed: await creating(
				new UrlNotAllowed({ refusal: userText`That address is on a private network.` }),
			),
			incomplete: await creating(new ComputerProviderIncomplete({ missing: "key" })),
		}).toEqual({
			notFound: 404,
			notDestroyed: 409,
			madeMeanwhile: 409,
			urlNotAllowed: 400,
			incomplete: 400,
		});
	});

	it("answers an unreachable provider as a conflict, with its user message", async () => {
		const error = new ComputerUnavailable({ provider: "e2b", cause: "timed out" });
		const response = await app({
			"computerProviders.template": () => Effect.fail(error),
		}).request(`${providers}/${PROVIDER}/template`, asAdmin("GET"));

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			_tag: "Conflict",
			message: error.userMessage,
			error: { _tag: "ComputerUnavailable", userMessage: error.userMessage, isRetryable: true },
		});
	});
});
