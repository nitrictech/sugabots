export * as GitHubApps from "./github-app.ts";

import { isIP } from "node:net";
import {
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	GITHUB_WEBHOOK_PATH,
	type GitHubAppForm,
	type GitHubSetupFailure,
} from "@sugabots/contracts";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import type { AuthorizationDenied } from "../../../authorization/access.ts";
import { Authorization } from "../../../authorization/authorization.ts";
import { CurrentActor } from "../../../authorization/current-actor.ts";
import { Credentials } from "../../../credentials/credentials.ts";
import { type Database, query, serviceOperations } from "../../../database/database.ts";
import { bot } from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import { Installation } from "../../../installation/installation.ts";
import { Egress, isPrivateAddress } from "../../network/egress.ts";
import { ConnectionRepository } from "../connection-repository.ts";
import { openAppCredential, sealAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import {
	gitHubConnectionForProject,
	NotGitHubConnection,
	ProjectHasGitHubConnection,
} from "./github-connections.ts";

/**
 * Connecting a project to GitHub: a person makes the project its own private
 * GitHub App, from a manifest Sugabots writes, owned by the account whose
 * repositories the project's bots work on, then installs it there; GitHub
 * sends the browser back to Sugabots after each step. The app is the
 * project's GitHub connection, made once GitHub has made the app, and signed
 * in once it is installed. Each step takes `connection.manage` in the project;
 * a bot's GitHub app is its default project's.
 */
export interface Interface {
	/** The form that makes the project's GitHub App, owned by `organization` or by the person. */
	readonly start: (input: {
		projectId: string;
		organization: string | undefined;
	}) => Effect.Effect<
		GitHubAppForm,
		AuthorizationDenied | ProjectHasGitHubConnection,
		CurrentActor.Service
	>;
	/**
	 * Makes the project's GitHub connection to the app GitHub made from the
	 * manifest, given the `code` it sent the browser back with, and says where
	 * to install it.
	 */
	readonly made: (callback: {
		code: string | undefined;
		state: string | undefined;
	}) => Effect.Effect<SetupOutcome, never, CurrentActor.Service>;
	/** Records the account the app was installed on, or installed on again. */
	readonly installed: (callback: {
		installationId: number | undefined;
		state: string | undefined;
	}) => Effect.Effect<SetupOutcome, never, CurrentActor.Service>;
	/** Where to install the connection's app, or to change which repositories it reaches. */
	readonly installUrl: (input: {
		projectId: string;
		connectionId: string;
	}) => Effect.Effect<string, AuthorizationDenied | NotGitHubConnection, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/GitHubApps") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubApps");
	const authorization = yield* Authorization.Service;
	const credentials = yield* Credentials.Service;
	const installation = yield* Installation.Service;
	const connections = yield* ConnectionRepository.Service;
	const ids = yield* Ids.Service;
	const http = (yield* Egress.Service).providers.for({ baseUrl: GitHub.API_URL });
	const apiUrl = `${installation.publicUrl}${API_BASE_PATH}`;
	const webhooksReachable = reachableFromInternet(installation.publicUrl);

	const managed = (projectId: string) =>
		Effect.map(authorization.project(projectId, "connection.manage"), ({ project }) => project);

	const managedQuietly = (projectId: string) =>
		managed(projectId).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
		);

	/** What the project is called: its own name, or its bot's for a default project. */
	const nameOf = ({ name, defaultOfBotId }: { name: string; defaultOfBotId: string | null }) => {
		if (defaultOfBotId === null) return Effect.succeed(name);
		return Effect.map(
			query((db) =>
				db.select({ name: bot.name }).from(bot).where(eq(bot.id, defaultOfBotId)).limit(1),
			),
			([row]) => row?.name ?? name,
		);
	};

	const stateFor = (step: SetupStep) =>
		Effect.gen(function* () {
			const { userId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const encoded = Schema.encodeSync(SetupStateJson)({
				...step,
				userId,
				expiresAt: now + SETUP_STATE_LIFETIME_MILLISECONDS,
			});
			return credentials.encrypt(encoded, SETUP_STATE_PURPOSE);
		});

	/** The step `state` was handed out for, if it is that step's, current, and the caller's. */
	const stepOf = (state: string | undefined, step: SetupStep["step"]) =>
		Effect.gen(function* () {
			if (!state) return undefined;
			const { userId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const opened = Option.liftThrowable(() =>
				Schema.decodeSync(SetupStateJson)(credentials.decrypt(state, SETUP_STATE_PURPOSE)),
			)();
			if (Option.isNone(opened)) return undefined;
			const setup = opened.value;
			return setup.step === step && setup.userId === userId && setup.expiresAt > now
				? setup
				: undefined;
		});

	const failed = (setup: SetupStep | undefined, failure: GitHubSetupFailure): SetupOutcome => ({
		kind: "failed",
		at: setup && setupProjectOf(setup),
		failure,
	});

	return Service.of({
		start: ({ projectId, organization }) =>
			operation(
				"start",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					if (
						yield* gitHubConnectionForProject({
							workspaceId: project.workspaceId,
							projectId: project.id,
						})
					) {
						return yield* new ProjectHasGitHubConnection();
					}
					// The connection's id is in its webhook's address, so it is minted before GitHub makes the app.
					const connectionId = yield* ids.next;
					const state = yield* stateFor({
						step: "make",
						workspaceId: project.workspaceId,
						projectId: project.id,
						connectionId,
					});
					const manifest = GitHub.appManifest({
						name: appName(yield* nameOf(project), connectionId),
						homepageUrl: installation.webAppUrl,
						redirectUrl: `${apiUrl}${GITHUB_APP_MADE_PATH}`,
						setupUrl: `${apiUrl}${GITHUB_APP_INSTALLED_PATH}`,
						webhookUrl: webhooksReachable
							? `${apiUrl}${GITHUB_WEBHOOK_PATH}/${connectionId}`
							: undefined,
					});
					return {
						url: GitHub.newAppUrl(organization, state),
						manifest: JSON.stringify(manifest),
					};
				}),
			),

		made: ({ code, state }) =>
			operation(
				"made",
				Effect.gen(function* (): Effect.fn.Return<
					SetupOutcome,
					never,
					CurrentActor.Service | Database
				> {
					const setup = yield* stepOf(state, "make");
					if (!setup) return failed(undefined, "expired");
					if (!code) return failed(setup, "cancelled");
					if (!(yield* managedQuietly(setup.projectId))) return failed(undefined, "expired");
					const made = yield* GitHub.madeApp(http, code).pipe(
						Effect.tapError((failure) => Effect.logWarning("GitHub didn't make the app", failure)),
						Effect.option,
					);
					if (Option.isNone(made)) return failed(setup, "github");
					const app = made.value;
					const { userId } = yield* CurrentActor.Service;
					const created = yield* connections
						.createGitHub(setup.workspaceId, setup.projectId, userId, {
							id: setup.connectionId,
							app: { appId: app.id, slug: app.slug, owner: app.owner },
							appCredentialEncrypted: sealAppCredential(credentials, {
								privateKey: app.pem,
								webhookSecret: app.webhook_secret,
							}),
						})
						.pipe(Effect.option);
					// The project was connected to GitHub another way meanwhile.
					if (Option.isNone(created)) return failed(setup, "github");
					const next = yield* stateFor({ ...setup, step: "install" });
					return { kind: "next", url: GitHub.installAppUrl(app.slug, next) };
				}),
			),

		installed: ({ installationId, state }) =>
			operation(
				"installed",
				Effect.gen(function* (): Effect.fn.Return<
					SetupOutcome,
					never,
					CurrentActor.Service | Database
				> {
					const setup = yield* stepOf(state, "install");
					if (!setup) return failed(undefined, "expired");
					if (installationId === undefined) return failed(setup, "cancelled");
					const row = (yield* managedQuietly(setup.projectId))
						? yield* gitHubConnectionForProject(setup)
						: undefined;
					if (!row?.settings || !row.appCredentialEncrypted || row.id !== setup.connectionId) {
						return failed(undefined, "expired");
					}
					const { privateKey } = openAppCredential(credentials, row.appCredentialEncrypted);
					// Only the app's own installations are found with its key, so a
					// made-up id can't attach another account's.
					const found = yield* GitHub.installation(
						http,
						{ appId: row.settings.appId, privateKey },
						installationId,
					).pipe(
						Effect.tapError((failure) =>
							Effect.logWarning("Couldn't find the app's installation", failure),
						),
						Effect.option,
					);
					if (Option.isNone(found)) return failed(setup, "github");
					const { id, account } = found.value;
					yield* connections.installed(setup.workspaceId, row.id, { installationId: id, account });
					return {
						kind: "done",
						at: setupProjectOf(setup),
						connectionId: row.id,
					};
				}),
			),

		installUrl: ({ projectId, connectionId }) =>
			operation(
				"installUrl",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					const row = yield* gitHubConnectionForProject({
						workspaceId: project.workspaceId,
						projectId: project.id,
					});
					if (!row?.settings || row.id !== connectionId) return yield* new NotGitHubConnection();
					const state = yield* stateFor({
						step: "install",
						workspaceId: project.workspaceId,
						projectId: project.id,
						connectionId,
					});
					return GitHub.installAppUrl(row.settings.slug, state);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(
	Layer.provide([Authorization.layer, ConnectionRepository.layer]),
);

/**
 * Where a GitHub setup step goes next: on to GitHub, back to the project's
 * connection, or back with why it stopped. A failure names the project only
 * when the step was the caller's.
 */
export type SetupOutcome =
	| { readonly kind: "next"; readonly url: string }
	| { readonly kind: "done"; readonly at: SetupProject; readonly connectionId: string }
	| {
			readonly kind: "failed";
			readonly at: SetupProject | undefined;
			readonly failure: GitHubSetupFailure;
	  };

/** The project being connected. */
interface SetupProject {
	readonly workspaceId: string;
	readonly projectId: string;
}

const setupProjectOf = ({ workspaceId, projectId }: SetupProject): SetupProject => ({
	workspaceId,
	projectId,
});

/** How long a person has to finish a step on GitHub's pages. */
const SETUP_STATE_LIFETIME_MILLISECONDS = 60 * 60 * 1000;

const SETUP_STATE_PURPOSE = "github-app-setup";

/** A step of setting up a project's GitHub App, for the connection it is or will be. */
interface SetupStep extends SetupProject {
	readonly step: "make" | "install";
	readonly connectionId: string;
}

/**
 * What a setup step's `state` carries through GitHub, sealed so it can't be
 * read or changed there: the step, whose it is, and until when.
 */
const SetupStateJson = Schema.fromJsonString(
	Schema.Struct({
		step: Schema.Literals(["make", "install"]),
		workspaceId: Schema.String,
		projectId: Schema.String,
		connectionId: Schema.String,
		userId: Schema.String,
		expiresAt: Schema.Finite,
	}),
);

/** How many characters of the connection's id end its app's name. */
const APP_NAME_SUFFIX_LENGTH = 4;

/**
 * The name the project's app is made with: "Sugabots" and the project's name,
 * or its bot's for a default project, ended with part of the connection's id,
 * since an app's name is unique across all of GitHub, and cut to the longest
 * name GitHub takes.
 */
function appName(projectName: string, connectionId: string): string {
	const suffix = ` ${connectionId.slice(-APP_NAME_SUFFIX_LENGTH)}`;
	const name = `Sugabots ${projectName}`
		.slice(0, GitHub.MAX_APP_NAME_LENGTH - suffix.length)
		.trim();
	return `${name}${suffix}`;
}

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
