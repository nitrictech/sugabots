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

/**
 * Room to install a repository's dependencies and run its checks. E2B's own
 * default, 1 GiB, runs out doing that, and the sandbox stalls rather than failing.
 */
export const SANDBOX_E2B_DEFAULT_SIZE = { cpuCount: 2, memoryGiB: 4 } as const;

/**
 * The OpenSandbox SDK's own default. Docker refuses more vCPUs than its host
 * has, and Kubernetes reserves the whole size on a node, so a larger default
 * would stop sandboxes starting on small hosts.
 */
export const SANDBOX_OPENSANDBOX_DEFAULT_SIZE = { cpuCount: 1, memoryGiB: 2 } as const;

/**
 * Bounds for a sandbox's size. The real limit is the E2B account's plan, or
 * what OpenSandbox's hosts have room for.
 */
export const sandboxCpuCountSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 64 }),
);
export const sandboxMemoryGiBSchema = Schema.Int.check(
	Schema.isBetween({ minimum: 1, maximum: 64 }),
);

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
	/** The size of its sandboxes unless the workspace sets another. */
	defaultSize: { readonly cpuCount: number; readonly memoryGiB: number };
	/** What it is good for, in the line under its name where one is chosen. */
	description: string;
}

export const sandboxProviderCatalog: readonly SandboxProviderPreset[] = [
	{
		id: "opensandbox",
		name: "OpenSandbox",
		hosting: "local",
		baseUrl: "http://localhost:8090",
		imageLabel: "Image",
		defaultImage: SANDBOX_IMAGE,
		defaultSize: SANDBOX_OPENSANDBOX_DEFAULT_SIZE,
		description: "Runs on your own Docker or Kubernetes",
	},
	{
		id: "e2b",
		name: "E2B",
		hosting: "remote",
		imageLabel: "Template",
		defaultImage: SANDBOX_E2B_TEMPLATE,
		defaultSize: SANDBOX_E2B_DEFAULT_SIZE,
		description: "Hosted microVMs, or E2B Embed on your own server",
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
const nameSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512));

/**
 * How a provider's sandboxes reach the internet: `allowlist`, only the
 * trusted hosts and those the workspace and each pod add; or `open`, every
 * host but those the workspace blocks, as far as the provider can refuse
 * hosts by name. E2B can't, so its open sandboxes reach every host.
 */
export const sandboxNetworkModeSchema = Schema.Literals(["allowlist", "open"]);

export type SandboxNetworkMode = typeof sandboxNetworkModeSchema.Type;

/** A provider whose settings leave out its network mode is open. */
export const SANDBOX_NETWORK_MODE_DEFAULT: SandboxNetworkMode = "open";

/**
 * An image's name as `docker pull` takes it, such as
 * `ghcr.io/nitrictech/sugabots-sandbox:edge`. This only catches what people
 * paste by mistake, a whole command or a web address, rather than every rule
 * of Docker's.
 */
const imageSchema = Schema.Trim.check(
	Schema.isMaxLength(512),
	Schema.isPattern(/^\S+$/, {
		message: "Enter just the image's name, such as ghcr.io/nitrictech/sugabots-sandbox:latest",
	}),
	Schema.isPattern(/^(?![a-z]+:\/\/)/i, {
		message:
			"Enter the image's name rather than a web address, such as ghcr.io/nitrictech/sugabots-sandbox:latest",
	}),
);

function providerSettingsWithImageSchema(image: Schema.Codec<string, string>) {
	return Schema.Union([
		Schema.Struct({
			preset: Schema.Literal("opensandbox"),
			serverUrl: Schema.optional(providerUrlSchema),
			image: Schema.optional(image),
			/** The most each sandbox may use. */
			cpuCount: Schema.optional(sandboxCpuCountSchema),
			memoryGiB: Schema.optional(sandboxMemoryGiBSchema),
			/** Left out, {@link SANDBOX_NETWORK_MODE_DEFAULT}. */
			networkMode: Schema.optional(sandboxNetworkModeSchema),
		}),
		Schema.Struct({
			preset: Schema.Literal("e2b"),
			/** E2B Embed's API and its address for reaching sandboxes; both left out for E2B Cloud. */
			apiUrl: Schema.optional(providerUrlSchema),
			sandboxUrl: Schema.optional(providerUrlSchema),
			template: Schema.optional(nameSchema),
			/** What the template is built with, so every sandbox made from it has. */
			cpuCount: Schema.optional(sandboxCpuCountSchema),
			memoryGiB: Schema.optional(sandboxMemoryGiBSchema),
			/** Left out, {@link SANDBOX_NETWORK_MODE_DEFAULT}. Open, the workspace's blocks don't apply. */
			networkMode: Schema.optional(sandboxNetworkModeSchema),
		}),
	]);
}

/**
 * A provider's settings, by preset, as they are saved. A provider may be
 * saved before it has every address it needs; it can't be enabled until it
 * has. An image, template or size left out follows the default, so a new
 * default reaches every provider not set to something else.
 */
export const sandboxProviderSettingsSchema = providerSettingsWithImageSchema(imageSchema);

/**
 * Settings as they are read back. An image saved before images' names were
 * checked is shown as it is, so the page that would correct it still loads.
 * Its JSON is that of {@link sandboxProviderSettingsSchema}, so the API
 * document names it the same.
 */
const savedSandboxProviderSettingsSchema = providerSettingsWithImageSchema(nameSchema).annotate({
	identifier: "SandboxProviderSettings",
});

export type SandboxProviderSettings = typeof sandboxProviderSettingsSchema.Type;

export const sandboxProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: sandboxProviderPresetIdSchema,
	name: Schema.String,
	settings: savedSandboxProviderSettingsSchema,
	/** Whether this provider makes the workspace's sandboxes. At most one is. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
}).annotate({ identifier: "SandboxProvider" });

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

const byteCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A folder of a pod's sandbox and how much of its disk it takes. */
export const sandboxDiskFolderSchema = Schema.Union([
	/** A bot's home, its own across every thread in the pod. */
	Schema.Struct({ kind: Schema.Literal("home"), agentId: uuidSchema, bytes: byteCountSchema }),
	/** Every thread's folder together, where the bots clone and build. */
	Schema.Struct({ kind: Schema.Literal("threads"), bytes: byteCountSchema }),
	/** `/tmp`. */
	Schema.Struct({ kind: Schema.Literal("temporary"), bytes: byteCountSchema }),
]);

export type SandboxDiskFolder = typeof sandboxDiskFolderSchema.Type;

/**
 * How full a pod's sandbox's disk was when last measured, which it is every
 * few minutes while it runs. A paused sandbox's disk doesn't change, so its
 * last measurement still holds.
 */
export const sandboxDiskSchema = Schema.Struct({
	usedBytes: byteCountSchema,
	/** What its files can fill: what they use and what is still free to them. */
	totalBytes: byteCountSchema,
	measuredAt: isoTimestampSchema,
	/** Largest first; null when they couldn't be sized, such as when it took too long. */
	folders: Schema.NullOr(Schema.Array(sandboxDiskFolderSchema)),
});

export type SandboxDisk = typeof sandboxDiskSchema.Type;

/** Past this share of its disk, a sandbox is close to full. */
export const SANDBOX_DISK_WARNING_SHARE = 0.8;
/** Past this share, commands that write are about to fail. */
export const SANDBOX_DISK_CRITICAL_SHARE = 0.9;

/** The share of its disk a sandbox's files use, from 0 to 1. */
export function sandboxDiskShare(disk: Pick<SandboxDisk, "usedBytes" | "totalBytes">) {
	return disk.totalBytes === 0 ? 1 : Math.min(disk.usedBytes / disk.totalBytes, 1);
}

/** The share of its disk a sandbox's files use, as a whole percent, as people are shown it. */
export function sandboxDiskPercent(disk: Pick<SandboxDisk, "usedBytes" | "totalBytes">) {
	return Math.round(sandboxDiskShare(disk) * 100);
}

/** How full the disk is: `warning` and `critical` past their shares of it. */
export function sandboxDiskLevel(disk: Pick<SandboxDisk, "usedBytes" | "totalBytes">) {
	const share = sandboxDiskShare(disk);
	if (share >= SANDBOX_DISK_CRITICAL_SHARE) return "critical";
	if (share >= SANDBOX_DISK_WARNING_SHARE) return "warning";
	return "normal";
}

const BYTE_UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_KB = 1024;

/** A size on disk as people read one, in units of 1024: `512 KB`, `18.4 GB`. */
export function formatDiskSize(bytes: number) {
	const exponent = Math.min(
		Math.max(Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(BYTES_PER_KB)), 0),
		BYTE_UNITS.length - 1,
	);
	const value = bytes / BYTES_PER_KB ** exponent;
	const shown = exponent === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${shown} ${BYTE_UNITS[exponent]}`;
}

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
		peopleWatching: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		/** Whether the workspace's enabled provider would make it from another image, or is another provider. */
		upgradeAvailable: Schema.Boolean,
		/** Null until it has been measured. */
		disk: Schema.NullOr(sandboxDiskSchema),
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

/** The disk of one pod's sandbox, for the workspace's overview of its pods' sandboxes. */
export const podSandboxDiskSchema = Schema.Struct({ podId: uuidSchema, disk: sandboxDiskSchema });

export type PodSandboxDisk = typeof podSandboxDiskSchema.Type;

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
	/** The enabled provider's; {@link SANDBOX_NETWORK_MODE_DEFAULT} while none is enabled. */
	mode: sandboxNetworkModeSchema,
	/**
	 * Whether the blocked hosts are kept out: false while the sandboxes are
	 * open at a provider that can't refuse hosts by name.
	 */
	blocking: Schema.Boolean,
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
	/** The workspace's enabled provider's; open, the sandbox reaches every host the workspace didn't block. */
	mode: sandboxNetworkModeSchema,
	/** Whether the workspace's blocked hosts are kept out of the sandbox. */
	blocking: Schema.Boolean,
	/** The trusted hosts and the workspace's, which every pod's sandbox is allowed. */
	workspaceHosts: Schema.Array(Schema.Struct({ host: sandboxHostSchema, blockedBy })),
	/** What the pod added for its own sandbox. */
	addedHosts: Schema.Array(Schema.Struct({ ...sandboxAddedHostSchema.fields, blockedBy })),
});

export type PodSandboxNetwork = typeof podSandboxNetworkSchema.Type;

export const newSandboxHostSchema = Schema.Struct({ host: sandboxHostSchema });
