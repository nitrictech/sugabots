import type {
	GithubAppManifest,
	GithubConnectionTestResult,
	GithubConnectionUpdate,
	NewGithubConnection,
	NewPodRepository,
} from "@sugabots/contracts";
import { eq } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { type Database, query } from "../database/database.ts";
import { workspace } from "../database/schema.ts";
import type { CredentialCipher } from "../providers/model-providers/credentials.ts";
import type { EgressHttpClients, EgressUrlValidator } from "../providers/network/egress.ts";
import { appManifest, githubAppClient, installUrl, manifestActionUrl } from "./app.ts";
import { githubClient } from "./client.ts";
import type { GithubStore } from "./store.ts";
import type { GithubTokens } from "./tokens.ts";

export class GithubConnectionNotFound extends Data.TaggedError("GithubConnectionNotFound") {
	override get message() {
		return "This workspace isn't connected to GitHub";
	}
}

export class GithubUrlNotAllowed extends Data.TaggedError("GithubUrlNotAllowed") {
	override get message() {
		return "The GitHub API address is not allowed by the network policy";
	}
}

/** GitHub couldn't tell us about the repository, for the reason in `message`. */
export class RepositoryNotReadable extends Data.TaggedError("RepositoryNotReadable")<{
	message: string;
}> {}

export class RepositoryAlreadyAdded extends Data.TaggedError("RepositoryAlreadyAdded") {
	override get message() {
		return "This pod already has that repository";
	}
}

/**
 * Registering or installing the app didn't finish: GitHub sent back
 * something unusable, the link expired or was someone else's, or GitHub
 * refused to hand the app over.
 */
export class GithubAppSetupFailed extends Data.TaggedError("GithubAppSetupFailed")<{
	message: string;
}> {}

export interface GithubOperationsOptions {
	github: GithubStore;
	tokens: GithubTokens;
	httpClients: EgressHttpClients;
	validateUrl: EgressUrlValidator;
	/** Seals the state GitHub carries through registration, so only this server's links come back. */
	cipher: CredentialCipher;
	/** Addresses GitHub is given for the app, built from the installation's own. */
	urls: { homepage: string; appCreated: string; appInstalled: string };
	/** Whether the person may still manage this workspace's providers, asked again on the way back from GitHub. */
	mayManage: (userId: string, workspaceId: string) => Effect.Effect<boolean, never, Database>;
}

/** How long a registration link stays good: long enough to read GitHub's page and confirm. */
const SETUP_WINDOW_MS = 60 * 60_000;

const stateSchema = Schema.Struct({
	workspaceId: Schema.String,
	userId: Schema.String,
	expiresAt: Schema.Number,
});

export function githubOperations({
	github,
	tokens,
	httpClients,
	validateUrl,
	cipher,
	urls,
	mayManage,
}: GithubOperationsOptions) {
	const requireAllowedUrl = (url: string) =>
		Effect.tryPromise({ try: () => validateUrl(url), catch: () => new GithubUrlNotAllowed() });

	const sealState = (workspaceId: string, userId: string) =>
		cipher.encrypt(
			JSON.stringify({ workspaceId, userId, expiresAt: Date.now() + SETUP_WINDOW_MS }),
		);

	/** The workspace a returning link is for, if it is this server's, unexpired, and this person's. */
	const openState = (userId: string, state: string | undefined) =>
		Effect.gen(function* () {
			const failed = new GithubAppSetupFailed({
				message: "The link back from GitHub has expired or isn't yours. Start again from Sugabots.",
			});
			if (!state) return yield* failed;
			const opened = yield* Effect.try({
				try: () => Schema.decodeUnknownSync(stateSchema)(JSON.parse(cipher.decrypt(state))),
				catch: () => failed,
			});
			if (opened.userId !== userId || opened.expiresAt < Date.now()) return yield* failed;
			if (!(yield* mayManage(userId, opened.workspaceId))) return yield* failed;
			return opened.workspaceId;
		});

	const appClient = (apiBaseUrl: string) =>
		githubAppClient(httpClients.for({ baseUrl: apiBaseUrl }), apiBaseUrl);

	const workspaceSlug = (workspaceId: string) =>
		Effect.map(
			query((db) =>
				db.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, workspaceId)),
			),
			([row]) => row?.slug ?? workspaceId,
		);

	return {
		get: (workspaceId: string, userId: string) =>
			Effect.map(github.get(workspaceId), (connection) => ({
				connection: connection ?? null,
				installUrl:
					connection?.method === "app" && connection.appSlug
						? installUrl(connection.appSlug, sealState(workspaceId, userId))
						: null,
			})),

		replace: (workspaceId: string, userId: string, input: NewGithubConnection) =>
			Effect.andThen(
				input.apiBaseUrl ? requireAllowedUrl(input.apiBaseUrl) : Effect.void,
				github.replace(workspaceId, userId, input),
			),

		update: (workspaceId: string, input: GithubConnectionUpdate) =>
			Effect.gen(function* () {
				if (input.apiBaseUrl) yield* requireAllowedUrl(input.apiBaseUrl);
				const updated = yield* github.update(workspaceId, input);
				if (!updated) return yield* new GithubConnectionNotFound();
				return updated;
			}),

		remove: (workspaceId: string) =>
			Effect.filterOrFail(
				github.remove(workspaceId),
				(removed) => removed,
				() => new GithubConnectionNotFound(),
			).pipe(Effect.asVoid),

		test: (
			workspaceId: string,
		): Effect.Effect<GithubConnectionTestResult, GithubConnectionNotFound, Database> =>
			Effect.gen(function* () {
				const secrets = yield* github.secrets(workspaceId);
				if (!secrets) return yield* new GithubConnectionNotFound();
				const outcome =
					secrets.method === "token"
						? yield* githubClient(
								httpClients.for({ baseUrl: secrets.apiBaseUrl }),
								secrets,
							).viewer.pipe(
								Effect.map((login) => ({ login })),
								Effect.catchTag("GithubRequestFailed", (failure) =>
									Effect.succeed({ error: failure.message }),
								),
							)
						: secrets.installationId
							? yield* appClient(secrets.apiBaseUrl)
									.installationAccount(secrets, secrets.installationId)
									.pipe(
										Effect.map((login) => ({ login: login ?? "the app's installation" })),
										Effect.catchTag("GithubRequestFailed", (failure) =>
											Effect.succeed({ error: failure.message }),
										),
									)
							: { error: "The app isn't installed yet." };
				yield* github.recordTest(workspaceId, outcome);
				return "login" in outcome
					? { reachable: true, login: outcome.login }
					: { reachable: false, error: outcome.error };
			}),

		/** The manifest the browser posts to GitHub to register the workspace's own app. */
		startApp: (
			workspaceId: string,
			userId: string,
			organization: string | undefined,
		): Effect.Effect<GithubAppManifest, never, Database> =>
			Effect.gen(function* () {
				const slug = yield* workspaceSlug(workspaceId);
				const manifest = appManifest({
					// GitHub app names are unique across GitHub and at most 34 characters.
					name: `Sugabots ${slug}`.slice(0, 34),
					homepageUrl: urls.homepage,
					createdUrl: urls.appCreated,
					installedUrl: urls.appInstalled,
				});
				return {
					actionUrl: manifestActionUrl(sealState(workspaceId, userId), organization || undefined),
					manifest: JSON.stringify(manifest),
				};
			}),

		/**
		 * GitHub has registered the app and sent back a code: trade it for the
		 * app's key, keep that, and send the admin on to install it.
		 */
		appCreated: (userId: string, code: string | undefined, state: string | undefined) =>
			Effect.gen(function* () {
				const workspaceId = yield* openState(userId, state);
				if (!code) {
					return yield* new GithubAppSetupFailed({ message: "GitHub didn't register the app." });
				}
				const app = yield* appClient("https://api.github.com/")
					.convertManifest(code)
					.pipe(
						Effect.mapError(
							(failure) =>
								new GithubAppSetupFailed({
									message: `GitHub didn't hand over the app: ${failure.message}`,
								}),
						),
					);
				yield* github.saveApp(workspaceId, userId, app);
				return { installUrl: installUrl(app.slug, sealState(workspaceId, userId)) };
			}),

		/** The admin installed the app: check the installation is this app's, and keep it. */
		appInstalled: (userId: string, installationId: string | undefined, state: string | undefined) =>
			Effect.gen(function* () {
				const workspaceId = yield* openState(userId, state);
				const secrets = yield* github.secrets(workspaceId);
				if (!installationId || secrets?.method !== "app") {
					return yield* new GithubAppSetupFailed({ message: "The app wasn't installed." });
				}
				const accountLogin = yield* appClient(secrets.apiBaseUrl)
					.installationAccount(secrets, installationId)
					.pipe(
						Effect.mapError(
							(failure) =>
								new GithubAppSetupFailed({
									message: `That installation isn't this workspace's app: ${failure.message}`,
								}),
						),
					);
				yield* github.saveInstallation(workspaceId, secrets.appId, {
					id: installationId,
					accountLogin,
				});
				return { workspaceSlug: yield* workspaceSlug(workspaceId) };
			}),

		/** Where to send the browser when a link back from GitHub can't be used. */
		workspaceSlugForState: (userId: string, state: string | undefined) =>
			openState(userId, state).pipe(
				Effect.flatMap(workspaceSlug),
				Effect.option,
				Effect.map((slug) => (slug._tag === "Some" ? slug.value : undefined)),
			),

		listRepositories: (podId: string) => github.listRepositories(podId),

		addRepository: (
			pod: { workspaceId: string; podId: string },
			userId: string,
			input: NewPodRepository,
		) =>
			Effect.gen(function* () {
				const credentials = yield* tokens.credentialsFor(pod.workspaceId, { access: "read" });
				if (!credentials) return yield* new GithubConnectionNotFound();
				const repository = yield* githubClient(
					httpClients.for({ baseUrl: credentials.apiBaseUrl }),
					credentials,
				)
					.repository(input.fullName)
					.pipe(
						Effect.mapError((failure) => new RepositoryNotReadable({ message: failure.message })),
					);
				const added = yield* github.addRepository(pod, userId, repository);
				if (!added) return yield* new RepositoryAlreadyAdded();
				return added;
			}),

		removeRepository: (podId: string, repositoryId: string) =>
			Effect.asVoid(github.removeRepository(podId, repositoryId)),
	};
}
