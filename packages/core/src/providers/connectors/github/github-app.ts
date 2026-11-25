import { uuidSchema } from "@sugabots/contracts/uuid";

export * as GitHubApps from "./github-app.ts";

import { isIP } from "node:net";
import {
	GITHUB_APP_INSTALLED_PATH,
	GITHUB_APP_MADE_PATH,
	GITHUB_WEBHOOK_PATH,
	type GitHubAppForm,
	type GitHubSetupFailure,
	type GitHubSetupOutcome,
} from "@sugabots/contracts";
import {
	NotGitHubConnector,
	ProjectHasGitHubConnector,
} from "@sugabots/contracts/errors/connectors";
import { API_BASE_PATH } from "@sugabots/contracts/http";
import { and, eq, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
	type Database,
	query,
	serviceOperations,
	transaction,
} from "../../../database/database.ts";
import { bot, project } from "../../../database/schema.ts";
import { Ids } from "../../../ids/ids.ts";
import type { CanManageProject } from "../../../proofs/project-permissions.ts";
import type { Named } from "../../../proofs/proof.ts";
import type { ReachesConnector } from "../../../proofs/reaches-connector.ts";
import type { ReachesProject } from "../../../proofs/reaches-project.ts";
import { Secrets } from "../../../secrets/secrets.ts";
import { ServerSettings } from "../../../server-settings/server-settings.ts";
import { processLayer, Tier } from "../../../tiers.ts";
import { Egress, isPrivateAddress } from "../../network/egress.ts";
import { ConnectorStore } from "../connector-store.ts";
import { encryptAppCredential, openAppCredential } from "./credential.ts";
import * as GitHub from "./github.ts";
import { gitHubConnectorForProject } from "./github-connectors.ts";
import { GitHubUninstalls } from "./uninstalls.ts";

/**
 * Connecting a project to GitHub, for operations that have proved what each
 * call needs: a member who manages the project makes it its own private
 * GitHub App, from a manifest Sugabots writes, owned by the account whose
 * repositories the project's bots work on, then installs it there; GitHub
 * sends the browser back to Sugabots after each step. The app is the
 * project's GitHub connector, made once GitHub has made the app, and signed
 * in once it is installed. A bot's GitHub app is its default project's.
 *
 * Each step's `state` carries, sealed, the project, the connector and the
 * member it was handed to, so a step GitHub sends back is finished only for
 * that member, while they still manage the project.
 */
export interface Interface {
	/** The form that makes the project's GitHub App, owned by `organization` or by the member. */
	readonly start: <P, J>(
		canManage: CanManageProject<P, J>,
		organization: string | undefined,
	) => Effect.Effect<GitHubAppForm, ProjectHasGitHubConnector>;
	/**
	 * The setup step `state` was handed out for, if it is a `step` step and
	 * still current, for the operation to name its project and prove the
	 * member still manages it. The state is sealed, so opening it proves
	 * nothing more; the steps below check whose it is.
	 */
	readonly setupStep: (
		state: string | undefined,
		step: SetupStep["step"],
	) => Effect.Effect<SetupStep | undefined>;
	/**
	 * Makes the project's GitHub connector to the app GitHub made from the
	 * manifest, given the `code` it sent the browser back with, and says where
	 * to install it.
	 */
	readonly made: <P, J>(
		canManage: CanManageProject<P, J>,
		setup: SetupStep,
		code: string | undefined,
	) => Effect.Effect<GitHubSetupOutcome>;
	/** Records the account the app was installed on, or installed on again. */
	readonly installed: <P, J>(
		canManage: CanManageProject<P, J>,
		setup: SetupStep,
		installationId: number | undefined,
	) => Effect.Effect<GitHubSetupOutcome>;
	/** Where to install the connector's app, or to change which repositories it reaches. */
	readonly installUrl: <P, J, K>(
		canManage: CanManageProject<P, J>,
		connector: Named<K, string>,
		target: ReachesConnector<P, J, K>,
	) => Effect.Effect<string, NotGitHubConnector>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/GitHubApps") {
	declare readonly [Tier]: "process";
}

/** The project `reach` proved reached, by its workspace and its own id. */
const projectIn = <P, J>(reach: ReachesProject<P, J>): SetupProject => ({
	workspaceId: reach.workspace,
	projectId: reach.project.value,
});

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("GitHubApps");
	const secrets = yield* Secrets.Service;
	const serverSettings = yield* ServerSettings.Service;
	const connectors = yield* ConnectorStore.Service;
	const uninstalls = yield* GitHubUninstalls.Service;
	const ids = yield* Ids.Service;
	const egress = yield* Egress.Service;
	// Asked for when used, so building this asks nothing of egress.
	const gitHubApi = () => egress.providers.for({ baseUrl: GitHub.API_URL });
	const apiUrl = `${serverSettings.publicUrl}${API_BASE_PATH}`;
	const webhooksReachable = reachableFromInternet(serverSettings.publicUrl);

	/** What the project `reach` proved reached is called: its own name, or its bot's for a default project. */
	const nameOf = <P, J>(reach: ReachesProject<P, J>) =>
		Effect.map(
			query((db) =>
				db
					.select({ name: sql<string>`coalesce(${bot.name}, ${project.name})` })
					.from(project)
					.leftJoin(bot, eq(bot.id, project.defaultOfBotId))
					.where(and(eq(project.id, reach.project.value), eq(project.workspaceId, reach.workspace)))
					.limit(1),
			),
			([row]) => row?.name ?? "",
		);

	/** The `state` that carries `step` through GitHub, sealed, until it expires. */
	const stateFor = (step: SetupStep) =>
		Effect.map(Clock.currentTimeMillis, (now) =>
			secrets.encrypt(
				Schema.encodeSync(SetupStateJson)({
					...step,
					expiresAt: now + SETUP_STATE_LIFETIME_MILLISECONDS,
				}),
				SETUP_STATE_PURPOSE,
			),
		);

	const failed = (
		setup: SetupStep | undefined,
		failure: GitHubSetupFailure,
	): GitHubSetupOutcome => ({
		kind: "failed",
		at: setup && setupProjectOf(setup),
		failure,
	});

	return Service.of({
		start: (canManage, organization) =>
			operation(
				"start",
				Effect.gen(function* () {
					const { reach, member } = canManage;
					const project = projectIn(reach);
					if (yield* gitHubConnectorForProject(project)) {
						return yield* new ProjectHasGitHubConnector();
					}
					// The connector's id is in its webhook's address, so it is minted before GitHub makes the app.
					const connectorId = yield* ids.next;
					const state = yield* stateFor({
						step: "make",
						...project,
						connectorId,
						memberId: member.actor.memberId,
					});
					const manifest = GitHub.appManifest({
						name: appName(yield* nameOf(reach), connectorId),
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

		setupStep: (state, step) =>
			operation(
				"setupStep",
				Effect.gen(function* () {
					if (!state) return undefined;
					const now = yield* Clock.currentTimeMillis;
					const opened = Option.liftThrowable(() =>
						Schema.decodeSync(SetupStateJson)(secrets.decrypt(state, SETUP_STATE_PURPOSE)),
					)();
					if (Option.isNone(opened)) return undefined;
					const { expiresAt, ...setup } = opened.value;
					return setup.step === step && expiresAt > now ? setup : undefined;
				}),
			),

		made: (canManage, setup, code) =>
			operation(
				"made",
				Effect.gen(function* (): Effect.fn.Return<GitHubSetupOutcome, never, Database> {
					const { reach, member } = canManage;
					if (setup.memberId !== member.actor.memberId) return failed(undefined, "expired");
					if (!code) return failed(setup, "cancelled");
					const made = yield* GitHub.madeApp(gitHubApi(), code).pipe(
						Effect.tapError((failure) => Effect.logWarning("GitHub didn't make the app", failure)),
						Effect.option,
					);
					if (Option.isNone(made)) return failed(setup, "github");
					const app = made.value;
					const created = yield* connectors
						.createGitHub(reach.workspace, reach.project.value, member.actor.memberId, {
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

		installed: (canManage, setup, installationId) =>
			operation(
				"installed",
				Effect.gen(function* (): Effect.fn.Return<GitHubSetupOutcome, never, Database> {
					const { reach, member } = canManage;
					if (setup.memberId !== member.actor.memberId) return failed(undefined, "expired");
					if (installationId === undefined) return failed(setup, "cancelled");
					const row = yield* gitHubConnectorForProject(projectIn(reach));
					if (!row?.settings || !row.appCredentialEncrypted || row.id !== setup.connectorId) {
						return failed(undefined, "expired");
					}
					const { privateKey } = openAppCredential(secrets, row.appCredentialEncrypted);
					// Only the app's own installations are found with its key, so a
					// made-up id can't attach another account's.
					const found = yield* GitHub.installation(
						gitHubApi(),
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
					const recorded = yield* connectors.installed(reach.workspace, row.id, {
						installationId: id,
						account,
						// Only a member's own account is theirs alone, so only then is the installation theirs.
						installedById: onUserAccount ? member.actor.memberId : null,
					});
					// The connector went meanwhile, or its member left the workspace or was
					// removed: nothing records the installation now, so it is uninstalled.
					if (!recorded) {
						yield* transaction(
							uninstalls.enqueue(reach.workspace, [
								{
									connectorId: row.id,
									appId: row.settings.appId,
									appCredentialEncrypted: row.appCredentialEncrypted,
									installationId: id,
								},
							]),
						);
						return failed(undefined, "expired");
					}
					return { kind: "done", at: projectIn(reach), connectorId: row.id };
				}),
			),

		installUrl: (canManage, connector, target) =>
			operation(
				"installUrl",
				Effect.gen(function* () {
					const { member } = canManage;
					const connectorId = connector.value;
					const project = { workspaceId: target.workspace, projectId: target.project.value };
					const row = yield* gitHubConnectorForProject(project);
					if (!row?.settings || row.id !== connectorId) return yield* new NotGitHubConnector();
					const state = yield* stateFor({
						step: "install",
						...project,
						connectorId,
						memberId: member.actor.memberId,
					});
					return GitHub.installAppUrl(row.settings.slug, state);
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps.pipe(
	Layer.provide([ConnectorStore.layer, GitHubUninstalls.layer]),
);

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

/**
 * A step of setting up a project's GitHub App, for the connector it is or
 * will be, handed to the member who manages the project, `memberId`.
 */
export interface SetupStep extends SetupProject {
	readonly step: "make" | "install";
	readonly connectorId: string;
	readonly memberId: string;
}

/**
 * What a setup step's `state` carries through GitHub, sealed so it can't be
 * read or changed there: the step, whose it is, and until when.
 */
const SetupStateJson = Schema.fromJsonString(
	Schema.Struct({
		step: Schema.Literals(["make", "install"]),
		workspaceId: uuidSchema,
		projectId: uuidSchema,
		connectorId: uuidSchema,
		memberId: uuidSchema,
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
