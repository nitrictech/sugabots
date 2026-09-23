import type { SystemAgentKey, TrialRating } from "@sugabots/contracts";
import { failureMessage } from "@/lib/failure.ts";
import { useModelTrial } from "@/lib/model-trials.ts";
import { Alert } from "@/ui/alert.tsx";
import { Button } from "@/ui/button.tsx";

/**
 * Trying the chosen model on the job this system agent actually does.
 *
 * A system agent runs unattended on every message, so "it looked fine when I tried
 * it" is not something anyone can check by reading a model name. This runs the
 * situations that have gone wrong before and says how often the model handled
 * them and how long it took.
 *
 * It sits next to the model picker because that is the decision it informs.
 */

const RATING_TONE: Record<TrialRating, string> = {
	excellent: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	poor: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	terrible: "bg-destructive/15 text-destructive",
};

const WHAT_IT_IS: Record<SystemAgentKey, string> = {
	facilitate: "Choosing who speaks next, and choosing nobody when the exchange is over.",
	summarise: "Keeping a thread's summary and title up to date, in the format the app reads.",
};

export function SystemAgentModelTrial({
	model,
	systemAgentKey,
}: {
	/** The model to try. Only shown once one has been chosen. */
	model: string;
	systemAgentKey: SystemAgentKey;
}) {
	const trial = useModelTrial();
	const report = trial.data;
	// A report is about the model that was tried. Changing the model leaves it
	// on screen describing a model nobody is using now, so say whose it is.
	const stale = report !== undefined && report.model !== model;

	return (
		<section className="flex flex-col gap-3">
			<div className="flex min-h-6 items-center gap-3">
				<h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
					Model check
				</h3>
				<Button
					size="sm"
					variant="secondary"
					disabled={trial.isPending}
					onClick={() => trial.mutate({ systemAgentKey, model })}
				>
					{trial.isPending ? "Running…" : report ? "Run again" : "Run the check"}
				</Button>
			</div>
			<p className="text-md text-muted-foreground">{WHAT_IT_IS[systemAgentKey]}</p>

			{trial.error !== null && trial.error !== undefined && (
				<Alert>{failureMessage(trial.error)}</Alert>
			)}

			{report && (
				<div className="flex flex-col gap-3 rounded-xl border border-border-subtle p-4">
					<div className="flex flex-wrap items-center gap-3">
						<span
							className={`rounded-md px-2 py-0.5 font-semibold text-sm capitalize ${RATING_TONE[report.rating]}`}
						>
							{report.rating}
						</span>
						<span className="font-mono text-muted-foreground text-sm">{report.model}</span>
						<span className="text-muted-foreground text-sm">
							{report.accuracy.passed} of {report.accuracy.attempts} right, about{" "}
							{(report.speed.typicalMs / 1000).toFixed(1)}s each
						</span>
					</div>

					{stale && (
						<p className="text-md text-muted-foreground">
							This is the check for {report.model}. Run it again for {model}.
						</p>
					)}

					<ul className="flex flex-col gap-1.5">
						{report.verdict.map((said) => (
							<li key={said} className="text-foreground text-md leading-relaxed">
								{said}
							</li>
						))}
					</ul>

					<ul className="flex flex-col gap-1 border-border-subtle border-t pt-3">
						{report.cases.map((one) => (
							<li key={one.name} className="flex items-baseline gap-2 text-md">
								<span
									className={
										one.passed === one.attempts
											? "text-muted-foreground"
											: "font-semibold text-destructive"
									}
								>
									{one.passed}/{one.attempts}
								</span>
								<span className="min-w-0 flex-1 text-muted-foreground">{one.name}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
