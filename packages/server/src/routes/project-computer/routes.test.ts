import type { ProjectComputer, ProjectComputerNetwork } from "@sugabots/contracts";
import {
	ComputerHostBlocked,
	ComputerInUse,
	NoComputer,
	NoComputerProvider,
	UpgradeFailed,
} from "@sugabots/contracts/errors/computers";
import { BotCannotReach, ResourceHidden } from "@sugabots/contracts/errors/proofs";
import type { FailureOf, OperationName } from "@sugabots/contracts/operations";
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
 * The project computer routes, over doubles of the computers operations, so
 * what is under test is the routing: which operation each endpoint calls,
 * with what input, for which member, and what each failure means over HTTP.
 * Who may do what is decided, and tested, in core.
 */

const PROJECT = "0199a3a0-0000-7000-8000-0000000000a1";

const admin = {
	id: "0199a3a0-0000-7000-8000-000000000011",
	email: "ada@example.com",
	name: "Ada",
	image: null,
};

const resolveMember: MemberResolver = async (headers) =>
	sessionTokenIn(headers) === "admin-token" ? admin : null;

const shown: ProjectComputer = { computer: { kind: "none" }, providerEnabled: true };

const network: ProjectComputerNetwork = {
	mode: "open",
	blocking: true,
	workspaceHosts: [],
	addedHosts: [],
};

/** What one request called: the operation, the member it was called for, and its input. */
interface Called {
	readonly name: OperationName;
	readonly member: string | undefined;
	readonly input: unknown;
}

/** The member a principal is signed in as, as the session authenticator built it. */
const memberOf = (principal: Principal) =>
	principal._tag === "MemberSession" ? principal.member : undefined;

/** The app with `operations` as the only operations it has. */
const app = (operations: Partial<Operations.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveMember), unimplemented(Operations.Service, operations)),
	);

/**
 * The app with each project computer operation answering with a fixed
 * output, recording what it was called with in `called`.
 */
function recordingApp(called: Called[]) {
	const answering =
		<const Output>(name: OperationName, output: Output) =>
		(principal: Principal, input: unknown) =>
			Effect.sync(() => {
				called.push({ name, member: memberOf(principal), input });
				return output;
			});
	return app({
		"projectComputer.get": answering("projectComputer.get", shown),
		"projectComputer.reset": answering("projectComputer.reset", shown),
		"projectComputer.upgrade": answering("projectComputer.upgrade", shown),
		"projectComputer.network": answering("projectComputer.network", network),
		"projectComputer.addHost": answering("projectComputer.addHost", network),
		"projectComputer.removeHost": answering("projectComputer.removeHost", network),
	});
}

const asAdmin = (method: string, body?: unknown): RequestInit => ({
	method,
	headers: { ...signedInWith("admin-token"), "content-type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const root = `/projects/${PROJECT}/computer`;

describe("the project computer routes", () => {
	it("call each endpoint's operation with its input, for the member signed in", async () => {
		const cases: ReadonlyArray<{
			readonly request: readonly [path: string, init: RequestInit];
			readonly name: OperationName;
			readonly input: unknown;
		}> = [
			{
				request: [root, asAdmin("GET")],
				name: "projectComputer.get",
				input: { projectId: PROJECT },
			},
			{
				request: [`${root}/reset`, asAdmin("POST")],
				name: "projectComputer.reset",
				input: { projectId: PROJECT },
			},
			{
				request: [`${root}/upgrade`, asAdmin("POST")],
				name: "projectComputer.upgrade",
				input: { projectId: PROJECT },
			},
			{
				request: [`${root}/network`, asAdmin("GET")],
				name: "projectComputer.network",
				input: { projectId: PROJECT },
			},
			{
				request: [`${root}/network/hosts`, asAdmin("POST", { host: "api.example.com" })],
				name: "projectComputer.addHost",
				input: { projectId: PROJECT, host: "api.example.com" },
			},
			{
				request: [`${root}/network/hosts/api.example.com`, asAdmin("DELETE")],
				name: "projectComputer.removeHost",
				input: { projectId: PROJECT, host: "api.example.com" },
			},
		];

		for (const { request, name, input } of cases) {
			const called: Called[] = [];
			const response = await recordingApp(called).request(...request);

			expect({ name, status: response.status, called }).toEqual({
				name,
				status: 200,
				called: [{ name, member: admin.id, input }],
			});
		}
	});

	it("answers each failure with its status", async () => {
		const upgrading = (failure: FailureOf<"projectComputer.upgrade">) =>
			app({ "projectComputer.upgrade": () => Effect.fail(failure) })
				.request(`${root}/upgrade`, asAdmin("POST"))
				.then((response) => response.status);

		expect({
			hidden: await upgrading(new ResourceHidden({ resource: "project" })),
			botCannotReach: await upgrading(new BotCannotReach({ resource: "project" })),
			noProvider: await upgrading(new NoComputerProvider()),
			inUse: await upgrading(new ComputerInUse()),
			noComputer: await upgrading(new NoComputer()),
			failed: await upgrading(new UpgradeFailed({ reason: userText`The copy stopped.` })),
		}).toEqual({
			hidden: 404,
			botCannotReach: 403,
			noProvider: 400,
			inUse: 409,
			noComputer: 404,
			failed: 409,
		});
	});

	it("refuses a host the workspace blocked as a bad request, naming the block", async () => {
		const response = await app({
			"projectComputer.addHost": () =>
				Effect.fail(new ComputerHostBlocked({ host: "api.example.com", by: "*.example.com" })),
		}).request(`${root}/network/hosts`, asAdmin("POST", { host: "api.example.com" }));

		expect(response.status).toBe(400);
		const blocked =
			"api.example.com would reach *.example.com, which is blocked for this workspace's computers.";
		expect(await response.json()).toEqual({
			_tag: "BadRequest",
			message: blocked,
			error: { _tag: "ComputerHostBlocked", userMessage: blocked, isRetryable: false },
		});
	});
});
