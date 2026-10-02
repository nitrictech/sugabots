import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Sandbox providers: where a workspace's pods get the Linux machines their
 * agents run commands on. Experimental.
 *
 * A workspace may configure several, each from a preset with its own account
 * and key, but at most one is enabled at a time, and that one makes every
 * pod's sandbox. Agents are offered the sandbox tools only while one is.
 */

/**
 * Sugabots' sandbox image, from `docker/sandbox`: published to GHCR, or built
 * locally under the same name with `bun run build:sandbox`.
 */
export const SANDBOX_IMAGE = "ghcr.io/nitrictech/sugabots-sandbox:latest";

/**
 * The E2B template Sugabots builds from {@link SANDBOX_IMAGE} in a
 * workspace's E2B account. E2B makes sandboxes from templates, not images.
 */
export const SANDBOX_E2B_TEMPLATE = "sugabots-sandbox";

export const sandboxProviderPresetIdSchema = Schema.Literals(["opensandbox", "e2b"]);
export type SandboxProviderPresetId = typeof sandboxProviderPresetIdSchema.Type;

export interface SandboxProviderPreset {
	id: SandboxProviderPresetId;
	name: string;
	/** A local preset is a server you run, at an address you give; a remote one has its own. */
	hosting: "remote" | "local";
	/** The address a local preset is usually at. */
	baseUrl?: string;
	/** What sandboxes are made from: an image for OpenSandbox, a template for E2B. */
	imageLabel: string;
	defaultImage: string;
}

export const sandboxProviderCatalog: readonly SandboxProviderPreset[] = [
	{
		id: "opensandbox",
		name: "OpenSandbox",
		hosting: "local",
		baseUrl: "http://localhost:8090",
		imageLabel: "Image",
		defaultImage: SANDBOX_IMAGE,
	},
	{
		id: "e2b",
		name: "E2B",
		hosting: "remote",
		imageLabel: "Template",
		defaultImage: SANDBOX_E2B_TEMPLATE,
	},
];

export function sandboxProviderPreset(id: SandboxProviderPresetId): SandboxProviderPreset {
	const preset = sandboxProviderCatalog.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Unknown sandbox provider preset: ${id}`);
	}
	return preset;
}

const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const imageSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512));

/**
 * A provider's settings, by preset. A provider may be saved before it has
 * every address it needs; it can't be enabled until it has. An image or
 * template left out follows the preset's default, so a new default reaches
 * every provider not set to something else.
 */
export const sandboxProviderSettingsSchema = Schema.Union([
	Schema.Struct({
		preset: Schema.Literal("opensandbox"),
		serverUrl: Schema.optional(providerUrlSchema),
		image: Schema.optional(imageSchema),
	}),
	Schema.Struct({
		preset: Schema.Literal("e2b"),
		/** E2B Embed's API and its address for reaching sandboxes; both left out for E2B Cloud. */
		apiUrl: Schema.optional(providerUrlSchema),
		sandboxUrl: Schema.optional(providerUrlSchema),
		template: Schema.optional(imageSchema),
	}),
]);

export type SandboxProviderSettings = typeof sandboxProviderSettingsSchema.Type;

export const sandboxProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: sandboxProviderPresetIdSchema,
	name: Schema.String,
	settings: sandboxProviderSettingsSchema,
	/** Whether this provider makes the workspace's sandboxes. At most one is. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type SandboxProvider = typeof sandboxProviderSchema.Type;

export const newSandboxProviderSchema = Schema.Struct({
	/** Its preset is the provider's for good. */
	settings: sandboxProviderSettingsSchema,
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	apiKey: Schema.optional(apiKeySchema),
});

export type NewSandboxProvider = typeof newSandboxProviderSchema.Type;

export const sandboxProviderUpdateSchema = Schema.Struct({
	/** Enabling it disables whichever provider was enabled before. */
	enabled: Schema.optional(Schema.Boolean),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
	/** Replaces the settings whole; their preset must be the provider's. */
	settings: Schema.optional(sandboxProviderSettingsSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type SandboxProviderUpdate = typeof sandboxProviderUpdateSchema.Type;

/**
 * Whether the workspace's agents can be given a sandbox: true while it has an
 * enabled sandbox provider with everything it needs.
 */
export const sandboxAccessSchema = Schema.Struct({ enabled: Schema.Boolean });
export type SandboxAccess = typeof sandboxAccessSchema.Type;

export const sandboxProviderTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	error: Schema.optional(Schema.String),
});

export type SandboxProviderTestResult = typeof sandboxProviderTestResultSchema.Type;

/** A pod's sandbox as the pod's settings show it. */
export const podSandboxStateSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("none") }),
	Schema.Struct({
		kind: Schema.Literal("present"),
		/** `lost`: the provider no longer has it. `unreachable`: its provider didn't answer. */
		state: Schema.Literals(["running", "paused", "lost", "unreachable"]),
		/** What it was made from, as its provider names it; null when the provider didn't answer. */
		image: Schema.NullOr(Schema.String),
		providerName: Schema.String,
		createdAt: isoTimestampSchema,
		lastUsedAt: isoTimestampSchema,
		turnsUsing: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** Whether the workspace's enabled provider would make it from another image, or is another provider. */
		upgradeAvailable: Schema.Boolean,
	}),
]);

export type PodSandboxState = typeof podSandboxStateSchema.Type;

export const podSandboxSchema = Schema.Struct({
	sandbox: podSandboxStateSchema,
	/** Whether the workspace has a sandbox provider enabled, without which nothing new is made. */
	providerEnabled: Schema.Boolean,
	/** Whether the person asking may reset or upgrade it. */
	canManage: Schema.Boolean,
});

export type PodSandbox = typeof podSandboxSchema.Type;

/**
 * How a provider's template stands, for a provider that builds its sandboxes
 * from one (E2B): `missing` until Sugabots' is prepared in the workspace's
 * account. Null for a provider that takes images as they are.
 */
export const sandboxTemplateSchema = Schema.Struct({
	state: Schema.NullOr(Schema.Literals(["missing", "building", "ready", "failed"])),
});

export type SandboxTemplate = typeof sandboxTemplateSchema.Type;

/**
 * A host a sandbox may reach: a domain name such as `api.example.com`, or a
 * leading wildcard such as `*.example.com`, which covers the domain's
 * subdomains but not the domain itself. Lowercase. Addresses and ports aren't
 * hosts here: the providers' allowlists match names. Names for local networks
 * and services whose names resolve to any address someone writes in them
 * (`10-0-0-1.nip.io`) aren't either, since the providers allow whatever
 * address a name resolves to.
 */
export const sandboxHostSchema = Schema.String.check(
	Schema.isMaxLength(253),
	Schema.isPattern(
		/^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
		{ message: "Enter a domain name, such as api.example.com or *.example.com" },
	),
	Schema.isPattern(
		/^(?!(?:.*\.)?(?:internal|local|localhost|arpa|home|lan|nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|localhost\.direct)$)/,
		{ message: "That name is for a local network, which sandboxes can't reach" },
	),
);

/** A host a workspace let every pod's sandbox reach, or a pod its own, beyond the trusted ones. */
export const sandboxAddedHostSchema = Schema.Struct({
	host: sandboxHostSchema,
	/** Who added it, or approved the agent's request for it; null once they've left. */
	addedByName: Schema.NullOr(Schema.String),
	addedAt: isoTimestampSchema,
});

export type SandboxAddedHost = typeof sandboxAddedHostSchema.Type;

/** A host no sandbox in the workspace may reach, whatever a pod allows. */
export const sandboxBlockedHostSchema = Schema.Struct({
	host: sandboxHostSchema,
	/** Who blocked it; null once they've left. */
	blockedByName: Schema.NullOr(Schema.String),
	blockedAt: isoTimestampSchema,
});

export type SandboxBlockedHost = typeof sandboxBlockedHostSchema.Type;

/**
 * What a workspace lets every pod's sandbox connect to, and what it keeps
 * them all from. Each pod adds its own hosts; everything else is refused, so
 * a command that reaches for another host fails as if it weren't there.
 */
export const sandboxNetworkSettingsSchema = Schema.Struct({
	/** What every workspace's sandboxes reach: package registries and where source code is hosted. */
	trustedHosts: Schema.Array(sandboxHostSchema),
	addedHosts: Schema.Array(sandboxAddedHostSchema),
	/**
	 * Out of every pod's reach, with their subdomains. A block also keeps out
	 * any allowed wildcard that covers it, since a sandbox can't be let into a
	 * wildcard with exceptions.
	 */
	blockedHosts: Schema.Array(sandboxBlockedHostSchema),
});

export type SandboxNetworkSettings = typeof sandboxNetworkSettingsSchema.Type;

/** The workspace's block that keeps a host out of the pod's reach anyway; null when none does. */
const blockedBy = Schema.NullOr(sandboxHostSchema);

/** Where one pod's sandbox may connect to: what the workspace allows every pod, and its own. */
export const podSandboxNetworkSchema = Schema.Struct({
	/** The trusted hosts and the workspace's, which every pod's sandbox is allowed. */
	workspaceHosts: Schema.Array(Schema.Struct({ host: sandboxHostSchema, blockedBy })),
	/** What the pod added for its own sandbox. */
	addedHosts: Schema.Array(Schema.Struct({ ...sandboxAddedHostSchema.fields, blockedBy })),
});

export type PodSandboxNetwork = typeof podSandboxNetworkSchema.Type;

export const newSandboxHostSchema = Schema.Struct({ host: sandboxHostSchema });
