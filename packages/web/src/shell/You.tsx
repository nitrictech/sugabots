import { useRender } from "@base-ui/react/use-render";
import { projectLinks } from "@sugabots/contracts/project-links";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useAgents } from "@/lib/agents.ts";
import { useRunningBuild } from "@/lib/help.ts";
import { podSettingsLink } from "@/lib/links.ts";
import { countOf } from "@/lib/name-list.ts";
import { usePods } from "@/lib/pods.ts";
import { useSession, useSignOut } from "@/lib/session.ts";
import { useWorkspace } from "@/lib/workspace.ts";
import { PodInitial } from "@/shell/SidebarPod.tsx";
import { PersonAvatar } from "@/ui/avatar.tsx";

/**
 * You, a phone's last tab: who you are, then the workspace and each of its
 * pods, each opening its settings, your preferences, the docs, the version
 * running, and Sign out. A tablet up keeps these in the sidebar's menus.
 */
export function You() {
	const user = useSession().user;
	const { workspace } = useWorkspace();
	const { data: pods } = usePods();
	const { agents } = useAgents();
	const running = useRunningBuild(true);
	const signOut = useSignOut();
	if (!user || !workspace) return null;
	const params = { workspace: workspace.slug };
	return (
		<section
			aria-label="You"
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-[calc(env(safe-area-inset-top)+22px)] pb-6"
		>
			<div className="flex items-center gap-3.5">
				<PersonAvatar person={user} size={56} />
				<div className="flex min-w-0 flex-col gap-0.5">
					<h1 className="m-0 truncate font-semibold text-[20px] text-foreground">{user.name}</h1>
					<span className="truncate text-[13px] text-muted-foreground">{user.email}</span>
				</div>
			</div>
			<Group title="Workspace">
				<Row
					render={<Link to="/$workspace/settings" params={params} />}
					mark={
						<span
							aria-hidden
							className="grid size-6 place-items-center rounded-[6px] bg-foreground font-semibold text-[12px] text-background"
						>
							{Array.from(workspace.name.trim())[0]?.toUpperCase() ?? "?"}
						</span>
					}
					value="Settings"
				>
					{workspace.name}
				</Row>
			</Group>
			{pods && pods.length > 0 && (
				<Group title="Pods">
					{pods.map((pod) => (
						<Row
							key={pod.id}
							render={<Link {...podSettingsLink(pod)} />}
							mark={<PodInitial pod={pod} className="size-6 rounded-[6px] text-[12px]" />}
							value={
								agents &&
								countOf(agents.filter((agent) => agent.podId === pod.id).length, "bot", "bots")
							}
						>
							{pod.name}
						</Row>
					))}
				</Group>
			)}
			<Group title="Account">
				<Row
					render={
						<Link to="/$workspace/settings/$section" params={{ ...params, section: "profile" }} />
					}
				>
					Preferences
				</Row>
				<Row render={<a href={projectLinks.documentation} target="_blank" rel="noreferrer" />}>
					Help and docs
				</Row>
				{running.state === "known" && running.build.versioned && (
					<Row value={running.build.version}>Version</Row>
				)}
			</Group>
			<Group>
				<Row onClick={() => void signOut()} className="text-destructive-text">
					Sign out
				</Row>
			</Group>
		</section>
	);
}

/** A card of rows, ruled apart, under its name. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-2">
			{title && <h2 className="m-0 px-1 font-medium text-[13px] text-muted-foreground">{title}</h2>}
			<ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-[12px] border border-border bg-list p-0">
				{children}
			</ul>
		</div>
	);
}

/**
 * One row of a group: a mark at its left when it has one, what it is, a
 * quieter value at its right, and a chevron when it leads somewhere, as a
 * link given as `render` does. With `onClick` it is a button; with neither, a
 * line.
 */
function Row({
	render,
	onClick,
	mark,
	value,
	className,
	children,
}: {
	render?: ReactElement;
	onClick?: () => void;
	mark?: ReactNode;
	value?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const acts = render !== undefined || onClick !== undefined;
	const row = useRender({
		render: render ?? (onClick ? <button type="button" onClick={onClick} /> : <span />),
		props: {
			className: cn(
				"flex min-h-[52px] w-full items-center gap-3 px-3.5 text-left text-[15px] text-foreground",
				acts && "focus-ring active:bg-row-hover",
				className,
			),
			children: (
				<>
					{mark}
					<span className="min-w-0 flex-1 truncate">{children}</span>
					{value && <span className="shrink-0 text-[14px] text-subtle-foreground">{value}</span>}
					{render && (
						<ChevronRight
							aria-hidden
							size={16}
							strokeWidth={2}
							className="text-subtle-foreground"
						/>
					)}
				</>
			),
		},
	});
	return <li className="flex">{row}</li>;
}
