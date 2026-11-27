import type { RunTriggerKind } from "@sugabots/contracts";
import { Clock, GitBranch, type LucideProps, RefreshCw, Webhook } from "lucide-react";

/**
 * What started an automation's run, as a mark: a clock for a routine, a hook
 * for its webhook, a branch for its GitHub trigger.
 */
export function AutomationTriggerIcon({ kind, ...props }: { kind: RunTriggerKind } & LucideProps) {
	if (kind === "routine") return <Clock {...props} />;
	if (kind === "webhook") return <Webhook {...props} />;
	if (kind === "github") return <GitBranch {...props} />;
	return <RefreshCw {...props} />;
}
