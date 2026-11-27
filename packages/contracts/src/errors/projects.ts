/**
 * The errors the projects operations can fail with: `Schema.TaggedError` classes
 * implementing `DomainError`.
 */

import { DisplayName, type DomainError, userText } from "@sugabots/errors";
import { ErrorReporter, Schema } from "effect";
import { PROJECT_DESCRIPTION_MAX_LENGTH, PROJECT_NAME_MAX_LENGTH } from "../projects.ts";

/** No address can be derived from the name a project was given. */
export class UnusableProjectName
	extends Schema.TaggedError<UnusableProjectName>()("UnusableProjectName", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "No project address can be derived from the name given";
	}
	get userMessage() {
		return userText`That name can't be a project's address. Choose another.`;
	}
}

/** A project's name is empty or too long, or its description too long. */
export class InvalidProjectDetails
	extends Schema.TaggedError<InvalidProjectDetails>()("InvalidProjectDetails", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project's name or description is out of bounds";
	}
	get userMessage() {
		return userText`A project's name must be 1 to ${PROJECT_NAME_MAX_LENGTH} characters, and its description at most ${PROJECT_DESCRIPTION_MAX_LENGTH}.`;
	}
}

/** The slug is taken by another project in this workspace. */
export class ProjectSlugTaken
	extends Schema.TaggedError<ProjectSlugTaken>()("ProjectSlugTaken", { slug: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `A project with the slug "${this.slug}" already exists in this workspace`;
	}
	get userMessage() {
		return userText`A project with that address already exists in this workspace`;
	}
}

/** A project update that names nothing to change. */
export class EmptyProjectUpdate
	extends Schema.TaggedError<EmptyProjectUpdate>()("EmptyProjectUpdate", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The project update names nothing to change";
	}
	get userMessage() {
		return userText`Nothing to change`;
	}
}

/**
 * The project was deleted before the write reached it, or is a bot's default
 * project, which is made and deleted with its bot and has no settings of its own.
 */
export class ProjectGone
	extends Schema.TaggedError<ProjectGone>()("ProjectGone", { projectId: Schema.String })
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return `No project members made with the id "${this.projectId}"`;
	}
	get userMessage() {
		return userText`No such project`;
	}
}

/** Administrators belong to every project members made, so nobody takes one out of it. */
export class AdministratorInEveryProject
	extends Schema.TaggedError<AdministratorInEveryProject>()("AdministratorInEveryProject", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "An administrator can't be taken out of a project members made";
	}
	get userMessage() {
		return userText`Administrators are in every project`;
	}
}

/** Only a member in the project's workspace can be added to it. */
export class NotInWorkspace
	extends Schema.TaggedError<NotInWorkspace>()("NotInWorkspace", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The member to add is not in the project's workspace";
	}
	get userMessage() {
		return userText`That member is not in this workspace`;
	}
}

/** The member to take out of the project isn't in it. */
export class NotInProject
	extends Schema.TaggedError<NotInProject>()("NotInProject", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The member to take out is not in the project";
	}
	get userMessage() {
		return userText`That member is not in this project`;
	}
}

/** Only a public bot of the workspace is put in a project. */
export class BotNotPublic
	extends Schema.TaggedError<BotNotPublic>()("BotNotPublic", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot is not a public bot of the project's workspace";
	}
	get userMessage() {
		return userText`Only a public bot can be added to a project`;
	}
}

const LIST = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The bot leads projects members made, so it stays in them, public, until each
 * has another lead. `projects` names those the member refused sees;
 * `leadsUnseenProjects` says it also leads private ones they aren't in.
 */
export class LeadsProjects
	extends Schema.TaggedError<LeadsProjects>()("LeadsProjects", {
		botName: DisplayName.schema,
		projects: Schema.Array(DisplayName.schema),
		leadsUnseenProjects: Schema.Boolean,
	})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "The bot leads projects members made, so it stays in them until each has another lead";
	}
	get userMessage() {
		if (this.leadsUnseenProjects) {
			if (this.projects.length === 0) {
				return userText`${this.botName} leads private projects you aren't in. Each needs another lead bot first.`;
			}
			const names = DisplayName.fromRecord(this.projects.join(", "));
			return userText`${this.botName} leads ${names} and private projects you aren't in. Each needs another lead bot first.`;
		}
		// A list of names members see is itself a name they see.
		const names = DisplayName.fromRecord(LIST.format(this.projects));
		const them = this.projects.length === 1 ? "it" : "each";
		return userText`${this.botName} leads ${names}. Choose another lead bot for ${them} first.`;
	}
}
