import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import type { EgressHttpClients } from "../providers/network/egress.ts";
import { type GithubAppIdentity, githubAppClient, type TokenAccess } from "./app.ts";
import type { GithubCredentials } from "./client.ts";
import type { GithubStore } from "./store.ts";

/**
 * Where every GitHub token Sugabots uses comes from.
 *
 * With a personal access token, that token, whatever the job. With an app, an
 * installation token minted for the job: read-only for fetching, write for
 * pushing and pull requests, and limited to the repositories named. Minted
 * tokens are kept until five minutes before GitHub expires them, since a
 * sandbox asks for its credentials on every turn.
 */
export interface GithubTokens {
	/** Credentials for the job, or nothing if the workspace has no usable GitHub connection. */
	credentialsFor(
		workspaceId: string,
		scope: TokenScope,
	): Effect.Effect<GithubCredentials | undefined, never, Database>;
}

export interface TokenScope {
	access: TokenAccess;
	/** `owner/name` of each repository the job needs. Every repository the installation can reach, when left out. */
	repositories?: readonly string[];
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

export function githubTokens({
	github,
	httpClients,
}: {
	github: Pick<GithubStore, "secrets">;
	httpClients: EgressHttpClients;
}): GithubTokens {
	const minted = new Map<string, { token: string; expiresAt: Date }>();

	return {
		credentialsFor: (workspaceId, scope) =>
			Effect.gen(function* () {
				const secrets = yield* github.secrets(workspaceId);
				if (!secrets) return undefined;
				const where = { apiBaseUrl: secrets.apiBaseUrl, gitHost: secrets.gitHost };
				if (secrets.method === "token") return { ...where, token: secrets.token };
				if (!secrets.installationId) return undefined;

				const repositories = scope.repositories?.map(
					(fullName) => fullName.split("/")[1] ?? fullName,
				);
				const key = [
					workspaceId,
					secrets.appId,
					secrets.installationId,
					scope.access,
					...(repositories ? [...repositories].sort() : ["*"]),
				].join(":");
				const cached = minted.get(key);
				if (cached && cached.expiresAt.getTime() - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
					return { ...where, token: cached.token };
				}
				const identity: GithubAppIdentity = {
					appId: secrets.appId,
					privateKey: secrets.privateKey,
					apiBaseUrl: secrets.apiBaseUrl,
				};
				const fresh = yield* githubAppClient(
					httpClients.for({ baseUrl: secrets.apiBaseUrl }),
					secrets.apiBaseUrl,
				)
					.installationToken(identity, secrets.installationId, {
						access: scope.access,
						...(repositories ? { repositories } : {}),
					})
					.pipe(
						Effect.tapError((failure) =>
							Effect.logWarning("Minting a GitHub installation token failed", failure),
						),
						Effect.option,
					);
				if (fresh._tag === "None") return undefined;
				minted.set(key, fresh.value);
				return { ...where, token: fresh.value.token };
			}),
	};
}
