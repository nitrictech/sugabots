import type {
	GithubConnection,
	GithubConnectionUpdate,
	NewGithubConnection,
	PodRepository,
} from "@sugabots/contracts";
import { GITHUB_DEFAULT_API_URL, GITHUB_DEFAULT_GIT_HOST } from "@sugabots/contracts";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Credentials } from "../credentials/credentials.ts";
import { type Database, query } from "../database/database.ts";
import {
	type GithubConnectionRow,
	githubConnection,
	type PodRepositoryRow,
	podRepository,
} from "../database/schema.ts";
import type { GithubRepository } from "./client.ts";

export type GithubSecrets = { apiBaseUrl: string; gitHost: string } & (
	| { method: "token"; token: string }
	| {
			method: "app";
			appId: string;
			privateKey: string;
			/** Null until the app is installed. */
			installationId: string | null;
	  }
);

/**
 * A workspace's GitHub connection, and the repositories its pods have.
 *
 * `credentials` unseals the token, for the server's own calls to GitHub and
 * for the sandbox egress rules that add it to git requests. Nothing else ever
 * sees it: the connection as the API returns it says only that there is one.
 */
export interface GithubStore {
	get(workspaceId: string): Effect.Effect<GithubConnection | undefined, never, Database>;
	replace(
		workspaceId: string,
		userId: string,
		input: NewGithubConnection,
	): Effect.Effect<GithubConnection, never, Database>;
	update(
		workspaceId: string,
		input: GithubConnectionUpdate,
	): Effect.Effect<GithubConnection | undefined, never, Database>;
	remove(workspaceId: string): Effect.Effect<boolean, never, Database>;
	/**
	 * The connection's secrets, unsealed: a token, or an app's identity and
	 * installation. Only the token service reads these, to hand out tokens.
	 */
	secrets(workspaceId: string): Effect.Effect<GithubSecrets | undefined, never, Database>;
	/** Records the app GitHub just registered, replacing any connection the workspace had. */
	saveApp(
		workspaceId: string,
		userId: string,
		app: { appId: string; slug: string; privateKey: string },
	): Effect.Effect<void, never, Database>;
	/** Records where the app was installed. Nothing if the workspace's connection isn't that app. */
	saveInstallation(
		workspaceId: string,
		appId: string,
		installation: { id: string; accountLogin: string | null },
	): Effect.Effect<boolean, never, Database>;
	recordTest(
		workspaceId: string,
		outcome: { login: string } | { error: string },
	): Effect.Effect<void, never, Database>;

	listRepositories(podId: string): Effect.Effect<PodRepository[], never, Database>;
	/** Adds what GitHub said about the repository, or undefined if the pod already has it. */
	addRepository(
		pod: { workspaceId: string; podId: string },
		userId: string,
		repository: GithubRepository,
	): Effect.Effect<PodRepository | undefined, never, Database>;
	removeRepository(podId: string, repositoryId: string): Effect.Effect<boolean, never, Database>;
}

export function githubStore(cipher: Credentials.Interface): GithubStore {
	const load = (workspaceId: string) =>
		query((db) =>
			db
				.select()
				.from(githubConnection)
				.where(eq(githubConnection.workspaceId, workspaceId))
				.limit(1)
				.pipe(Effect.map(([row]) => row)),
		);

	return {
		get: (workspaceId) => Effect.map(load(workspaceId), (row) => row && toConnection(row)),

		replace: (workspaceId, userId, input) =>
			Effect.gen(function* () {
				const values = {
					method: input.method,
					apiBaseUrl: input.apiBaseUrl ?? GITHUB_DEFAULT_API_URL,
					gitHost: input.gitHost ?? GITHUB_DEFAULT_GIT_HOST,
					tokenEncrypted: cipher.encrypt(input.token),
					appId: null,
					appSlug: null,
					appPrivateKeyEncrypted: null,
					appInstallationId: null,
					accountLogin: null,
					lastTestedAt: null,
					lastTestError: null,
				};
				const [row] = yield* query((db) =>
					db
						.insert(githubConnection)
						.values({ workspaceId, createdById: userId, ...values })
						.onConflictDoUpdate({
							target: githubConnection.workspaceId,
							set: { ...values, createdById: userId },
						})
						.returning(),
				);
				if (!row) return yield* Effect.die(new Error("GitHub connection upsert returned no row"));
				return toConnection(row);
			}),

		update: (workspaceId, input) =>
			Effect.gen(function* () {
				const [row] = yield* query((db) =>
					db
						.update(githubConnection)
						.set({
							apiBaseUrl: input.apiBaseUrl,
							gitHost: input.gitHost,
							tokenEncrypted: input.token === undefined ? undefined : cipher.encrypt(input.token),
							// Anything changed means the last test says nothing about it now.
							accountLogin: null,
							lastTestedAt: null,
							lastTestError: null,
						})
						.where(eq(githubConnection.workspaceId, workspaceId))
						.returning(),
				);
				return row && toConnection(row);
			}),

		remove: (workspaceId) =>
			Effect.map(
				query((db) =>
					db
						.delete(githubConnection)
						.where(eq(githubConnection.workspaceId, workspaceId))
						.returning({ id: githubConnection.id }),
				),
				(rows) => rows.length > 0,
			),

		secrets: (workspaceId) => Effect.map(load(workspaceId), (row) => row && toSecrets(row, cipher)),

		saveApp: (workspaceId, userId, app) =>
			Effect.asVoid(
				query((db) => {
					const values = {
						method: "app" as const,
						apiBaseUrl: GITHUB_DEFAULT_API_URL,
						gitHost: GITHUB_DEFAULT_GIT_HOST,
						tokenEncrypted: null,
						appId: app.appId,
						appSlug: app.slug,
						appPrivateKeyEncrypted: cipher.encrypt(app.privateKey),
						appInstallationId: null,
						accountLogin: null,
						lastTestedAt: null,
						lastTestError: null,
						createdById: userId,
					};
					return db
						.insert(githubConnection)
						.values({ workspaceId, ...values })
						.onConflictDoUpdate({ target: githubConnection.workspaceId, set: values });
				}),
			),

		saveInstallation: (workspaceId, appId, installation) =>
			Effect.map(
				query((db) =>
					db
						.update(githubConnection)
						.set({
							appInstallationId: installation.id,
							accountLogin: installation.accountLogin,
							lastTestedAt: sql`now()`,
							lastTestError: null,
						})
						.where(
							and(eq(githubConnection.workspaceId, workspaceId), eq(githubConnection.appId, appId)),
						)
						.returning({ id: githubConnection.id }),
				),
				(rows) => rows.length > 0,
			),

		recordTest: (workspaceId, outcome) =>
			Effect.asVoid(
				query((db) =>
					db
						.update(githubConnection)
						.set({
							lastTestedAt: sql`now()`,
							accountLogin: "login" in outcome ? outcome.login : null,
							lastTestError: "error" in outcome ? outcome.error : null,
						})
						.where(eq(githubConnection.workspaceId, workspaceId)),
				),
			),

		listRepositories: (podId) =>
			Effect.map(
				query((db) =>
					db
						.select()
						.from(podRepository)
						.where(eq(podRepository.podId, podId))
						.orderBy(asc(podRepository.fullName)),
				),
				(rows) => rows.map(toPodRepository),
			),

		addRepository: ({ workspaceId, podId }, userId, repository) =>
			Effect.map(
				query((db) =>
					db
						.insert(podRepository)
						.values({
							workspaceId,
							podId,
							fullName: repository.fullName,
							defaultBranch: repository.defaultBranch,
							private: repository.private,
							createdById: userId,
						})
						.onConflictDoNothing({ target: [podRepository.podId, podRepository.fullName] })
						.returning(),
				),
				([row]) => row && toPodRepository(row),
			),

		removeRepository: (podId, repositoryId) =>
			Effect.map(
				query((db) =>
					db
						.delete(podRepository)
						.where(and(eq(podRepository.podId, podId), eq(podRepository.id, repositoryId)))
						.returning({ id: podRepository.id }),
				),
				(rows) => rows.length > 0,
			),
	};
}

/** The row's secrets, or nothing when it is an app whose key is somehow missing. */
function toSecrets(
	row: GithubConnectionRow,
	cipher: Credentials.Interface,
): GithubSecrets | undefined {
	const where = { apiBaseUrl: row.apiBaseUrl, gitHost: row.gitHost };
	if (row.method === "token") {
		return row.tokenEncrypted
			? { ...where, method: "token", token: cipher.decrypt(row.tokenEncrypted) }
			: undefined;
	}
	if (!row.appId || !row.appPrivateKeyEncrypted) return undefined;
	return {
		...where,
		method: "app",
		appId: row.appId,
		privateKey: cipher.decrypt(row.appPrivateKeyEncrypted),
		installationId: row.appInstallationId,
	};
}

function toConnection(row: GithubConnectionRow): GithubConnection {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		method: row.method,
		apiBaseUrl: row.apiBaseUrl,
		gitHost: row.gitHost,
		hasToken:
			row.method === "token" ? row.tokenEncrypted !== null : row.appPrivateKeyEncrypted !== null,
		appSlug: row.appSlug,
		installed: row.method === "token" || row.appInstallationId !== null,
		accountLogin: row.accountLogin,
		status: row.lastTestedAt === null ? "untested" : row.lastTestError ? "error" : "connected",
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}

function toPodRepository(row: PodRepositoryRow): PodRepository {
	return {
		id: row.id,
		podId: row.podId,
		fullName: row.fullName,
		defaultBranch: row.defaultBranch,
		private: row.private,
		createdAt: row.createdAt.toISOString(),
	};
}
