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
import { type Database, query, serviceOperations } from "../../../database/database.ts";
import { bot } from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { ServerSettings } from "../../../server-settings/server-settings.ts";
import { Egress, isPrivateAddress } from "../../network/egress.ts";
import { ConnectorStore } from "../connector-store.ts";
import { encryptAppCredential, openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import {
	gitHubConnectorForProject,
	NotGitHubConnector,
	ProjectHasGitHubConnector,
} from "./github-connectors.ts";

/**
 * Connecting a project to GitHub: a member makes the project its own private
 * GitHub App, from a manifest Sugabots writes, owned by the account whose
 * repositories the project's bots work on, then installs it there; GitHub
 * sends the browser back to Sugabots after each step. The app is the
 * project's GitHub connector, made once GitHub has made the app, and signed
 * in once it is installed. Each step takes `connector.manage` in the project;
 * a bot's GitHub app is its default project's.
 */
export interface Interface {
	/** The form that makes the project's GitHub App, owned by `organization` or by the member. */
	readonly start: (input: {
		projectId: string;
		organization: string | undefined;
	}) => Effect.Effect<
		GitHubAppForm,
		AuthorizationDenied | ProjectHasGitHubConnector,
		CurrentActor.Service
	>;
	/**
	 * Makes the project's GitHub connector to the app GitHub made from the
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
	/** Where to install the connector's app, or to change which repositories it reaches. */
	readonly installUrl: (input: {
		projectId: string;
		connectorId: string;
	}) => Effect.Effect<string, AuthorizationDenied | NotGitHubConnector, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/GitHubApps") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubApps");
	const authorization = yield* Authorization.Service;
	const secrets = yield* Secrets.Service;
	const serverSettings = yield* ServerSettings.Service;
	const connectors = yield* ConnectorStore.Service;
	const ids = yield* Ids.Service;
	const http = (yield* Egress.Service).providers.for({ baseUrl: GitHub.API_URL });
	const apiUrl = `${serverSettings.publicUrl}${API_BASE_PATH}`;
	const webhooksReachable = reachableFromInternet(serverSettings.publicUrl);

	const managed = (projectId: string) =>
		Effect.map(authorization.project(projectId, "connector.manage"), ({ project }) => project);

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
			const { memberId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const encoded = Schema.encodeSync(SetupStateJson)({
				...step,
				memberId,
				expiresAt: now + SETUP_STATE_LIFETIME_MILLISECONDS,
			});
			return secrets.encrypt(encoded, SETUP_STATE_PURPOSE);
		});

	/** The step `state` was handed out for, if it is that step's, current, and the caller's. */
	const stepOf = (state: string | undefined, step: SetupStep["step"]) =>
		Effect.gen(function* () {
			if (!state) return undefined;
			const { memberId } = yield* CurrentActor.Service;
			const now = yield* Clock.currentTimeMillis;
			const opened = Option.liftThrowable(() =>
				Schema.decodeSync(SetupStateJson)(secrets.decrypt(state, SETUP_STATE_PURPOSE)),
			)();
			if (Option.isNone(opened)) return undefined;
			const setup = opened.value;
			return setup.step === step && setup.memberId === memberId && setup.expiresAt > now
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
						yield* gitHubConnectorForProject({
							workspaceId: project.workspaceId,
							projectId: project.id,
						})
					) {
						return yield* new ProjectHasGitHubConnector();
					}
					// The connector's id is in its webhook's address, so it is minted before GitHub makes the app.
					const connectorId = yield* ids.next;
					const state = yield* stateFor({
						step: "make",
						workspaceId: project.workspaceId,
						projectId: project.id,
						connectorId,
					});
					const manifest = GitHub.appManifest({
						name: appName(yield* nameOf(project), connectorId),
						homepageUrl: serverSettings.webAppUrl,
						redirectUrl: `${apiUrl}${GITHUB_APP_MADE_PATH}`,
						setupUrl: `${apiUrl}${GITHUB_APP_INSTALLED_PATH}`,
						webhookUrl: webhooksReachable
							? `${apiUrl}${GITHUB_WEBHOOK_PATH}/${connectorId}`
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
					const { memberId } = yield* CurrentActor.Service;
					const created = yield* connectors
						.createGitHub(setup.workspaceId, setup.projectId, memberId, {
							id: setup.connectorId,
							app: { appId: app.id, slug: app.slug, owner: app.owner },
							appCredentialEncrypted: encryptAppCredential(secrets, {
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
						? yield* gitHubConnectorForProject(setup)
						: undefined;
					if (!row?.settings || !row.appCredentialEncrypted || row.id !== setup.connectorId) {
						return failed(undefined, "expired");
					}
					const { privateKey } = openAppCredential(secrets, row.appCredentialEncrypted);
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
					const { id, account, onUserAccount } = found.value;
					yield* connectors.installed(setup.workspaceId, row.id, {
						installationId: id,
						account,
						// Only a member's own account is theirs alone, so only then is the installation theirs.
						installedById: onUserAccount ? setup.memberId : null,
					});
					return {
						kind: "done",
						at: setupProjectOf(setup),
						connectorId: row.id,
					};
				}),
			),

		installUrl: ({ projectId, connectorId }) =>
			operation(
				"installUrl",
				Effect.gen(function* () {
					const project = yield* managed(projectId);
					const row = yield* gitHubConnectorForProject({
						workspaceId: project.workspaceId,
						projectId: project.id,
					});
					if (!row?.settings || row.id !== connectorId) return yield* new NotGitHubConnector();
					const state = yield* stateFor({
						step: "install",
						workspaceId: project.workspaceId,
						projectId: project.id,
						connectorId,
					});
					return GitHub.installAppUrl(row.settings.slug, state);
				}),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, ConnectorStore.layer]));

/**
 * Where a GitHub setup step goes next: on to GitHub, back to the project's
 * connector, or back with why it stopped. A failure names the project only
 * when the step was the caller's.
 */
export type SetupOutcome =
	| { readonly kind: "next"; readonly url: string }
	| { readonly kind: "done"; readonly at: SetupProject; readonly connectorId: string }
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

/** How long a member has to finish a step on GitHub's pages. */
const SETUP_STATE_LIFETIME_MILLISECONDS = 60 * 60 * 1000;

const SETUP_STATE_PURPOSE = "github-app-setup";

/** A step of setting up a project's GitHub App, for the connector it is or will be. */
interface SetupStep extends SetupProject {
	readonly step: "make" | "install";
	readonly connectorId: string;
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
		connectorId: Schema.String,
		memberId: Schema.String,
		expiresAt: Schema.Finite,
	}),
);

/** How many characters of the connector's id end its app's name. */
const APP_NAME_SUFFIX_LENGTH = 4;

/**
 * The name the project's app is made with: "Sugabots" and the project's name,
 * or its bot's for a default project, ended with part of the connector's id,
 * since an app's name is unique across all of GitHub, and cut to the longest
 * name GitHub takes.
 */
function appName(projectName: string, connectorId: string): string {
	const suffix = ` ${connectorId.slice(-APP_NAME_SUFFIX_LENGTH)}`;
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
