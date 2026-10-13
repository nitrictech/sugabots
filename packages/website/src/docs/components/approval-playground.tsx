import { cn } from "cn";
import { PlugIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { type ApprovalDecision, ChatApproval, ChatMessage, ChatToolLine } from "@/components/chat";
import { riseIn } from "@/components/reveal";
import { Card } from "@/components/ui/card";
import { cast } from "@/docs/cast";

/** A tool's approval setting, as the app labels it. */
const approvals = {
	off: "Off",
	ask: "Ask",
	allow: "Allow",
} as const;
type ApprovalSetting = keyof typeof approvals;

const tools = {
	read: { name: "linear__list_issues", label: "List issues", changes: false },
	change: { name: "linear__create_issue", label: "Create an issue", changes: true },
} as const;
type ToolChoice = keyof typeof tools;

type Outcome = "refused" | "waits" | "runs";

function outcomeOf(setting: ApprovalSetting): Outcome {
	if (setting === "off") return "refused";
	return setting === "allow" ? "runs" : "waits";
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

function Choice<T extends string>({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: Record<T, string>;
	value: T;
	onChange: (value: T) => void;
}) {
	return (
		<fieldset className="flex flex-col gap-2">
			<legend className="pb-1.5 text-sm font-semibold">{label}</legend>
			<div className="flex flex-wrap gap-2">
				{(Object.keys(options) as T[]).map((option) => (
					<button
						key={option}
						type="button"
						aria-pressed={option === value}
						onClick={() => onChange(option)}
						className={cn(
							"rounded-full border-2 px-3 py-0.5 text-sm font-semibold transition-colors",
							option === value
								? "border-foreground bg-foreground text-background"
								: "border-input text-muted-foreground hover:text-foreground",
						)}
					>
						{options[option]}
					</button>
				))}
			</div>
		</fieldset>
	);
}

/** The approval rules to play with: set a tool's approval, pick the tool, and answer the request. */
export function ApprovalPlayground() {
	const [setting, setSetting] = useState<ApprovalSetting>("allow");
	const [tool, setTool] = useState<ToolChoice>("change");
	const [decision, setDecision] = useState<ApprovalDecision>("pending");
	const outcome = outcomeOf(setting);
	const bot = cast.inboxSorter;
	const toolLabels = { read: tools.read.label, change: tools.change.label };

	function reset<T>(apply: (value: T) => void) {
		return (value: T) => {
			apply(value);
			setDecision("pending");
		};
	}

	return (
		<Card className="my-8 gap-0 rounded-3xl py-0 shadow-xl">
			<div className="flex flex-wrap gap-6 border-b px-5 py-4">
				<Choice
					label="The tool's approval"
					options={approvals}
					value={setting}
					onChange={reset(setSetting)}
				/>
				<Choice
					label="The bot wants to"
					options={toolLabels}
					value={tool}
					onChange={reset(setTool)}
				/>
			</div>
			<AnimatePresence mode="wait" initial={false}>
				<motion.div
					key={`${setting}-${tool}`}
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
		</Card>
	);
}
