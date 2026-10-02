import type { SandboxProvider } from "@sugabots/contracts";
import { sandboxProviderPreset } from "@sugabots/contracts";
import type { SandboxProviderRow } from "../database/schema.ts";
import { configurationStatus } from "../providers/tested-configuration.ts";

export function toSandboxProvider(row: SandboxProviderRow): SandboxProvider {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: sandboxProviderPreset(row.preset).name,
		settings: row.settings,
		enabled: row.enabled,
		status: configurationStatus({
			missingKey: row.apiKeyEncrypted === null,
			lastTestedAt: row.lastTestedAt,
			lastTestError: row.lastTestError,
		}),
		hasApiKey: row.apiKeyEncrypted !== null,
		lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
		lastTestError: row.lastTestError,
		createdAt: row.createdAt.toISOString(),
	};
}
