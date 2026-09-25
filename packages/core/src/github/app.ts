import { createSign } from "node:crypto";
import { Effect, Schema } from "effect";
import type { EgressHttpClient } from "../providers/network/egress.ts";
import { GithubRequestFailed } from "./client.ts";

/**
 * A GitHub App a workspace registers for itself, and the installation tokens
 * Sugabots mints from it.
 *
 * Registration uses GitHub's manifest flow: the browser posts a manifest to
 * GitHub, the admin confirms, and GitHub sends back a code the server trades
 * for the app's id and private key. After that, every token is minted on
 * demand, lasts an hour, and is narrowed to the repositories and access the
 * job needs.
 */

export interface GithubAppIdentity {
	appId: string;
	privateKey: string;
	apiBaseUrl: string;
}

/** What access a minted token has. `read` fetches code; `write` pushes and opens pull requests. */
export type TokenAccess = "read" | "write";

const PERMISSIONS: Record<TokenAccess, Record<string, "read" | "write">> = {
	read: { contents: "read", metadata: "read" },
	write: { contents: "write", pull_requests: "write", metadata: "read" },
};

/**
 * The manifest GitHub registers the app from. Private, so only the account
 * that made it can install it. No webhooks: Sugabots asks GitHub for what it
 * needs rather than listening for it, and leaving `hook_attributes` out is
 * also what lets an installation GitHub can't reach, such as one on
 * `localhost`, register an app at all; GitHub refuses a hook URL it can't
 * reach even when the hook is switched off.
 */
export function appManifest({
	name,
	homepageUrl,
	createdUrl,
	installedUrl,
}: {
	name: string;
	homepageUrl: string;
	/** Where GitHub sends the browser with the code once the app is registered. */
	createdUrl: string;
	/** Where GitHub sends the browser once the app is installed or its repositories change. */
	installedUrl: string;
}) {
	return {
		name,
		url: homepageUrl,
		redirect_url: createdUrl,
		setup_url: installedUrl,
		setup_on_update: true,
		public: false,
		default_permissions: PERMISSIONS.write,
		default_events: [],
	};
}

/** Where the browser posts the manifest: the admin's own account, or an organisation's. */
export function manifestActionUrl(state: string, organization?: string): string {
	const base = organization
		? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
		: "https://github.com/settings/apps/new";
	return `${base}?state=${encodeURIComponent(state)}`;
}

export function installUrl(slug: string, state: string): string {
	return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
}

const conversionSchema = Schema.Struct({
	id: Schema.Number,
	slug: Schema.String,
	pem: Schema.String,
});
const installationSchema = Schema.Struct({
	account: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const tokenSchema = Schema.Struct({ token: Schema.String, expires_at: Schema.String });

export function githubAppClient(fetch: EgressHttpClient, apiBaseUrl: string) {
	const call = <A>(
		path: string,
		schema: Schema.Decoder<A>,
		init: { method: string; bearer?: string; body?: unknown },
	) =>
		Effect.tryPromise({
			try: async () => {
				const response = await fetch(new URL(path, withSlash(apiBaseUrl)), {
					method: init.method,
					headers: {
						accept: "application/vnd.github+json",
						"x-github-api-version": "2022-11-28",
						...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
						...(init.body === undefined ? {} : { "content-type": "application/json" }),
					},
					...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
					signal: AbortSignal.timeout(15_000),
				});
				if (!response.ok) {
					const said = (await response.json().catch(() => undefined)) as
						| { message?: string }
						| undefined;
					throw new GithubRequestFailed({
						status: response.status,
						message: `GitHub answered ${response.status}${said?.message ? `: ${said.message}` : "."}`,
					});
				}
				return Schema.decodeUnknownSync(schema)(await response.json());
			},
			catch: (cause) =>
				cause instanceof GithubRequestFailed
					? cause
					: new GithubRequestFailed({
							message: `Could not reach GitHub: ${cause instanceof Error ? cause.message : String(cause)}`,
						}),
		});

	return {
		/** Trades the code GitHub sent back for the new app's id, slug and private key. */
		convertManifest: (code: string) =>
			call(`app-manifests/${encodeURIComponent(code)}/conversions`, conversionSchema, {
				method: "POST",
			}).pipe(
				Effect.map((app) => ({ appId: String(app.id), slug: app.slug, privateKey: app.pem })),
			),

		/** Whose account the installation is on, which also proves it belongs to this app. */
		installationAccount: (identity: GithubAppIdentity, installationId: string) =>
			call(`app/installations/${encodeURIComponent(installationId)}`, installationSchema, {
				method: "GET",
				bearer: appJwt(identity),
			}).pipe(Effect.map((installation) => installation.account?.login ?? null)),

		/**
		 * A token for the installation, lasting an hour, limited to `access` and,
		 * when given, to those repositories. Repositories are named without their
		 * owner, which is the installation's.
		 */
		installationToken: (
			identity: GithubAppIdentity,
			installationId: string,
			scope: { access: TokenAccess; repositories?: readonly string[] },
		) =>
			call(`app/installations/${encodeURIComponent(installationId)}/access_tokens`, tokenSchema, {
				method: "POST",
				bearer: appJwt(identity),
				body: {
					permissions: PERMISSIONS[scope.access],
					...(scope.repositories ? { repositories: scope.repositories } : {}),
				},
			}).pipe(
				Effect.map((minted) => ({ token: minted.token, expiresAt: new Date(minted.expires_at) })),
			),
	};
}

/**
 * The app proving it is itself: a JWT signed with its private key, as GitHub
 * requires for asking about installations or minting their tokens. Backdated
 * a minute for clock drift, and valid for nine of GitHub's ten allowed.
 */
function appJwt({ appId, privateKey }: GithubAppIdentity): string {
	const now = Math.floor(Date.now() / 1000);
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
	const signature = createSign("RSA-SHA256")
		.update(unsigned)
		.sign(privateKey)
		.toString("base64url");
	return `${unsigned}.${signature}`;
}

function withSlash(url: string) {
	return url.endsWith("/") ? url : `${url}/`;
}
