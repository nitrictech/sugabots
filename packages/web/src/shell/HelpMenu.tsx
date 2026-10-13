import { SugabotsMark } from "@sugabots/avatars";
import { projectLinks } from "@sugabots/contracts/project-links";
import {
	ArrowUpRight,
	BookOpen,
	Bug,
	Check,
	CircleHelp,
	Copy,
	Info,
	type LucideIcon,
	MessageCircle,
	Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	bugReportUrl,
	debugDetails,
	debugText,
	describeEnvironment,
	type Environment,
	type RunningBuild,
	useRunningBuild,
} from "@/lib/help.ts";
import { Button } from "@/ui/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu.tsx";
import { SettingsGroup, SettingsRow, SettingsValue } from "@/ui/settings-page.tsx";
import { Tooltip } from "@/ui/tooltip.tsx";
import { useCopy } from "@/ui/use-copy.ts";

/**
 * The ? at the bottom of the rail. Its menu leads out to the docs, Discord, a
 * new bug report and the release notes, and opens About, which shows the
 * running version and copies it with the browser and system for a bug report.
 *
 * It asks the API for the version only once the menu or About is open.
 */
export function HelpMenu() {
	const [menuOpen, setMenuOpen] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(false);
	const running = useRunningBuild(menuOpen || aboutOpen);
	const environment = useMemo(() => describeEnvironment(navigator.userAgent), []);
	const known = running.state === "known" ? running.build : undefined;

	return (
		<>
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<Tooltip label="Help" side="right">
					<DropdownMenuTrigger
						aria-label="Help"
						className="focus-ring grid size-9 shrink-0 place-items-center rounded-full bg-panel text-muted-foreground transition-colors hover:text-foreground data-popup-open:bg-chip-strong data-popup-open:text-foreground"
					>
						<CircleHelp aria-hidden size={18} strokeWidth={2} />
					</DropdownMenuTrigger>
				</Tooltip>
				<DropdownMenuContent side="right" align="end" className="min-w-60">
					<ExternalItem href={projectLinks.documentation} icon={BookOpen}>
						Documentation
					</ExternalItem>
					<ExternalItem href={projectLinks.discord} icon={MessageCircle}>
						Ask on Discord
					</ExternalItem>
					{/* Waits for the version, so the report doesn't go out without one that was on its way. */}
					<ExternalItem
						href={bugReportUrl(known, environment)}
						icon={Bug}
						disabled={running.state === "checking"}
					>
						Report a bug
					</ExternalItem>
					<ExternalItem href={projectLinks.releases} icon={Sparkles}>
						What's new
					</ExternalItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setAboutOpen(true)}>
						<Info aria-hidden className="text-muted-foreground" />
						<span className="flex-1">About Sugabots</span>
						{known?.versioned && (
							<span className="text-muted-foreground text-sm tabular-nums">{known.version}</span>
						)}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
				<AboutDialog running={running} environment={environment} />
			</Dialog>
		</>
	);
}

/** A menu item that opens `href` in a new tab, marked with an arrow. */
function ExternalItem({
	href,
	icon: Icon,
	disabled = false,
	children,
}: {
	href: string;
	icon: LucideIcon;
	disabled?: boolean;
	children: string;
}) {
	return (
		<DropdownMenuItem
			disabled={disabled}
			render={<a href={href} target="_blank" rel="noopener noreferrer" />}
		>
			<Icon aria-hidden className="text-muted-foreground" />
			<span className="flex-1">{children}</span>
			<span className="sr-only">(opens in a new tab)</span>
			<ArrowUpRight aria-hidden className="size-3.5 text-subtle-foreground" />
		</DropdownMenuItem>
	);
}

/**
 * What is running, in four rows, and a button that copies them for Discord or
 * an issue. Copying waits until the API has said which build it is, or
 * couldn't. On a phone it rises from the bottom as a sheet.
 */
export function AboutDialog({
	running,
	environment,
}: {
	running: RunningBuild;
	environment: Environment;
}) {
	const copying = useCopy("Copy debug info");
	const details = debugDetails(running, environment);
	const known = running.state === "known" ? running.build : undefined;
	return (
		<DialogContent sheetOnPhone className="gap-4 p-5 pt-6 sm:max-w-100">
			<div className="flex flex-col items-center gap-2.5">
				<SugabotsMark className="size-14" />
				<DialogTitle className="text-lg">Sugabots</DialogTitle>
			</div>
			<SettingsGroup
				note={
					known && !known.versioned
						? "This build wasn't given a version. When you ask for help, say how you installed Sugabots too."
						: "Paste these into Discord or a bug report so we know what you're running."
				}
			>
				<SettingsRow label="Version" trailing={<SettingsValue>{details.version}</SettingsValue>} />
				<SettingsRow
					label="Commit"
					trailing={
						<SettingsValue>
							{known?.commit ? <span className="font-mono">{details.commit}</span> : details.commit}
						</SettingsValue>
					}
				/>
				<SettingsRow label="Browser" trailing={<SettingsValue>{details.browser}</SettingsValue>} />
				<SettingsRow label="System" trailing={<SettingsValue>{details.system}</SettingsValue>} />
			</SettingsGroup>
			<Button
				variant={copying.copied ? "secondary" : "default"}
				disabled={running.state === "checking"}
				onClick={() => void copying.copy(debugText(details))}
			>
				{copying.copied ? <Check aria-hidden /> : <Copy aria-hidden />}
				{copying.label}
			</Button>
		</DialogContent>
	);
}
