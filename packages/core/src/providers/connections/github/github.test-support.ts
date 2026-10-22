import { createVerify, generateKeyPairSync } from "node:crypto";
import { Effect, Layer } from "effect";
import { pod, podMember, user, workspace, workspaceMember } from "../../../database/schema.ts";
import { onDatabase } from "../../../database/testing.ts";
import { Installation } from "../../../installation/installation.ts";
import { onPostgresAs } from "../../../workspaces/testing.ts";
import { Egress } from "../../network/egress.ts";
import type { GitHubApps } from "./github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});

export const INSTALLATION_ID = 7;
/** The app's installation on a second organization, `acme-labs`. */
export const OTHER_INSTALLATION_ID = 8;
export const WEBHOOK_SECRET = "the-webhook-secret";
/** The code GitHub sends the browser back with once it has made an app. */
export const MANIFEST_CODE = "the-code";

/** A request Sugabots sent GitHub. */
export interface Asked {
	readonly method: string;
	readonly path: string;
	readonly search: string;
	readonly bearer: string;
	readonly body: unknown;
}

type Route = (asked: Asked) => Response | undefined;

/**
 * GitHub as a pod's app sees it: it makes the app from a manifest, and
 * finds the app's installations, on `acme` and `acme-labs`, only with a
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
	return account ? json({ id, account: { login: account } }) : json({ message: "Not Found" }, 404);
};

/** The account each of the app's installations is on. */
const INSTALLED_ON = new Map([
	[INSTALLATION_ID, "acme"],
	[OTHER_INSTALLATION_ID, "acme-labs"],
]);

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
export function signedByApp(jwt: string) {
	const [header, payload, signature] = jwt.split(".");
	if (!header || !payload || !signature) return false;
	return createVerify("RSA-SHA256")
		.update(`${header}.${payload}`)
		.verify(publicKey, signature, "base64url");
}

/** Egress that reaches only `github`, for an installation served at `publicUrl`. */
export const reachingGitHub = (github: typeof fetch, publicUrl: string) =>
	Layer.mergeAll(
		Layer.succeed(Egress.Service, {
			providers: { for: () => github },
			validateProviderUrl: () => Effect.void,
			oauth: github,
			webFetch: github,
		}),
		Layer.succeed(Installation.Service, Installation.fromUrls({ isProduction: false, publicUrl })),
	);

/** A workspace with an admin, a member, and a shared pod the member is in. */
export async function workspaceWithPod(label: string) {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [space] = await onDatabase((db) =>
		db
			.insert(workspace)
			.values({ name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` })
			.returning(),
	);
	const [admin, member] = await onDatabase((db) =>
		db
			.insert(user)
			.values([
				{ name: "Ada", email: `${label}-ada-${suffix}@example.com` },
				{ name: "Kim", email: `${label}-kim-${suffix}@example.com` },
			])
			.returning(),
	);
	if (!space || !admin || !member) throw new Error("fixture");
	const workspaceId = space.id;
	await onDatabase((db) =>
		db.insert(workspaceMember).values([
			{ workspaceId, userId: admin.id, role: "admin" },
			{ workspaceId, userId: member.id, role: "member" },
		]),
	);
	const [shared] = await onDatabase((db) =>
		db
			.insert(pod)
			.values({
				workspaceId,
				ownerId: null,
				kind: "shared",
				name: "Builders",
				slug: `builders-${suffix}`,
				createdById: admin.id,
			})
			.returning(),
	);
	if (!shared) throw new Error("fixture");
	await onDatabase((db) =>
		db.insert(podMember).values({ workspaceId, podId: shared.id, userId: member.id }),
	);
	return { workspaceId, podId: shared.id, adminId: admin.id, memberId: member.id };
}

/**
 * The pod's GitHub connection, its own app made by the fixture's admin but
 * not yet installed, and the `state` that installs it.
 */
export async function madeConnection(
	gitHubApps: GitHubApps.Interface,
	{ podId, adminId }: { podId: string; adminId: string },
) {
	const asAdmin = onPostgresAs(adminId)(gitHubApps);
	const form = await asAdmin.start({ podId, organization: undefined });
	const made = await asAdmin.made({ code: MANIFEST_CODE, state: stateIn(form.url) });
	if (made.kind !== "next") throw new Error(`Not made: ${JSON.stringify(made)}`);
	// The connection's id ends its webhook's address.
	const webhookUrl: string = JSON.parse(form.manifest).hook_attributes.url;
	const connectionId = webhookUrl.split("/").at(-1) ?? "";
	return { connectionId, installState: stateIn(made.url) };
}

/** The pod's GitHub connection, its own app made by the fixture's admin and installed on `acme`. */
export async function installedConnection(
	gitHubApps: GitHubApps.Interface,
	fixture: { podId: string; adminId: string },
) {
	const { connectionId, installState } = await madeConnection(gitHubApps, fixture);
	const installed = await onPostgresAs(fixture.adminId)(gitHubApps).installed({
		installationId: INSTALLATION_ID,
		state: installState,
	});
	if (installed.kind !== "done") throw new Error(`Not installed: ${JSON.stringify(installed)}`);
	return connectionId;
}

/** The `state` a step's GitHub address carries. */
export const stateIn = (url: string) => new URL(url).searchParams.get("state") ?? undefined;
