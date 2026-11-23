import type { Bot, SignedInPerson } from "@sugabots/contracts";
import { Plus, RefreshCcw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useOpenAutomationFeed } from "@/lib/chats.ts";
import { API_DID_NOT_ANSWER } from "@/lib/failure.ts";
import { usePanelKeys } from "@/lib/panel-keys.ts";
import { AutomationRow, NoAutomations, useListedAutomations } from "@/shell/Automations.tsx";
import { Stage, StageClose, type StageParent } from "@/shell/Stage.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import { IconButton } from "@/ui/icon-button.tsx";
import { IconTile } from "@/ui/icon-tile.tsx";
import { NewAutomationPage } from "./AutomationEditor.tsx";
import { ChatPane } from "./ChatPane.tsx";
import type { StagedChange } from "./staged.ts";

interface AutomationsStageProps {
	bot: Bot;
	signedIn: SignedInPerson;
	view: AutomationsView;
	onViewChange: (view: AutomationsView) => void;
	/** Opens something else beside the bot's chat, such as a file from an automation's feed. */
	onStagedChange: StagedChange;
	onClose: () => void;
}

/** Which of a bot's automations are open beside its chat: all of them, one, or a new one being made. */
export type AutomationsView =
	| { kind: "list" }
	| { kind: "automation"; automationId: string }
	| { kind: "new" };

/**
 * A bot's automations, open large beside its chat as its computer is: all of
 * them, each opening its own feed in their place, or a new one being made.
 * An automation or a new one is a level inside the list, and the Back before its
 * name returns to the list, so the bot's chat stays in view throughout.
 * Escape goes back up a level at a time, as the Back does, then closes it.
 */
export function AutomationsStage({
	bot,
	signedIn,
	view,
	onViewChange,
	onStagedChange,
	onClose,
}: AutomationsStageProps) {
	const title = `${bot.name}'s automations`;
	const parent = { name: title, onBack: () => onViewChange({ kind: "list" }) };
	if (view.kind === "automation") {
		return (
			<AutomationFeed
				key={view.automationId}
				bot={bot}
				signedIn={signedIn}
				automationId={view.automationId}
				onStagedChange={onStagedChange}
				parent={parent}
				trailing={<StageClose onClose={onClose} />}
			/>
		);
	}
	const mark = (
		<IconTile size="sm">
			<RefreshCcw strokeWidth={2} />
		</IconTile>
	);
	if (view.kind === "new") {
		return (
			<Stage
				key="new"
				label="New automation"
				icon={mark}
				title="New automation"
				parent={parent}
				onClose={onClose}
			>
				<div className="-mx-6 min-h-0 flex-1 overflow-y-auto max-md:-mx-3">
					<NewAutomationPage
						owner={{ bot }}
						onCancel={() => onViewChange({ kind: "list" })}
						onCreated={(automation) =>
							onViewChange({ kind: "automation", automationId: automation.id })
						}
					/>
				</div>
			</Stage>
		);
	}
	return (
		<Stage
			// Its own, apart from a new one's, so each takes the focus as it opens.
			key="list"
			label={title}
			icon={mark}
			title={title}
			actions={
				bot.permissions.resources.manageAutomations && (
					<IconButton
						label="New automation"
						variant="bar"
						onClick={() => onViewChange({ kind: "new" })}
					>
						<Plus size={16} strokeWidth={1.75} />
					</IconButton>
				)
			}
			onClose={onClose}
		>
			<AutomationList
				bot={bot}
				onOpen={(automationId) => onViewChange({ kind: "automation", automationId })}
				onNew={() => onViewChange({ kind: "new" })}
			/>
		</Stage>
	);
}

/** The bot's automations, each with how it stands, which opens it; with none, how one is made. */
function AutomationList({
	bot,
	onOpen,
	onNew,
}: {
	bot: Bot;
	onOpen: (automationId: string) => void;
	onNew: () => void;
}) {
	const list = useListedAutomations({ bot });
	if (list.isError) {
		return <EmptyState title="Could not load these automations">{API_DID_NOT_ANSWER}</EmptyState>;
	}
	if (list.automations?.length === 0) {
		return (
			<NoAutomations
				title={`No automations for ${bot.name} yet`}
				ownerName={bot.name}
				create={
					bot.permissions.resources.manageAutomations
						? {
								newAutomation: <button type="button" onClick={onNew} />,
								// Not linked: the bot's chat is already open beside this panel.
								whoToAsk: bot.name,
							}
						: undefined
				}
			/>
		);
	}
	return (
		<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0">
			{list.automations?.map((row) => (
				<li key={row.automation.id}>
					<AutomationRow
						row={row}
						owner={{ bot }}
						render={<button type="button" onClick={() => onOpen(row.automation.id)} />}
					/>
				</li>
			))}
		</ul>
	);
}

/**
 * An automation's feed, where its runs post, opened first when it has none,
 * with its settings in its Details, Back to `parent` before its name, and
 * `trailing` at the right of its header.
 */
function AutomationFeed({
	bot,
	signedIn,
	automationId,
	onStagedChange,
	parent,
	trailing,
}: {
	bot: Bot;
	signedIn: SignedInPerson;
	automationId: string;
	onStagedChange: StagedChange;
	/** The bot's automations, which the Back before the automation's name returns to. */
	parent: StageParent;
	trailing: ReactNode;
}) {
	const opened = useOpenAutomationFeed(bot.defaultProjectId, automationId);
	const keys = usePanelKeys<HTMLElement>(parent.onBack);
	const [nestedChatId, setNestedChatId] = useState<string>();
	const [detailsOpen, setDetailsOpen] = useState(false);
	return (
		// In place of the list, and like it, covering the chat on a phone; there
		// while its feed opens, so it holds the focus from the start.
		<section
			aria-label="Automation"
			{...keys}
			className="flex min-h-0 min-w-0 flex-1 bg-background outline-none max-md:absolute max-md:inset-0 max-md:z-40"
		>
			{opened.isError ? (
				<EmptyState title="Could not open this automation">
					It may have been removed. Reload this page to try again.
				</EmptyState>
			) : (
				opened.data && (
					<ChatPane
						chatLocation={{ bot }}
						chatId={opened.data.id}
						signedIn={signedIn}
						nestedChatId={nestedChatId}
						onNestedChatChange={setNestedChatId}
						place={{ kind: "own", detailsOpen, onDetailsChange: setDetailsOpen, parent, trailing }}
						onStagedChange={onStagedChange}
					/>
				)
			)}
		</section>
	);
}
