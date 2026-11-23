import type {
	Automation,
	AutomationCurrentSecret,
	AutomationListStatus,
	AutomationTriggerInput,
	AutomationUpdate,
	AutomationWriteResult,
	NewAutomation,
	Run,
} from "@sugabots/contracts";
import {
	type QueryClient,
	skipToken,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { client } from "@/api.ts";
import { formatTimeAhead } from "@/lib/list-time.ts";
import { automationStartsLabel } from "@/lib/routine-schedule.ts";

/** Every automation query starts with this, so one change refreshes each project's automations and runs. */
const AUTOMATIONS_KEY = "automations";

/**
 * Fetches again every automation's definition, status and runs, for a run
 * accepted or settled. A list with no run going does not poll, so without
 * this a scheduled run could start and finish without showing in it.
 */
export function refreshAutomations(queries: QueryClient) {
	return queries.invalidateQueries({ queryKey: [AUTOMATIONS_KEY] });
}

/** How often the runs are read again while one has not ended, so its status stays current. */
const RUN_POLL_MS = 3_000;

/** Whether a run in `state` has not ended yet. */
function going(state: Run["state"]): boolean {
	return state === "queued" || state === "running";
}

/** A runs query's `refetchInterval`: every `RUN_POLL_MS` while one of its runs is queued or running. */
function pollWhileRunning(query: { state: { data?: { items: readonly Run[] } } }): number | false {
	return query.state.data?.items.some((run) => going(run.state)) ? RUN_POLL_MS : false;
}

/**
 * A listed automations query's `refetchInterval`: every `RUN_POLL_MS` while
 * one's latest run is queued or running, so how each stands stays current.
 */
export function pollWhileAutomationsRun(
	automations: readonly { status?: AutomationListStatus }[] | undefined,
): number | false {
	return automations?.some(({ status }) => status?.latestRun && going(status.latestRun.state))
		? RUN_POLL_MS
		: false;
}

/** How many of a project's latest runs its sidebar lists among its chats. */
const SIDEBAR_RUN_COUNT = 30;

/**
 * The latest runs of a project's automations, newest first, read again while
 * one of them is queued or running.
 */
export function useProjectRuns(projectId: string): Run[] {
	const result = useQuery({
		queryKey: [AUTOMATIONS_KEY, "project-runs", projectId],
		queryFn: ({ signal }) =>
			Effect.runPromise(
				client.api.automations.projectRuns({
					params: { projectId },
					query: { limit: SIDEBAR_RUN_COUNT },
				}),
				{ signal },
			),
		refetchInterval: pollWhileRunning,
	});
	return result.data?.items ?? [];
}

/**
 * The project `projectId`'s automations in full, as a bot's default project
 * holds its own, with how each stands for whoever may read its runs, read
 * again while one runs.
 */
export function useAutomations(projectId: string) {
	return useQuery({
		queryKey: [AUTOMATIONS_KEY, "project", projectId],
		queryFn: ({ signal }) =>
			Effect.runPromise(client.api.automations.list({ params: { projectId } }), { signal }),
		refetchInterval: (query) => pollWhileAutomationsRun(query.state.data),
	});
}

/** Webhook secrets, by trigger, kept out of `AUTOMATIONS_KEY` so refreshing the lists doesn't read them again. */
const SECRET_KEY = "automation-secret";

/** One of an automation's triggers, through the project the automation belongs to. */
export interface TriggerAddress {
	projectId: string;
	automationId: string;
	triggerId: string;
}

/**
 * A webhook trigger's current secret, for somebody who manages it. Nothing
 * is read for anybody else, since the API would refuse them.
 */
export function useAutomationSecret({
	canManage,
	...address
}: TriggerAddress & { canManage: boolean }) {
	return useQuery({
		queryKey: [SECRET_KEY, address.triggerId],
		queryFn: canManage
			? ({ signal }) =>
					Effect.runPromise(client.api.automations.getSecret({ params: address }), { signal })
			: skipToken,
	});
}

/** Each change names the project its automation belongs to, since automations are addressed through their project. */
export function useAutomationActions() {
	const queries = useQueryClient();
	const refresh = () =>
		Promise.all([
			refreshAutomations(queries),
			// A project's chat list holds its automations, by name and how they stand:
			// `projectChatsKey()` in chats.ts, which imports this module.
			queries.invalidateQueries({ queryKey: ["project-chats"] }),
		]);
	const keepSecret = (triggerId: string, current: AutomationCurrentSecret) =>
		queries.setQueryData([SECRET_KEY, triggerId], current);
	const written = (result: AutomationWriteResult) => {
		for (const { triggerId, secret } of result.secrets)
			keepSecret(triggerId, { kind: "set", secret });
		// A webhook given no new secret kept the one it had, or was left without.
		const made = new Set(result.secrets.map((one) => one.triggerId));
		for (const trigger of result.automation.triggers) {
			if (trigger.kind === "webhook" && !made.has(trigger.id)) {
				void queries.invalidateQueries({ queryKey: [SECRET_KEY, trigger.id] });
			}
		}
		return refresh();
	};
	const { automations } = client.api;

	return {
		create: useMutation({
			mutationFn: ({ projectId, json }: { projectId: string; json: NewAutomation }) =>
				Effect.runPromise(automations.create({ params: { projectId }, payload: json })),
			onSuccess: written,
		}),
		update: useMutation({
			mutationFn: ({
				projectId,
				automationId,
				json,
			}: {
				projectId: string;
				automationId: string;
				json: AutomationUpdate;
			}) =>
				Effect.runPromise(
					automations.update({ params: { projectId, automationId }, payload: json }),
				),
			onSuccess: written,
		}),
		remove: useMutation({
			mutationFn: ({ projectId, automationId }: { projectId: string; automationId: string }) =>
				Effect.runPromise(automations.remove({ params: { projectId, automationId } })),
			onSuccess: refresh,
		}),
		run: useMutation({
			mutationFn: ({ projectId, automationId }: { projectId: string; automationId: string }) =>
				Effect.runPromise(
					automations.run({
						params: { projectId, automationId },
						payload: { requestId: crypto.randomUUID() },
					}),
				),
			onSuccess: refresh,
		}),
		addTrigger: useMutation({
			mutationFn: ({
				projectId,
				automationId,
				json,
			}: {
				projectId: string;
				automationId: string;
				json: AutomationTriggerInput;
			}) =>
				Effect.runPromise(
					// The generated client splits a union payload into one request type
					// per member, which a request holding the whole union does not satisfy.
					automations.addTrigger({
						params: { projectId, automationId },
						payload: json,
					} as Parameters<typeof automations.addTrigger>[0]),
				),
			onSuccess: written,
		}),
		updateTrigger: useMutation({
			mutationFn: ({ json, ...params }: TriggerAddress & { json: AutomationTriggerInput }) =>
				Effect.runPromise(
					automations.updateTrigger({ params, payload: json } as Parameters<
						typeof automations.updateTrigger
					>[0]),
				),
			onSuccess: written,
		}),
		removeTrigger: useMutation({
			mutationFn: (params: TriggerAddress) =>
				Effect.runPromise(automations.removeTrigger({ params })),
			onSuccess: refresh,
		}),
		rotateSecret: useMutation({
			mutationFn: ({
				secret,
				...params
			}: TriggerAddress & {
				/** Null leaves the trigger without one, so its address alone runs the automation. */
				secret: string | null;
			}) => Effect.runPromise(automations.rotateSecret({ params, payload: { secret } })),
			onSuccess: ({ secret }, { triggerId }) =>
				keepSecret(triggerId, secret === null ? { kind: "none" } : { kind: "set", secret }),
		}),
	};
}

/** When the automation's routines run it next, in words: "Today at 14:00", "Tomorrow at 7:00", "Mon at 9:00"; none without a routine. */
function nextRunAt(automation: Automation): string | undefined {
	const [next] = automation.triggers
		.flatMap((trigger) =>
			trigger.kind === "routine" && trigger.nextScheduledAt ? [trigger.nextScheduledAt] : [],
		)
		.sort();
	if (!next) return undefined;
	return formatTimeAhead(new Date(next), new Date());
}

/** When the automation runs next, in words: its routines' soonest time, or what starts it, if anything does. */
export function nextRunWords(automation: Automation): string | undefined {
	const next = nextRunAt(automation);
	if (next) return `Next run ${next.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())}`;
	if (
		automation.triggers.length > 0 &&
		automation.triggers.every(({ kind }) => kind === "webhook")
	) {
		return "Runs when its address is called";
	}
	return automationStartsLabel(automation);
}
