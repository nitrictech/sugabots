/**
 * The projects operations' bodies, and the layer of the services they are built
 * from. `registry.ts` gathers the operations and `layer.ts` the layers, so
 * adding an operation here touches no other file.
 */

import { Projects } from "../../workspaces/projects/projects.ts";
import { addBot } from "./add-bot.ts";
import { addMember } from "./add-member.ts";
import { create } from "./create.ts";
import { join } from "./join.ts";
import { leave } from "./leave.ts";
import { list } from "./list.ts";
import { listBots } from "./list-bots.ts";
import { listMembers } from "./list-members.ts";
import { listMembersReaching } from "./list-members-reaching.ts";
import { remove } from "./remove.ts";
import { removeBot } from "./remove-bot.ts";
import { removeMember } from "./remove-member.ts";
import { update } from "./update.ts";

export const projectsOperations = {
	"projects.list": list,
	"projects.create": create,
	"projects.update": update,
	"projects.remove": remove,
	"projects.listMembers": listMembers,
	"projects.listMembersReaching": listMembersReaching,
	"projects.addMember": addMember,
	"projects.removeMember": removeMember,
	"projects.leave": leave,
	"projects.join": join,
	"projects.listBots": listBots,
	"projects.addBot": addBot,
	"projects.removeBot": removeBot,
};

export const projectsLayer = Projects.layer;
