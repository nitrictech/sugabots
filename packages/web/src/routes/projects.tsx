import type { Project } from "@sugabots/contracts";
import { createRoute, Navigate, Outlet } from "@tanstack/react-router";
import { prefetchConversation, useProjectThreadPlace, useProjectThreads } from "@/lib/chats.ts";
import { failureMessage } from "@/lib/failure.ts";
import { conversationLink } from "@/lib/links.ts";
import { SIDE_BY_SIDE, useMediaQuery } from "@/lib/media.ts";
import { findProject, useJoinProject, useProjects, useUpdateProject } from "@/lib/projects.ts";
import { useSession } from "@/lib/session.ts";
import { FilesPage } from "@/screens/Files.tsx";
import { LeadBotPicker } from "@/shell/LeadBotPicker.tsx";
import { MobileProject } from "@/shell/MobileHome.tsx";
import { OwnerNotFound } from "@/shell/OwnerNotFound.tsx";
import { ProjectsDirectory } from "@/shell/ProjectsDirectory.tsx";
import { Panes } from "@/shell/Shell.tsx";
import { Button } from "@/ui/button.tsx";
import { EmptyState } from "@/ui/empty-state.tsx";
import {
	API_DID_NOT_ANSWER,
	ConversationPage,
	ConversationScreen,
	preloadChatScreenForWideLayout,
	RoutedConversation,
	type SearchChange,
} from "./conversation.tsx";
import { lazyNamed } from "./lazy-screen.tsx";
import {
	type ConversationSearch,
	validateConversationSearch,
	validateFileSearch,
} from "./search.ts";
import { shellRoute } from "./workspace.tsx";

const NewThreadPage = lazyNamed(() => import("@/screens/NewThreadPage.tsx"), "NewThreadPage");

/** Every project the person is in or could join, and making another. */
export const projectsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/projects",
	component: () => (
		<Panes>
			<ProjectsDirectory />
		</Panes>
	),
});

export const projectRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/projects/$project",
	loader: preloadChatScreenForWideLayout,
	component: ProjectRoute,
});

/** A project's page beside the sidebar. */
function ProjectRoute() {
	const { project: slug } = projectRoute.useParams();
	const { data: projects, isPending, error } = useProjects();
	const project = findProject(projects, slug);
	if (isPending) return <Panes>{null}</Panes>;
	if (!project) return <OwnerNotFound kind="project" error={error} />;
	// A public project the person isn't in, opened by its address: what it is, and Join.
	if (!project.isMember) {
		return (
			<Panes>
				<JoinProject project={project} />
			</Panes>
		);
	}
	// A project with no lead bot waits on somebody choosing one.
	if (project.leadBotId === null && project.permissions.rename) {
		return (
			<Panes>
				<ChooseLeadBot project={project} />
			</Panes>
		);
	}
	return (
		<Panes>
			<Outlet />
		</Panes>
	);
}

/** A project with no lead bot yet, and choosing one, for whoever may change the project. */
function ChooseLeadBot({ project }: { project: Project }) {
	const update = useUpdateProject(project.id);
	return (
		<EmptyState title={`Choose a lead bot for ${project.name}`}>
			<span className="flex flex-col items-center gap-3">
				<span>
					The lead bot answers the project's threads unless people mention another bot, and reads
					the messages that mention only people, in case it can help.
				</span>
				<LeadBotPicker
					value={null}
					disabled={update.isPending}
					onChange={(leadBotId) => void update.mutateAsync({ leadBotId }).catch(() => {})}
				/>
				{update.isError && <span role="alert">{failureMessage(update.error)}</span>}
			</span>
		</EmptyState>
	);
}

/** A project the person isn't in: its name and what it's for, with Join where they may. */
function JoinProject({ project }: { project: Project }) {
	const join = useJoinProject();
	return (
		<EmptyState title={project.name}>
			<span className="flex flex-col items-center gap-3">
				<span>{project.description ?? "You're not in this project yet."}</span>
				{project.permissions.join ? (
					<Button disabled={join.isPending} onClick={() => join.mutate(project.id)}>
						Join {project.name}
					</Button>
				) : (
					<span>Ask someone in it to add you.</span>
				)}
				{join.isError && <span role="alert">{failureMessage(join.error)}</span>}
			</span>
		</EmptyState>
	);
}

/**
 * A project opened without a thread chosen: on a phone, its sidebar as a
 * page, to pick from; on a wider screen, its newest thread, or, while it has
 * none, starting one, as a bot's index always does.
 */
export const projectIndexRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/",
	loader: () => ConversationPage.preload(),
	component: () => {
		const project = findProject(useProjects().data, projectIndexRoute.useParams().project);
		const wide = useMediaQuery(SIDE_BY_SIDE);
		if (!project) return null;
		return wide ? <OpenNewestThread project={project} /> : <MobileProject project={project} />;
	},
});

function OpenNewestThread({ project }: { project: Project }) {
	const list = useProjectThreads(project.slug);
	if (list.isError) {
		return <EmptyState title="Could not open this project">{API_DID_NOT_ANSWER}</EmptyState>;
	}
	if (!list.data) return null;
	const [newest] = list.data.chats;
	if (!newest) return <ProjectNewThread project={project} />;
	return (
		<Navigate {...conversationLink({ project, conversationId: newest.conversation.id })} replace />
	);
}

/** Starting a thread in `project` from its first message, which its lead bot answers. */
function ProjectNewThread({ project }: { project: Project }) {
	const { user } = useSession();
	return user ? <NewThreadPage key={project.id} owner={{ project }} userId={user.id} /> : null;
}

/** Starting a thread in the project, from its first message. */
export const projectNewThreadRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/new",
	component: () => {
		const project = findProject(useProjects().data, projectNewThreadRoute.useParams().project);
		return project ? <ProjectNewThread project={project} /> : null;
	},
});

export const projectFilesRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/files",
	component: () => {
		const project = findProject(useProjects().data, projectFilesRoute.useParams().project);
		return project ? <FilesPage owner={{ project }} /> : null;
	},
});

export const projectFileRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/files/$file",
	validateSearch: (search: Record<string, unknown>) => validateFileSearch(search),
	component: () => {
		const { project: slug, file } = projectFileRoute.useParams();
		const { version } = projectFileRoute.useSearch();
		const project = findProject(useProjects().data, slug);
		return project ? <FilesPage owner={{ project }} selectedId={file} version={version} /> : null;
	},
});

/** One of a project's threads. */
export const projectThreadRoute = createRoute({
	getParentRoute: () => projectRoute,
	path: "/$conversation",
	validateSearch: (search: Record<string, unknown>) => validateConversationSearch(search),
	// On every hover, not once per 30 s: the query cache, not the router,
	// decides what of the conversation is still fresh.
	preloadStaleTime: 0,
	// Also run while the pointer is on a link here, so it is loading before the click.
	loader: ({ context, params }) => {
		prefetchConversation(context.queries, params.conversation);
		return ConversationPage.preload();
	},
	component: () => {
		const { project, conversation } = projectThreadRoute.useParams();
		const navigate = projectThreadRoute.useNavigate();
		const search = projectThreadRoute.useSearch();
		return (
			<ProjectConversation
				projectSlug={project}
				conversationId={conversation}
				search={search}
				navigate={(change) => void navigate(change)}
			/>
		);
	},
});

/**
 * One of the conversations of the project at `projectSlug`, one of its
 * threads or automations' feeds, at its own address; see `RoutedConversation`.
 */
export function ProjectConversation({
	projectSlug,
	conversationId,
	search,
	navigate,
}: {
	projectSlug: string;
	conversationId: string;
	search: ConversationSearch;
	navigate: (change: SearchChange) => void;
}) {
	return (
		<ConversationScreen place={useProjectThreadPlace(projectSlug, conversationId)}>
			{(found, user) => (
				<RoutedConversation
					found={found}
					conversationId={conversationId}
					user={user}
					search={search}
					navigate={navigate}
				/>
			)}
		</ConversationScreen>
	);
}
