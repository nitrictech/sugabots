export * as GitHosts from "./git-hosts.ts";

import { isIP } from "node:net";
import {
	type AvailableRepositories,
	GIT_HOST_WEBHOOK_PATH,
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	type GitHost,
	type GitHostSetupFailure,
	type GitHubAppForm,
	type PodRepositories,
} from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Clock, Context, Data, type DateTime, Effect, Layer, Schema } from "effect";
import type { AuthorizationDenied } from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import { CurrentActor } from "../authorization/current-actor.ts";
import { Credentials } from "../credentials/credentials.ts";
import { type Database, query, serviceOperations } from "../database/database.ts";
import {
	agent,
	gitHost,
	podRepository,
	thread,
	toolCall,
	user,
	workspace,
} from "../database/schema.ts";
import { Ids } from "../ids/ids.ts";
import { Installation } from "../installation/installation.ts";
import { Egress, isPrivateAddress } from "../providers/network/egress.ts";
import { type UserFacing, UserMessage } from "../user-message.ts";
import { type Credential, sealed, unsealed } from "./credential.ts";
import * as GitHub from "./github.ts";
import { type PushFailed, pushBundle } from "./push.ts";

/**
 * The places a workspace keeps code, and the repositories each pod's agents
 * work on there. A workspace makes its own GitHub App, from a manifest
 * Sugabots writes, and installs it on an account; a pod picks repositories
 * the app reaches. Agents read those in their sandbox with short-lived
 * read-only tokens, and push branches and open pull requests only through
 * Sugabots, once someone allowed it, with tokens the sandbox never holds.
 *
 * Setting up a workspace's hosts takes `workspace.providers.manage`. Seeing a
 * pod's repositories takes `pod.read`; changing them, `connection.manage`,
 * as they are outside services the pod's agents use, like its connections.
 */
export interface Interface {
	readonly list: (
		workspace: string,
	) => Effect.Effect<readonly GitHost[], AuthorizationDenied, CurrentActor.Service>;
	/** The form that makes a GitHub App for the workspace, owned by `organization` or by the person. */
	readonly startGitHubApp: (input: {
		workspace: string;
		organization: string | undefined;
	}) => Effect.Effect<GitHubAppForm, AuthorizationDenied, CurrentActor.Service>;
	/**
	 * Keeps the app GitHub made from the manifest, given the `code` it sent the
	 * browser back with, and says where to install it.
	 */
	readonly gitHubAppMade: (callback: {
		code: string | undefined;
		state: string | undefined;
	}) => Effect.Effect<SetupOutcome, never, CurrentActor.Service>;
	/**
	 * Admits an event a host delivered when `signature` proves it came from
	 * the host's app. Events aren't acted on yet.
	 */
	readonly delivery: (input: {
		gitHostId: string;
		event: string | undefined;
		body: string;
		signature: string | undefined;
	}) => Effect.Effect<void, DeliveryRefused>;
	/** Records the account the app was installed on. */
	readonly gitHubAppInstalled: (callback: {
		installationId: number | undefined;
		state: string | undefined;
	}) => Effect.Effect<SetupOutcome, never, CurrentActor.Service>;
	/** Where to install an app that isn't installed yet, or to change which repositories it reaches. */
	readonly installUrl: (input: {
		workspace: string;
		gitHostId: string;
	}) => Effect.Effect<string, AuthorizationDenied | GitHostNotFound, CurrentActor.Service>;
	/**
	 * Forgets the host and the pods' repositories there. The app stays on
	 * GitHub until its owner deletes it there.
	 */
	readonly remove: (input: {
		workspace: string;
		gitHostId: string;
	}) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;

	readonly podRepositories: (
		podId: string,
	) => Effect.Effect<PodRepositories, AuthorizationDenied, CurrentActor.Service>;
	/** What the workspace's installed apps reach, for a pod to pick from. */
	readonly availableRepositories: (
		podId: string,
	) => Effect.Effect<
		AvailableRepositories,
		AuthorizationDenied | GitHub.GitHubFailed,
		CurrentActor.Service
	>;
	readonly addRepository: (input: {
		podId: string;
		gitHostId: string;
		repository: string;
	}) => Effect.Effect<
		PodRepositories,
		AuthorizationDenied | RepositoryUnreachable | GitHub.GitHubFailed,
		CurrentActor.Service
	>;
	/** Removing one the pod doesn't have changes nothing. */
	readonly removeRepository: (input: {
		podId: string;
		gitHostId: string;
		repository: string;
	}) => Effect.Effect<PodRepositories, AuthorizationDenied, CurrentActor.Service>;

	/** The pod's repositories, for its agents to be told of. */
	readonly repositoriesOf: (pod: Pod) => Effect.Effect<readonly string[]>;
	/**
	 * Read-only tokens for the pod's repositories, one for each account they
	 * are on, for its sandbox's commands. A host that won't give one is left
	 * out, and logged.
	 */
	readonly readAccess: (pod: Pod) => Effect.Effect<readonly ReadAccess[]>;
	/** The turn's call `sdkToolCallId`, if a person allowed it: what pushes and pull requests go out under. */
	readonly allowedRequest: (input: {
		turnId: string;
		sdkToolCallId: string;
	}) => Effect.Effect<AllowedRequest | undefined>;
	/** Pushes `commit`, carried by `bundle`, to `branch` of one of the pod's repositories. */
	readonly push: (
		request: AllowedRequest,
		input: {
			repository: string;
			bundle: Uint8Array;
			commit: string;
			branch: string;
			force: boolean;
		},
	) => Effect.Effect<{ url: string }, NotPodRepository | GitHub.GitHubFailed | PushFailed>;
	/**
	 * Opens a pull request from `head` on one of the pod's repositories, into
	 * `base` or its default branch, saying which agent opened it and who
	 * allowed it.
	 */
	readonly openPullRequest: (
		request: AllowedRequest,
		input: {
			repository: string;
			head: string;
			base: string | undefined;
			title: string;
			body: string;
			draft: boolean;
			agentId: string;
		},
	) => Effect.Effect<{ number: number; url: string }, NotPodRepository | GitHub.GitHubFailed>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/GitHosts") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHosts");
	const authorization = yield* Authorization.Service;
	const credentials = yield* Credentials.Service;
	const installation = yield* Installation.Service;
	const ids = yield* Ids.Service;
	const http = (yield* Egress.Service).providers.for({ baseUrl: GitHub.API_URL });
	const apiUrl = `${installation.publicUrl}${API_BASE_PATH}`;
	const webhooksReachable = reachableFromInternet(installation.publicUrl);

	const managed = (workspaceRef: string) =>
		authorization.workspace(workspaceRef, "workspace.providers.manage");

	const hostsOf = (workspaceId: string) =>
		query((db) =>
			db
				.select()
				.from(gitHost)
				.where(eq(gitHost.workspaceId, workspaceId))
				.orderBy(asc(gitHost.createdAt)),
		);

	const hostOf = (workspaceId: string, gitHostId: string) =>
		query((db) =>
			db
				.select()
				.from(gitHost)
				.where(and(eq(gitHost.workspaceId, workspaceId), eq(gitHost.id, gitHostId)))
				.limit(1),
		).pipe(Effect.map(([row]) => row));

	const shown = (row: HostRow): GitHost => {
		const credential = unsealed(credentials, row.credentialEncrypted);
		return {
			id: row.id,
			kind: row.kind,
			name: row.name,
			account: row.account,
			settingsUrl: GitHub.appSettingsUrl(credential.slug),
			createdAt: row.createdAt.toISOString(),
		};
	};

	/** The setup step a `state` was handed out for, if it is that step's, current, and the caller's. */
	const stateOf = (state: string | undefined, step: SetupState["step"]) =>
		Effect.gen(function* () {
			if (!state) return undefined;
			const { userId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const decoded = yield* Effect.try(() => credentials.decrypt(state)).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(SetupStateJson)),
				Effect.option,
			);
			if (decoded._tag === "None") return undefined;
			const setup = decoded.value;
			return setup.step === step && setup.userId === userId && setup.expiresAt > now
				? setup
				: undefined;
		});

	const stateFor = (step: Omit<SetupState, "userId" | "expiresAt">) =>
		Effect.gen(function* () {
			const { userId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const encoded = yield* Schema.encodeEffect(SetupStateJson)({
				...step,
				userId,
				expiresAt: now + SETUP_STATE_LIFETIME_MILLISECONDS,
			}).pipe(Effect.orDie);
			return credentials.encrypt(encoded);
		});

	const installedApp = (row: HostRow) => {
		const credential = unsealed(credentials, row.credentialEncrypted);
		return credential.installationId === null
			? undefined
			: { ...credential, installationId: credential.installationId };
	};

	const podRepositoryRows = (pod: Pod) =>
		query((db) =>
			db
				.select()
				.from(podRepository)
				.where(
					and(eq(podRepository.workspaceId, pod.workspaceId), eq(podRepository.podId, pod.podId)),
				)
				.orderBy(asc(podRepository.repository)),
		);

	const repositoriesShown = (pod: Pod) =>
		Effect.gen(function* () {
			const rows = yield* podRepositoryRows(pod);
			const adderIds = [...new Set(rows.flatMap((row) => (row.addedById ? [row.addedById] : [])))];
			const adders =
				adderIds.length === 0
					? []
					: yield* query((db) =>
							db
								.select({ id: user.id, name: user.name })
								.from(user)
								.where(inArray(user.id, adderIds)),
						);
			const names = new Map(adders.map((adder) => [adder.id, adder.name]));
			return {
				repositories: rows.map((row) => ({
					gitHostId: row.gitHostId,
					repository: row.repository,
					addedByName: (row.addedById && names.get(row.addedById)) ?? null,
					addedAt: row.createdAt.toISOString(),
				})),
			} satisfies PodRepositories;
		});

	const podOf = (standing: { pod: { id: string; workspaceId: string } }): Pod => ({
		workspaceId: standing.pod.workspaceId,
		podId: standing.pod.id,
	});

	/** The installed app behind one of the pod's repositories, with the repository's name there. */
	const reaching = (pod: Pod, repository: string) =>
		Effect.gen(function* () {
			const rows = yield* query((db) =>
				db
					.select({ host: gitHost })
					.from(podRepository)
					.innerJoin(gitHost, eq(gitHost.id, podRepository.gitHostId))
					.where(
						and(
							eq(podRepository.workspaceId, pod.workspaceId),
							eq(podRepository.podId, pod.podId),
							eq(podRepository.repository, repository),
						),
					)
					.limit(1),
			);
			const app = rows[0] && installedApp(rows[0].host);
			if (!app) {
				const repositories = (yield* podRepositoryRows(pod)).map((row) => row.repository);
				return yield* new NotPodRepository({ repository, repositories });
			}
			return { app, name: repositoryName(repository) };
		});

	return Service.of({
		list: (workspaceRef) =>
			operation(
				"list",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspaceRef);
					return (yield* hostsOf(workspaceId)).map(shown);
				}),
			),

		startGitHubApp: ({ workspace: workspaceRef, organization }) =>
			operation(
				"startGitHubApp",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspaceRef);
					const [named] = yield* query((db) =>
						db
							.select({ name: workspace.name })
							.from(workspace)
							.where(eq(workspace.id, workspaceId)),
					);
					// The host's id is in its webhook's URL, so it is minted before GitHub makes the app.
					const gitHostId = yield* ids.next;
					const state = yield* stateFor({ step: "make", workspaceId, gitHostId });
					const manifest = GitHub.appManifest({
						name: `${named?.name ?? "Workspace"} Sugabots`
							.slice(0, GitHub.MAX_APP_NAME_LENGTH)
							.trim(),
						homepageUrl: installation.webAppUrl,
						redirectUrl: `${apiUrl}${GITHUB_APP_MADE_PATH}`,
						setupUrl: `${apiUrl}${GITHUB_APP_INSTALLED_PATH}`,
						webhookUrl: webhooksReachable
							? `${apiUrl}${GIT_HOST_WEBHOOK_PATH}/${gitHostId}`
							: undefined,
					});
					return {
						url: GitHub.newAppUrl(organization, state),
						manifest: JSON.stringify(manifest),
					};
				}),
			),

		gitHubAppMade: ({ code, state }) =>
			operation(
				"gitHubAppMade",
				Effect.gen(function* (): Effect.fn.Return<
					SetupOutcome,
					never,
					CurrentActor.Service | Database
				> {
					const setup = yield* stateOf(state, "make");
					if (!setup?.gitHostId) {
						return { kind: "failed", workspaceId: undefined, failure: "expired" };
					}
					const { workspaceId, gitHostId } = setup;
					if (!code) return { kind: "failed", workspaceId, failure: "cancelled" };
					const allowed = yield* managed(workspaceId).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false),
					);
					if (!allowed) return { kind: "failed", workspaceId: undefined, failure: "expired" };
					const made = yield* GitHub.madeApp(http, code).pipe(
						Effect.tapError((failure) =>
							Effect.logWarning("GitHub didn't make the app", failure.message),
						),
						Effect.option,
					);
					if (made._tag === "None") return { kind: "failed", workspaceId, failure: "github" };
					const credential: Credential = {
						kind: "github",
						appId: made.value.id,
						slug: made.value.slug,
						privateKey: made.value.pem,
						installationId: null,
						webhookSecret: made.value.webhook_secret,
					};
					const { userId } = yield* CurrentActor.Service;
					const [row] = yield* query((db) =>
						db
							.insert(gitHost)
							.values({
								id: gitHostId,
								workspaceId,
								kind: "github",
								name: made.value.name,
								credentialEncrypted: sealed(credentials, credential),
								createdById: userId,
							})
							.returning({ id: gitHost.id }),
					);
					if (!row) return { kind: "failed", workspaceId, failure: "github" };
					const next = yield* stateFor({ step: "install", workspaceId, gitHostId: row.id });
					return { kind: "next", url: GitHub.installAppUrl(made.value.slug, next) };
				}),
			),

		delivery: ({ gitHostId, event, body, signature }) =>
			operation(
				"delivery",
				Effect.gen(function* () {
					const [row] = yield* query((db) =>
						db.select().from(gitHost).where(eq(gitHost.id, gitHostId)).limit(1),
					);
					const secret = row && unsealed(credentials, row.credentialEncrypted).webhookSecret;
					if (!secret || !GitHub.signedDelivery(secret, body, signature)) {
						return yield* new DeliveryRefused();
					}
					yield* Effect.logDebug("Git host event received", { gitHostId, event });
				}),
			),

		gitHubAppInstalled: ({ installationId, state }) =>
			operation(
				"gitHubAppInstalled",
				Effect.gen(function* (): Effect.fn.Return<
					SetupOutcome,
					never,
					CurrentActor.Service | Database
				> {
					const setup = yield* stateOf(state, "install");
					if (!setup?.gitHostId) {
						return { kind: "failed", workspaceId: undefined, failure: "expired" };
					}
					const { workspaceId, gitHostId } = setup;
					if (installationId === undefined) {
						return { kind: "failed", workspaceId, failure: "cancelled" };
					}
					const allowed = yield* managed(workspaceId).pipe(
						Effect.as(true),
						Effect.orElseSucceed(() => false),
					);
					const row = allowed ? yield* hostOf(workspaceId, gitHostId) : undefined;
					if (!row) return { kind: "failed", workspaceId: undefined, failure: "expired" };
					const credential = unsealed(credentials, row.credentialEncrypted);
					// Only the app's own installations are found with its key, so a
					// made-up id can't attach another account's.
					const installed = yield* GitHub.installation(http, credential, installationId).pipe(
						Effect.tapError((failure) =>
							Effect.logWarning("Couldn't find the app's installation", failure.message),
						),
						Effect.option,
					);
					if (installed._tag === "None") return { kind: "failed", workspaceId, failure: "github" };
					yield* query((db) =>
						db
							.update(gitHost)
							.set({
								account: installed.value.account.login,
								credentialEncrypted: sealed(credentials, { ...credential, installationId }),
							})
							.where(eq(gitHost.id, row.id)),
					);
					return { kind: "done", workspaceId };
				}),
			),

		installUrl: ({ workspace: workspaceRef, gitHostId }) =>
			operation(
				"installUrl",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspaceRef);
					const row = yield* hostOf(workspaceId, gitHostId);
					if (!row) return yield* new GitHostNotFound();
					const credential = unsealed(credentials, row.credentialEncrypted);
					const state = yield* stateFor({ step: "install", workspaceId, gitHostId });
					return GitHub.installAppUrl(credential.slug, state);
				}),
			),

		remove: ({ workspace: workspaceRef, gitHostId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { workspaceId } = yield* managed(workspaceRef);
					yield* query((db) =>
						db
							.delete(gitHost)
							.where(and(eq(gitHost.workspaceId, workspaceId), eq(gitHost.id, gitHostId))),
					);
				}),
			),

		podRepositories: (podId) =>
			operation(
				"podRepositories",
				Effect.flatMap(authorization.pod(podId, "pod.read"), (standing) =>
					repositoriesShown(podOf(standing)),
				),
			),

		availableRepositories: (podId) =>
			operation(
				"availableRepositories",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "connection.manage"));
					const hosts = yield* hostsOf(pod.workspaceId);
					const listed = yield* Effect.forEach(hosts, (row) => {
						const app = installedApp(row);
						if (!app) return Effect.succeed([]);
						return GitHub.repositories(http, app).pipe(
							Effect.map((repositories) =>
								repositories.map((repository) => ({
									gitHostId: row.id,
									repository: repository.fullName,
									private: repository.private,
								})),
							),
						);
					});
					return listed.flat();
				}),
			),

		addRepository: ({ podId, gitHostId, repository }) =>
			operation(
				"addRepository",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "connection.manage"));
					const row = yield* hostOf(pod.workspaceId, gitHostId);
					const app = row && installedApp(row);
					if (!app) return yield* new RepositoryUnreachable({ repository });
					const reachable = yield* GitHub.repositories(http, app);
					if (!reachable.some((one) => one.fullName.toLowerCase() === repository.toLowerCase())) {
						return yield* new RepositoryUnreachable({ repository });
					}
					const { userId } = yield* CurrentActor.Service;
					yield* query((db) =>
						db
							.insert(podRepository)
							.values({ ...pod, gitHostId, repository, addedById: userId })
							.onConflictDoNothing(),
					);
					return yield* repositoriesShown(pod);
				}),
			),

		removeRepository: ({ podId, gitHostId, repository }) =>
			operation(
				"removeRepository",
				Effect.gen(function* () {
					const pod = podOf(yield* authorization.pod(podId, "connection.manage"));
					yield* query((db) =>
						db
							.delete(podRepository)
							.where(
								and(
									eq(podRepository.podId, pod.podId),
									eq(podRepository.gitHostId, gitHostId),
									eq(podRepository.repository, repository),
								),
							),
					);
					return yield* repositoriesShown(pod);
				}),
			),

		repositoriesOf: (pod) =>
			operation(
				"repositoriesOf",
				Effect.map(podRepositoryRows(pod), (rows) => rows.map((row) => row.repository)),
			),

		readAccess: (pod) =>
			operation(
				"readAccess",
				Effect.gen(function* () {
					const rows = yield* query((db) =>
						db
							.select({ host: gitHost, repository: podRepository.repository })
							.from(podRepository)
							.innerJoin(gitHost, eq(gitHost.id, podRepository.gitHostId))
							.where(
								and(
									eq(podRepository.workspaceId, pod.workspaceId),
									eq(podRepository.podId, pod.podId),
								),
							),
					);
					const byHost = Map.groupBy(rows, (row) => row.host.id);
					const granted = yield* Effect.forEach([...byHost.values()], (hostRows) => {
						const [first] = hostRows;
						const app = first && installedApp(first.host);
						if (!app || !first.host.account) return Effect.succeed([]);
						const account = first.host.account;
						return GitHub.accessToken(http, app, {
							repositories: hostRows.map((row) => repositoryName(row.repository)),
							permissions: GitHub.READ_PERMISSIONS,
						}).pipe(
							Effect.map((token): ReadAccess[] => [{ account, ...token }]),
							Effect.catch((failure) =>
								Effect.as(
									Effect.logWarning("Couldn't get a read token for a pod's repositories", failure),
									[],
								),
							),
						);
					});
					return granted.flat();
				}),
			),

		allowedRequest: ({ turnId, sdkToolCallId }) =>
			operation(
				"allowedRequest",
				Effect.gen(function* () {
					const [call] = yield* query((db) =>
						db
							.select({
								workspaceId: thread.workspaceId,
								podId: thread.podId,
								approvalStatus: toolCall.approvalStatus,
								decidedById: toolCall.decidedById,
							})
							.from(toolCall)
							.innerJoin(thread, eq(thread.id, toolCall.threadId))
							.where(and(eq(toolCall.turnId, turnId), eq(toolCall.sdkToolCallId, sdkToolCallId)))
							.limit(1),
					);
					if (call?.approvalStatus !== "allowed") return undefined;
					return allowed({
						pod: { workspaceId: call.workspaceId, podId: call.podId },
						decidedById: call.decidedById,
					});
				}),
			),

		push: (request, { repository, bundle, commit, branch, force }) =>
			operation(
				"push",
				Effect.gen(function* () {
					const { app, name } = yield* reaching(request.pod, repository);
					const { token } = yield* GitHub.accessToken(http, app, {
						repositories: [name],
						permissions: { contents: "write" },
					});
					yield* pushBundle({
						bundle,
						commit,
						remoteUrl: `${GitHub.WEB_URL}/${repository}.git`,
						token,
						branch,
						force,
					});
					return { url: `${GitHub.WEB_URL}/${repository}/tree/${branch}` };
				}),
			),

		openPullRequest: (request, { repository, head, base, title, body, draft, agentId }) =>
			operation(
				"openPullRequest",
				Effect.gen(function* () {
					const { app, name } = yield* reaching(request.pod, repository);
					const { token } = yield* GitHub.accessToken(http, app, {
						repositories: [name],
						permissions: { pull_requests: "write", contents: "read" },
					});
					const [opener] = yield* query((db) =>
						db.select({ name: agent.name }).from(agent).where(eq(agent.id, agentId)),
					);
					const [decider] = request.decidedById
						? yield* query((db) =>
								db
									.select({ name: user.name })
									.from(user)
									.where(eq(user.id, request.decidedById ?? "")),
							)
						: [];
					return yield* GitHub.openPullRequest(http, token, {
						repository,
						head,
						base: base ?? (yield* GitHub.defaultBranch(http, token, repository)),
						title,
						body: `${body}\n\n---\n${attribution(opener?.name, decider?.name)}`,
						draft,
					});
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide(Authorization.layer));

type HostRow = typeof gitHost.$inferSelect;

export interface Pod {
	readonly workspaceId: string;
	readonly podId: string;
}

/** A token the sandbox reads `account`'s repositories with, until `expiresAt`. */
export interface ReadAccess {
	readonly account: string;
	readonly token: string;
	readonly expiresAt: DateTime.Utc;
}

/**
 * Where a GitHub setup step goes next: on to GitHub to install the app, back
 * to the workspace's settings, or back with why it stopped. A failure names
 * the workspace only when the caller still manages it.
 */
export type SetupOutcome =
	| { readonly kind: "next"; readonly url: string }
	| { readonly kind: "done"; readonly workspaceId: string }
	| {
			readonly kind: "failed";
			readonly workspaceId: string | undefined;
			readonly failure: GitHostSetupFailure;
	  };

/** How long a person has to finish a step on GitHub's pages. */
const SETUP_STATE_LIFETIME_MILLISECONDS = 60 * 60 * 1000;

/**
 * What a setup step's `state` carries through GitHub, sealed so it can't be
 * read or changed there: the step, whose it is, and until when.
 */
const SetupState = Schema.Struct({
	step: Schema.Literals(["make", "install"]),
	workspaceId: Schema.String,
	gitHostId: Schema.optional(Schema.String),
	userId: Schema.String,
	expiresAt: Schema.Finite,
});
type SetupState = typeof SetupState.Type;

const SetupStateJson = Schema.fromJsonString(SetupState);

/** `owner/name`'s name: what an installation token is asked for by. */
function repositoryName(repository: string) {
	return repository.slice(repository.indexOf("/") + 1);
}

function attribution(agentName: string | undefined, deciderName: string | undefined) {
	const opener = agentName ? `**${agentName}**, an agent in Sugabots,` : "An agent in Sugabots";
	return deciderName
		? `${opener} opened this pull request, which ${deciderName} allowed.`
		: `${opener} opened this pull request.`;
}

declare const allowedBrand: unique symbol;

/** A push or pull request a person allowed, as only {@link Interface.allowedRequest} finds one. */
export interface AllowedRequest {
	readonly pod: Pod;
	/** Who allowed it; null once they've left. */
	readonly decidedById: string | null;
	readonly [allowedBrand]: true;
}

const allowed = (request: Omit<AllowedRequest, typeof allowedBrand>) => request as AllowedRequest;

/** A delivery for no host, or one its signature doesn't prove came from the host's app. */
export class DeliveryRefused extends Data.TaggedError("DeliveryRefused") {}

/** Names that only resolve on this machine or its network. */
const LOCAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * Whether GitHub could plausibly reach `url`: not a local-only name, nor a
 * private or reserved address. Judged from the URL alone, so a tunnel's
 * public name passes.
 */
function reachableFromInternet(url: string) {
	const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const family = isIP(hostname);
	if (family === 4 || family === 6) return !isPrivateAddress(hostname, family);
	return (
		hostname !== "localhost" && !LOCAL_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
	);
}

export class GitHostNotFound extends Data.TaggedError("GitHostNotFound") implements UserFacing {
	get userMessage() {
		return UserMessage.of`This workspace has no such git host`;
	}
}

export class RepositoryUnreachable
	extends Data.TaggedError("RepositoryUnreachable")<{ repository: string }>
	implements UserFacing
{
	get userMessage() {
		return UserMessage.of`The workspace's GitHub App can't reach ${UserMessage.unchecked(this.repository)}. Add it to the app's repositories on GitHub first.`;
	}
}

/** A push or pull request for a repository the pod doesn't have; `repositories` are those it does. */
export class NotPodRepository extends Data.TaggedError("NotPodRepository")<{
	repository: string;
	repositories: readonly string[];
}> {}
