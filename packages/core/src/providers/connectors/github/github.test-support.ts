import { createVerify, generateKeyPairSync } from "node:crypto";
import { Effect, Layer } from "effect";
import {
	bot as botTable,
	member,
	membership,
	projectMember,
	workspace,
} from "../../../database/schema.ts";
import { onDatabase, runOnPostgres } from "../../../database/testing.ts";
import { type CallOperation, servedOperations } from "../../../operations/testing.ts";
import type { Principal } from "../../../principal.ts";
import { authenticators, principals } from "../../../proofs/world.test-support.ts";
import { ServerSettings } from "../../../server-settings/server-settings.ts";
import { defaultProjectOf } from "../../../workspaces/projects/project-reads.ts";
import { seedProject } from "../../../workspaces/projects/seed.test-support.ts";
import { Egress } from "../../network/egress.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

export const INSTALLATION_ID = 7;
/** The app's installation on a second organization, `acme-labs`. */
export const OTHER_INSTALLATION_ID = 8;
/** The app's installation on a GitHub user's own account, `ada-codes`. */
export const USER_INSTALLATION_ID = 9;
export const WEBHOOK_SECRET = "the-webhook-secret";
/** The code GitHub sends the browser back with once it has made an app. */
export const MANIFEST_CODE = "the-code";

/** A request Sugabots sent GitHub. */
interface Asked {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly bearer: string;
	readonly body: unknown;
}

export type Route = (asked: Asked) => Response | Promise<Response> | undefined;

/**
 * GitHub as a bot's app sees it: it makes the app from a manifest, and
 * finds the app's installations, on `acme`, `acme-labs` and `ada-codes`, only with a
 * token signed by the app's key. `routes` answer anything else, before a 404.
 */
export function standInGitHub(...routes: Route[]) {
	const asked: Asked[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		const request: Asked = {
			method: init?.method ?? "GET",
			path: url.pathname,
			search: url.search,
			bearer: new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		};
		asked.push(request);
		for (const route of [makesApps, findsInstallation, ...routes]) {
			const answer = route(request);
			if (answer) return answer;
		}
		return json({ message: "Not Found" }, 404);
	};
	return { fetch, asked };
}

export const json = (value: unknown, status = 200) => Response.json(value, { status });

const makesApps: Route = ({ path }) =>
	path === `/app-manifests/${MANIFEST_CODE}/conversions`
		? json(
				{
					id: 42,
					slug: "acme-sugabots",
					name: "Acme Sugabots",
					owner: { login: "acme", type: "Organization" },
					pem: privateKey,
					webhook_secret: WEBHOOK_SECRET,
				},
				201,
			)
		: undefined;

const findsInstallation: Route = ({ method, path, bearer }) => {
	if (method !== "GET" || !path.startsWith("/app/installations/")) return undefined;
	if (!signedByApp(bearer)) return json({ message: "Bad credentials" }, 401);
	const id = Number(path.slice("/app/installations/".length));
	const account = INSTALLED_ON.get(id);
	return account ? json({ id, account }) : json({ message: "Not Found" }, 404);
};

/** The account each of the app's installations is on. */
const INSTALLED_ON = new Map([
	[INSTALLATION_ID, { login: "acme", type: "Organization" }],
	[OTHER_INSTALLATION_ID, { login: "acme-labs", type: "Organization" }],
	[USER_INSTALLATION_ID, { login: "ada-codes", type: "User" }],
]);

/**
 * Uninstalls the app's installations, for the app's own token, answering
 * with what `answer` makes of the installation's id.
 */
export const uninstalls =
	(answer: (installationId: number) => Promise<Response>): Route =>
	({ method, path, bearer }) => {
		const id = /^\/app\/installations\/(\d+)$/.exec(path)?.[1];
		if (method !== "DELETE" || id === undefined) return undefined;
		if (!signedByApp(bearer)) return json({ message: "Bad credentials" }, 401);
		return answer(Number(id));
	};

/**
 * Mints installation tokens for the app's own token: `token-<installation>-<n>`,
 * numbered by when they were asked for.
 */
export const mintsTokens: Route = ({ method, path, bearer }) => {
	const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
	const id = Number(minting?.[1]);
	if (method !== "POST" || !INSTALLED_ON.has(id)) return undefined;
	if (!signedByApp(bearer)) return json({ message: "Bad credentials" }, 401);
	mintedTokens += 1;
	return json({ token: `token-${id}-${mintedTokens}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
};

let mintedTokens = 0;

/**
 * What each installation's token lists: `acme/web` and `acme/infra` on
 * `acme`, and `acme-labs/lab` on `acme-labs`.
 */
export const listsRepositories: Route = ({ path, bearer }) => {
	if (path !== "/installation/repositories") return undefined;
	const repositories = bearer.startsWith(`token-${OTHER_INSTALLATION_ID}-`)
		? [{ id: 301, full_name: "acme-labs/lab", private: true }]
		: [
				{ id: 101, full_name: "acme/web", private: true },
				{ id: 102, full_name: "acme/infra", private: false },
			];
	return json({ total_count: repositories.length, repositories });
};

/** Whether `jwt` is the app's own token, signed with its private key. */
function signedByApp(jwt: string) {
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) return false;
	return createVerify("RSA-SHA256")
		.update(`${header}.${payload}`)
		.verify(publicKey, signature, "base64url");
}

/** Egress that reaches only `github`. */
export const egressToGitHub = (github: typeof fetch) =>
	Layer.succeed(Egress.Service, {
		providers: { for: () => github },
		validateProviderUrl: () => Effect.void,
		oauth: github,
		webFetch: github,
	});

/** Egress that reaches only `github`, for an installation served at `publicUrl`. */
export const reachingGitHub = (github: typeof fetch, publicUrl: string) =>
	Layer.mergeAll(
		egressToGitHub(github),
		Layer.succeed(
			ServerSettings.Service,
			ServerSettings.fromUrls({ isProduction: false, publicUrl }),
		),
	);

/** A workspace with an admin, an editor, a project the editor is in, and a public bot. */
export async function workspaceWithProject(label: string) {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` })
			.returning(),
	);
	const [admin, editor] = await onDatabase((db) =>
		db
			.insert(member)
			.values([
				{ name: "Ada", email: `${label}-ada-${suffix}@example.com` },
				{ name: "Kim", email: `${label}-kim-${suffix}@example.com` },
			])
			.returning(),
	);
	if (!space || !admin || !editor) throw new Error("fixture");
	const workspaceId = space.id;
	await onDatabase((db) =>
		db.insert(membership).values([
			{ workspaceId, memberId: admin.id, role: "admin" },
			{ workspaceId, memberId: editor.id, role: "editor" },
		]),
	);
	const shared = await onDatabase((db) =>
		seedProject(db, {
			workspaceId,
			name: "Builders",
			slug: `builders-${suffix}`,
			createdById: admin.id,
		}),
	);
	if (!shared) throw new Error("fixture");
	await onDatabase((db) =>
		db.insert(projectMember).values({ workspaceId, projectId: shared.id, memberId: editor.id }),
	);
	const [bot] = await onDatabase((db) =>
		db
			.insert(botTable)
			.values({
				workspaceId,
				name: "Builder",
				handle: "builder",
				color: "sky",
				eyes: "pill",
			})
			.returning(),
	);
	if (!bot) throw new Error("fixture");
	const ownProjectId = await runOnPostgres(defaultProjectOf(bot.id));
	return {
		workspaceId,
		/** The project members made, whose GitHub app the tests make. */
		projectId: shared.id,
		botId: bot.id,
		/** The bot's default project, which holds its own GitHub app. */
		botProjectId: ownProjectId,
		adminId: admin.id,
		editorId: editor.id,
	};
}

/**
 * The operations a test sets a project's GitHub app up through, and the
 * principal each member is signed in as.
 */
export interface GitHubSetup {
	readonly call: CallOperation;
	readonly member: (memberId: string) => Promise<Principal>;
}

/**
 * The operations, reaching only `github`, for an installation served at
 * `publicUrl`, and each member signed in, from the authenticators. Call it
 * from `beforeAll`.
 */
export async function gitHubSetupAt(github: typeof fetch, publicUrl: string): Promise<GitHubSetup> {
	const call = await servedOperations({
		egress: egressToGitHub(github),
		serverSettings: ServerSettings.fromUrls({ isProduction: false, publicUrl }),
	});
	const as = principals(await authenticators());
	return { call, member: as.member };
}

/**
 * The project's GitHub app, made by the fixture's admin but
 * not yet installed, and the `state` that installs it.
 */
export async function madeConnector(
	{ call, member }: GitHubSetup,
	{ projectId, adminId }: { projectId: string; adminId: string },
) {
	const admin = await member(adminId);
	const form = await call(admin, "gitHubConnectors.start", { projectId, organization: undefined });
	const made = await call(admin, "gitHubConnectors.gitHubAppMade", {
		code: MANIFEST_CODE,
		state: stateIn(form.url),
	});
	if (made.kind !== "next") throw new Error(`Not made: ${JSON.stringify(made)}`);
	// The connector's id ends its webhook's address.
	const webhookUrl: string = JSON.parse(form.manifest).hook_attributes.url;
	const connectorId = webhookUrl.split("/").at(-1) ?? "";
	return { connectorId, installState: stateIn(made.url) };
}

/**
 * The project's GitHub app, made by the fixture's admin and installed on
 * `acme`, or on the account `installationId` is on.
 */
export async function installedConnector(
	setup: GitHubSetup,
	fixture: { projectId: string; adminId: string },
	installationId = INSTALLATION_ID,
) {
	const { connectorId, installState } = await madeConnector(setup, fixture);
	const installed = await setup.call(
		await setup.member(fixture.adminId),
		"gitHubConnectors.gitHubAppInstalled",
		{ installationId, state: installState },
	);
	if (installed.kind !== "done") throw new Error(`Not installed: ${JSON.stringify(installed)}`);
	return connectorId;
}

/** The `state` a step's GitHub address carries. */
export const stateIn = (url: string) => new URL(url).searchParams.get("state") ?? undefined;
