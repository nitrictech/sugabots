import { Schema } from "effect";
import { providerStatusSchema, providerUrlSchema } from "./model-providers.ts";
import { isoTimestampSchema } from "./timestamps.ts";
import { uuidSchema } from "./uuid.ts";

/**
 * Sandbox providers: where a workspace's pods get the Linux machines their
 * agents run commands in.
 *
 * One provider per workspace, made from a preset the way a search provider
 * is, with the workspace's own address and key. Sandbox tools are offered to
 * an agent only while the provider is enabled, has its key, and an admin has
 * switched the sandbox on for that agent.
 */

export const sandboxProviderPresetIdSchema = Schema.Literals(["opensandbox"]);
export type SandboxProviderPresetId = typeof sandboxProviderPresetIdSchema.Type;

export const DEFAULT_SANDBOX_PRESET: SandboxProviderPresetId = "opensandbox";

/**
 * How far a sandbox is kept from the host and from other sandboxes.
 *
 * `container` shares the host's kernel, so an escape is one kernel bug away.
 * A workspace may choose it only on an installation that allows it
 * (`SANDBOX_ALLOW_UNISOLATED`), since the host is the installation's.
 */
export const sandboxIsolationSchema = Schema.Literals(["container", "gvisor", "microvm"]);
export type SandboxIsolation = typeof sandboxIsolationSchema.Type;

/** One entry in the sandbox catalog: a sandbox service we know how to drive. */
export interface SandboxProviderPreset {
	id: SandboxProviderPresetId;
	name: string;
	baseUrl: string;
	/** The image sandboxes start from until someone chooses another. */
	defaultImage: string;
}

export const sandboxProviderCatalog: readonly SandboxProviderPreset[] = [
	{
		id: "opensandbox",
		name: "OpenSandbox",
		baseUrl: "http://127.0.0.1:8090",
		defaultImage: "node:22-bookworm",
	},
];

export function sandboxProviderPreset(id: SandboxProviderPresetId): SandboxProviderPreset {
	const preset = sandboxProviderCatalog.find((candidate) => candidate.id === id);
	if (!preset) {
		throw new Error(`Unknown sandbox provider preset: ${id}`);
	}
	return preset;
}

/**
 * Hosts a sandbox may reach until someone changes them: GitHub and the common
 * package registries, which is what cloning and building a project needs.
 */
export const DEFAULT_SANDBOX_ALLOWED_HOSTS: readonly string[] = [
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"deb.debian.org",
];

/** A host name, or one with a leading `*.` for its subdomains. `*` alone means any host. */
const allowedHostSchema = Schema.Trim.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(253),
	Schema.isPattern(/^(\*|(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*)$/i, {
		message: "A host name, *.domain for its subdomains, or * for any host",
	}),
);

const allowedHostsSchema = Schema.mutable(Schema.Array(allowedHostSchema)).check(
	Schema.isMaxLength(100),
);

const imageSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512));

export const sandboxProviderSchema = Schema.Struct({
	id: uuidSchema,
	workspaceId: uuidSchema,
	preset: sandboxProviderPresetIdSchema,
	name: Schema.String,
	baseUrl: providerUrlSchema,
	image: Schema.String,
	isolation: sandboxIsolationSchema,
	/** What a sandbox may reach; everything else is refused. `["*"]` is anywhere. */
	allowedHosts: Schema.mutable(Schema.Array(Schema.String)),
	/** Whether agents allowed a sandbox are offered its tools. */
	enabled: Schema.Boolean,
	status: providerStatusSchema,
	hasApiKey: Schema.Boolean,
	lastTestedAt: Schema.NullOr(isoTimestampSchema),
	lastTestError: Schema.NullOr(Schema.String),
	createdAt: isoTimestampSchema,
});

export type SandboxProvider = typeof sandboxProviderSchema.Type;

const apiKeySchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096));

/** A workspace's sandbox provider, set or replaced. The preset fills in what is left out. */
export const newSandboxProviderSchema = Schema.Struct({
	preset: sandboxProviderPresetIdSchema,
	enabled: Schema.optional(Schema.Boolean),
	baseUrl: Schema.optional(providerUrlSchema),
	apiKey: Schema.optional(apiKeySchema),
	image: Schema.optional(imageSchema),
	isolation: Schema.optional(sandboxIsolationSchema),
	allowedHosts: Schema.optional(allowedHostsSchema),
});

export type NewSandboxProvider = typeof newSandboxProviderSchema.Type;

export const sandboxProviderUpdateSchema = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	baseUrl: Schema.optional(providerUrlSchema),
	/** Absent leaves the stored key alone; null removes it. */
	apiKey: Schema.optional(Schema.NullOr(apiKeySchema)),
	image: Schema.optional(imageSchema),
	isolation: Schema.optional(sandboxIsolationSchema),
	allowedHosts: Schema.optional(allowedHostsSchema),
}).check(
	Schema.makeFilter((value) => Object.keys(value).length > 0, { message: "Nothing to change" }),
);

export type SandboxProviderUpdate = typeof sandboxProviderUpdateSchema.Type;

/** What `GET` answers: the provider, or null, and what this installation lets a workspace choose. */
export const sandboxProviderResponseSchema = Schema.Struct({
	provider: Schema.NullOr(sandboxProviderSchema),
	/** Whether `container` isolation may be chosen here. */
	allowsUnisolated: Schema.Boolean,
});

export const sandboxProviderTestResultSchema = Schema.Struct({
	reachable: Schema.Boolean,
	latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	error: Schema.optional(Schema.String),
});

export type SandboxProviderTestResult = typeof sandboxProviderTestResultSchema.Type;

/**
 * Whether a pod has a sandbox, and whether anything is using it now.
 *
 * `in_use` while a turn holds a lease on it, naming the agents whose turns do;
 * `idle` when it is up and nobody is; `paused` when it has been idle long
 * enough to stop costing compute, until the next turn wakes it; `lost` when
 * the provider no longer has it; `none` before any agent in the pod has needed one.
 */
export const podSandboxStateSchema = Schema.Literals(["none", "in_use", "idle", "paused", "lost"]);
export type PodSandboxState = typeof podSandboxStateSchema.Type;

export const podSandboxStatusSchema = Schema.Struct({
	state: podSandboxStateSchema,
	/** The agents whose turns are using it, when `in_use`. */
	usedBy: Schema.mutable(
		Schema.Array(
			Schema.Struct({ agentId: uuidSchema, name: Schema.String, handle: Schema.String }),
		),
	),
	isolation: Schema.NullOr(sandboxIsolationSchema),
	/** When the last turn using it finished, or null if none has yet. */
	lastUsedAt: Schema.NullOr(isoTimestampSchema),
	createdAt: Schema.NullOr(isoTimestampSchema),
});

export type PodSandboxStatus = typeof podSandboxStatusSchema.Type;
