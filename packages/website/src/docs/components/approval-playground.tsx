import { PlugIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cast } from "@/cast";
import { type ApprovalDecision, ChatApproval, ChatMessage, ChatToolLine } from "@/components/chat";
import { DemoCard } from "@/components/demo-card";
import { riseIn } from "@/components/reveal";
import { ChoiceChips } from "@/components/ui/choice-chips";

/** A tool's tool access, as the app labels it. */
const toolAccesses = {
	off: "Off",
	ask: "Ask",
	allow: "Allow",
} as const;
type ToolAccess = keyof typeof toolAccesses;

const tools = {
	read: { name: "linear__list_issues", label: "List issues", changes: false },
	change: { name: "linear__create_issue", label: "Create an issue", changes: true },
} as const;
type ToolChoice = keyof typeof tools;

type Outcome = "refused" | "waits" | "runs";

function outcomeOf(access: ToolAccess): Outcome {
	if (access === "off") return "refused";
	return access === "allow" ? "runs" : "waits";
}

const outcomeText: Record<Outcome, string> = {
	refused: "The call is refused, and the bot is told the tool is off.",
	waits: "The call waits in the chat until someone who's allowed to answer it does.",
	runs: "The tool is allowed, so it runs straight away.",
};

const decisionOutcomes = {
	allowed: "Allowed by you",
	denied: `Denied by you. ${cast.inboxSorter.name} won't go ahead.`,
} as const;

const CHOICE_LEGEND = "pb-1.5 text-sm font-semibold";

/** The approval rules to play with: set a tool's access, pick the tool, and answer the request. */
export function ApprovalPlayground() {
	const [access, setAccess] = useState<ToolAccess>("allow");
	const [tool, setTool] = useState<ToolChoice>("change");
	const [decision, setDecision] = useState<ApprovalDecision>("pending");
	const outcome = outcomeOf(access);
	const bot = cast.inboxSorter;
	const toolLabels = { read: tools.read.label, change: tools.change.label };

	function reset<T>(apply: (value: T) => void) {
		return (value: T) => {
			apply(value);
			setDecision("pending");
		};
	}

	return (
		<DemoCard>
			<div className="flex flex-wrap gap-6 border-b px-5 py-4">
				<ChoiceChips
					label="The tool's access"
					labelClassName={CHOICE_LEGEND}
					options={toolAccesses}
					value={access}
					onChange={reset(setAccess)}
				/>
				<ChoiceChips
					label="The bot wants to"
					labelClassName={CHOICE_LEGEND}
					options={toolLabels}
					value={tool}
					onChange={reset(setTool)}
				/>
			</div>
			<AnimatePresence mode="wait" initial={false}>
				<motion.div
					key={`${access}-${tool}`}
					variants={riseIn}
					initial="hidden"
					animate="visible"
					exit="hidden"
					className="flex min-h-48 flex-col justify-center gap-4 px-5 py-5"
				>
					{outcome === "waits" && (
						<ChatMessage author={bot}>
							<ChatApproval
								who={`${bot.name} wants to ${tools[tool].changes ? "make a change" : "use a tool"}`}
								action={tools[tool].name}
								mark={<PlugIcon className="size-3.5" />}
								decision={decision}
								outcomes={decisionOutcomes}
								onDecide={setDecision}
							/>
						</ChatMessage>
					)}
					{outcome === "runs" && (
						<ChatMessage author={bot}>
							<ChatToolLine>Used {tools[tool].name} for 2s</ChatToolLine>
						</ChatMessage>
					)}
					<p className="text-pretty">{outcomeText[outcome]}</p>
				</motion.div>
			</AnimatePresence>
		</DemoCard>
	);
}
