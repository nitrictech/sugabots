import type { TasksTab } from "@/lib/links.ts";
import type { AutomationsView } from "./AutomationsStage.tsx";

/**
 * What is open large beside a chat: a file, at its current version when
 * `version` is absent, the bot's computer's desktop, the bot's automations,
 * at the view of them that is open, or the bot's tasks, at the tab open.
 */
export type Staged =
	| { kind: "file"; fileId: string; version?: number }
	| { kind: "desktop" }
	| { kind: "automations"; view: AutomationsView }
	| { kind: "tasks"; tab: TasksTab };

/** Opens `staged` large beside a chat, or closes it as a `Stage` asks, as `how` says; see `CloseStage`. */
export type StagedChange = (staged: Staged | undefined, how?: { replace: boolean }) => void;
