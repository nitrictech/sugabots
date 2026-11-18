import type { ComputerProvider } from "@sugabots/contracts";
import { computerProviderPreset } from "@sugabots/contracts";
import type { ComputerProviderRow } from "../database/schema.ts";
import { configurationStatus } from "../providers/tested-configuration.ts";

export function toComputerProvider(row: ComputerProviderRow): ComputerProvider {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		preset: row.preset,
		name: computerProviderPreset(row.preset).name,
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
