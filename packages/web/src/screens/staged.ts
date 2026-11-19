import type { AutomationsView } from "./AutomationsStage.tsx";

/**
 * What is open large beside a conversation: a file, at its current version when
 * `version` is absent, the project's computer's desktop, or the project's
 * automations, at the view of them that is open.
 */
export type Staged =
	| { kind: "file"; fileId: string; version?: number }
	| { kind: "desktop" }
	| { kind: "automations"; view: AutomationsView };

/** Opens `staged` large beside a conversation, or closes it as a `Stage` asks, as `how` says; see `CloseStage`. */
export type StagedChange = (staged: Staged | undefined, how?: { replace: boolean }) => void;
