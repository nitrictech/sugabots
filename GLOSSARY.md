# Glossary

**One name for each thing. Synonyms are banned.**

The words Sugabots uses for its concepts, and for how it is built. The product, the docs, bot prompts, comments, identifiers and commit messages all use these and no others. If a word you need isn't here, add it here first, in the same change. If two words seem to mean the same thing, one of them is wrong.

Each table's **Banned synonyms** are words people reach for that mean the same thing: don't use them for it. [Retired terms](#retired-terms) are banned too.

This glossary and [ARCHITECTURE.md](https://github.com/nitrictech/sugabots-architecture-docs/blob/main/ARCHITECTURE.md) describe Sugabots as it will be once the code is cut over to them, not the code as it is today. The glossary names no identifiers: the code will take its names from these words.

A library's word, such as Effect's `Layer`, `Scope` or `Workflow`, MCP's tool or models.dev's price tiers, means only what that library means by it.

A comment explains with these definitions. "Whoever can talk to the bot can read and join its chats" is right; "everyone in the channel reads its tasks" is not, even where the code it describes is not renamed yet.

## People and the workspace

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Workspace** | A team's space: its people, bots, projects and settings. Everything below belongs to one workspace. A person may belong to several. | organisation, org, tenant, account |
| **Server** | One Sugabots installation, holding one or more workspaces. | instance, deployment, site |
| **Person** | Someone with an account, in one or more workspaces. | human, individual, member, user |
| **Role** | What a person may do in a workspace: **owner**, **admin**, **editor** or **viewer**. | access level, permission level |
| **Owner** | The one person who created the workspace, or was handed it. Can do everything an admin can, and **hand over** ownership to another person in the workspace. Only the owner may make or remove admins. | super admin, creator (a bot's), transfer (of ownership) |
| **Admin** | May manage the workspace's settings, its people (but not other admins) and every bot but Personal Assistants, and sees private bots in lists (not their chats). Admins are members of every project people made. | superuser, moderator, manager |
| **Editor** | May create bots and projects, talk to public bots and take part in projects. | user (for this role), member |
| **Viewer** | May read what they reach and take part, but not create or change anything. | guest, observer, read-only member |
| **Invitation** | An email inviting someone to the workspace with a role. It stays **pending** until accepted, expires after a set number of days, and can be sent again. | invite (as a noun), join link, outstanding invite |
| **Workspace setup** | Making a new workspace: its creator becomes its owner. | onboarding, setup, sign-up (that makes an account, not a workspace) |
| **Workspace settings** | Settings for the whole workspace: models, computers, web search, allowed and blocked hosts, time zone, people and usage. | preferences, configuration, admin panel |
| **Notification** | A push or email telling a person something needs them. It goes to the people who reach where it happened. | alert, ping |
| **Notification level** | What a person is notified about: everything, mentions and replies, or nothing. | notification setting, subscription |
| **Quiet hours** | Times a person gets no notifications, in their device's time zone. | do not disturb, snooze |
| **Referral link** | A person's link that signs someone up, on a server that admits people by referral. | invite link, join link (an invitation is an email) |
| **Account** | A person's sign-in: an email and password, or a provider login. One account can be in several workspaces. | login, profile, user |
| **Membership** | A person's place in one workspace, with its role. Role changes and removal act on a membership. | seat, enrolment |
| **Sign in** | Starting a session on an account. | log in, login (as a verb) |
| **Sign out** | Ending a session on an account. | log out, logout (as a verb) |
| **Sign-up mode** | How a server lets people make accounts: **closed** (by invitation only, except the first account), **referral** or **open**. | signup policy, registration mode |
| **Operator** | Whoever runs a server: sets its server settings and reads its log messages. | sysadmin, host |
| **Server setting** | A setting for the whole server, set by its operator, such as its sign-up mode. | installation setting, config, env |
| **Mute** | A person silencing one project's or bot's notifications, for good or until a set time, whatever their notification level. | silence, snooze |
| **Notification pause** | Pausing every notification until a set time. | snooze, do not disturb |
| **Signed-in person** | The person a session belongs to, on the client in use. | current user |
| **People settings** | The part of workspace settings listing the workspace's memberships. | — |

## Bots

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Bot** | An AI teammate with a name, handle, avatar, model and instructions. Every bot people talk to, Personal Assistants included, has its own hidden **default project**, which it leads alone, so it has **chats**, **files**, **computers**, **connectors** and **automations** just as a project does. | agent, AI, assistant (except a Personal Assistant), character, persona, model |
| **Handle** | A bot's or person's `@name`. A bot people made has one no other such bot in the workspace has. A person's is made from their name, so two people can share one, as "Sam Rose" and "Sam-Rose" both have `@sam-rose`, and a mention of it mentions both. | username, tag |
| **Creator** | The person who made a bot. The creator and admins may change it. | owner (a role), maker |
| **Public bot** | A bot everyone in the workspace can see and talk to, along with its chats and files. Only public bots can be added to projects. | shared bot, workspace bot |
| **Private bot** | A bot only its creator can see and talk to. Admins see that it exists, not its chats. Another bot may ask it for help only from a chat its creator alone reaches. | personal bot, hidden bot, secret bot |
| **Pinned bot** | A bot a person has pinned to their sidebar. The sidebar shows pinned bots only; the rest are found by browsing. A bot is pinned for its creator when made. | favourite, starred bot, bookmark |
| **Personal Assistant** | Each person's own bot that nobody else can talk to: a guide that knows the workspace, points them to the right bot, tells them what needs their attention, and does things for them with their approval. Neither public nor private: only its person ever sees it. Always first in the sidebar. We manage its instructions; its person may change its name and avatar, add connectors, and manage, run and answer the approvals of its **automations**. Only its person manages it; other bots may ask it for help only from a chat its person alone reaches. | PA (in the product), personal bot, concierge |
| **System bot** | A bot that does background work and nobody talks to: **Compaction**, which shortens long chats. | internal bot, service bot, background bot |
| **Instructions** | A bot's prompt: who it is and how it works. A new bot starts by interviewing its creator to write them. | system prompt, persona, profile |
| **Model** | The language model a bot runs on, from one of the workspace's model providers. | LLM (in the product), engine, brain |
| **Avatar** | A bot's picture: its **shape**, **eyes** and **colour**. | look, icon, appearance |
| **Interview** | How a new bot asks its creator questions to write its instructions. | onboarding (a bot's), setup wizard |
| **Model provider** | A service the workspace's models come from, signed in with a key. | LLM provider, vendor, backend |
| **Model lab** | Who made a model, such as Meta, where a model provider resells it. | vendor, maker |
| **Default model** | The model new bots run on unless another is chosen. | fallback model, base model |
| **Model test** | Test questions put to a model before system bots run on it, to check it can do their work. | model check, model trial, probe, health check |
| **Context window** | How much of a chat a model can read at once; "short-term memory" in the product. | context (alone), memory, token limit |
| **Built-in tool** | A tool Sugabots ships, such as running a command or searching the web, rather than one from a connector. | native tool, core tool, system tool |
| **Connector tool** | A tool a connector's server describes, with the server's own name, description and hints. | MCP tool, server tool, remote tool |
| **Tool call** | One use of a tool in a step: its input, and its output or error. | function call, invocation, tool part |
| **Tool source** | What a tool call reached: a connector, or one built-in tool such as web search. | app |
| **Built-in provider** | A model, search or computer provider Sugabots ships settings for, with its defaults and, for a model provider, the models worth offering before discovery. | preset, catalog entry, provider catalog |
| **Model discovery** | Asking a model provider which models it offers. | model sync, model fetch |
| **Subscription sign-in** | Signing a model provider in with a person's plan instead of a key. | OAuth (for this), account link |
| **Computer use** | A bot's switch that lets it work on its project's computer. Off until someone who manages the computer turns it on. | sandbox access, shell access |
| **Description** | One line on what a bot is for, read by people and other bots. Separate from its instructions. | bio, tagline, summary |
| **Natural browsing** | A bot's setting to browse at a person's pace, with a visible cursor, so people watching its desktop can follow. Slower, and off by default. | demo mode, human mode, slow mode |
| **System model** | The model system bots run on, chosen separately from the default model. | background model, behind-the-scenes model |
| **Custom model provider** | A model provider that isn't a built-in provider, added by its URL, API format and key. | OpenAI-compatible provider, gateway, custom endpoint |
| **Local model provider** | A model provider the workspace runs itself, such as Ollama. Its address matters more than a key, and its requests cost nothing. | self-hosted provider, on-prem provider |
| **API format** | The protocol a model provider speaks: OpenAI's or Anthropic's. A dialect is a variation on one. | protocol, flavour |
| **Model capability** | What a model can take or do, as its provider reports: tools, vision, images, audio, thinking. An admin may switch some off for bots, but can't add more. | feature, modality |
| **Tool search** | How a bot finds tools that aren't offered at every step, then uses one by its full name. | deferred tools, tool discovery |
| **Compacted history** | What a bot rereads in place of a long chat's older messages: a condensed account of them, then the newest messages word for word. Nothing in the chat is deleted. | summary, recap, truncation |

## Projects and chats

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Project** | A long-running piece of work shared by many people and many bots, led by one **lead bot**, holding its **chats**, **files**, **computers**, **connectors** and **automations**. **Public** projects are listed in the project directory for anyone to find and join, but nobody is made a member; **private** ones are invitation-only. Any project member but a viewer may invite or remove people, and add bots, which must be public; a bot made private leaves every project people made, so it must first be replaced as lead in each of those it leads, as it must before it is deleted. The owner and admins are members of every project people made, and can be neither removed nor leave; anyone else may leave. | space, room, team, folder, workspace |
| **Chat** | Anywhere messages are posted. Most are a project's chats, with its people and bots: a project is made of its chats, with no main chat beside them. A **bot's chats** are the chats of its default project: chats with that one bot. Whoever can talk to the bot can read and join its chats. A project's chat can be marked resolved. An automation's feed, a collaboration, a run and a system bot's work each have a chat of their own too. | thread, topic, room, DM, conversation |
| **Lead bot** | The one bot that works on a project and answers its chats by default. Every project has one, chosen from public bots; a bot's default project is led by the bot. | main bot, primary bot, default bot |
| **Default project** | The hidden project every bot people talk to has (Personal Assistants included, system bots not), with only that bot in it as lead: where its own chats, files, computers, connectors and automations live. Never listed in the project directory; nobody joins it; whoever can talk to the bot reaches it. Made and deleted with its bot. | home project, personal project, bot project |
| **Project member** | A person or bot in a project. | collaborator (a collaboration is a bot asking a bot) |
| **Project directory** | The list of public projects, and the private ones you're in, where you find, join and create projects. | project list, catalogue |
| **Message** | One post in a chat, by a person or a bot. | post, comment |
| **Mention** | `@handle` in a message. Mentioning a bot asks it to reply; mentioning several bots asks each of them, at the same time. | tag, ping |
| **Turn** | One bot working on a reply: reading, using tools and writing, through the **bot loop**. It is made of **steps** and acts for its **asker**. It may wait for approvals; each time it resumes, in whatever process, it checks its principal again. | run (an automation's), job, generation, response |
| **Floor** | Which bots reply to a person's message in a chat (a bot's message gets no floor), the same rule in every project: the project's bots it mentions, each at once; else the project's bot it replies to; else, when it mentions only people, the lead bot reads it and may stay silent, reacting 👀; else the lead bot. Mentions of bots outside the project are ignored, so in a bot's own chats only that bot can answer, by the same rule: it may stay silent on a message that mentions only people, and with no model it does not answer one. In an automation feed, the lead bot answers every message unless it mentions only people, when no bot does; mentions bring in no other bot. | routing, dispatch, turn-taking |
| **Collaboration** | A bot asking another bot for help: one everyone who reaches the asking chat can talk to. The other bot works in a chat of its own, in its default project, for the same asker (or run), and its answer comes back to the bot that asked. People read that chat, and its files, through the one it was opened from, while they can talk to the helper. Collaborations nest at most three chats deep. | delegation, handoff, subagent, subtask |
| **Tool** | Something a bot can do besides write: run commands, search the web, use a connector. | function (except in a model provider's API), action, skill, command |
| **Approval** | A person allowing or denying a tool call before it runs, or Sugabots allowing it automatically when its tool access is **Allow**. | confirmation, consent, sign-off, reject, permission (what the core checks) |
| **Queued message** | A message waiting for a busy bot to finish its turn. | pending message, backlog |
| **Activity** | The steps and tool calls shown while a turn works. | trace, log, progress |
| **Resolved** | A chat someone has marked finished. It leaves the list but is kept, and can be reopened. | done, archived, closed |
| **Working** | A chat with a turn queued or in progress. | running, busy |
| **Attachment** | A file added to a message, within the size and count limits. Once sent it is one of the chat's files. | upload (as a noun), enclosure |
| **Reply** | A message that answers another message. | response, answer |
| **Author** | The person, bot or automation that wrote a message. | sender, poster |
| **Group mention** | `@here` or `@channel` in a message: it notifies everyone who can see the chat, and never gives a bot a turn. No bot may take either as its handle. | @everyone, @all, broadcast |
| **Participant** | A person or bot who has taken part in a chat. Participants are notified about it; it is not the same as being a project member. | member (of a chat), collaborator |
| **Approver** | The person who may answer an approval, by the first rule that fits: for a Personal Assistant's call, or one in a turn or run it started, only its person; for a request to change a computer, such as a host request, those who may manage its project, whose decision makes the change; for an automation's run, admins and the managers of its bot, among those who reach the run's chat; otherwise, the turn's asker. A bot never decides an approval. | decider, reviewer |
| **Sidebar** | The list on the left: the Personal Assistant first, then pinned bots and projects. | left rail, nav, menu |
| **Details panel** | The panel beside a chat showing its people, files and activity. | details sidebar, info panel, inspector |
| **Side panel** | The column beside a chat showing its details panel, a nested chat or an automation. | sidebar (the list on the left) |
| **Chat title** | A chat's name, taken from the message that started it; it can be renamed. | subject, topic name |
| **Chat kind** | Which kind a chat is: a project chat, an automation feed, a collaboration, a run or a system chat. | chat type |
| **System chat** | A system bot's chat, where it works for another chat. | — |
| **Root chat** | The chat people opened that a collaboration or run hangs under. | — |
| **Served chat** | The chat a system chat works for. | — |
| **Nested chat** | A collaboration's or run's chat, opened beside its root chat. | item, sub-chat |
| **Chat location** | Where a chat is listed: under a project people made, or under a bot (its default project). | — |
| **Read state** | How far a person has read a chat; any message after it is **unread**. | seen, read receipt |
| **Chat status** | How a chat stands in a list: **Working**, **Waiting** (on an approval) or **Replied** (a bot's reply the person hasn't read). | activity (the steps shown while a turn works) |
| **Writing** | A message's state while its bot is still writing it. | streaming (the token stream) |
| **Attention count** | The approvals waiting on a person and the unread messages that mention them from the last 30 days; the app's badge shows it. | inbox count |
| **Attention mark** | A dot or count beside a project or bot in the sidebar: unread mentions or approvals waiting on the person. | marker, badge (the app's badge shows the attention count) |
| **Approvals page** | Every approval in the workspace waiting on the person, and those lately answered. | approval inbox |

## A project's resources

A bot's resources are its default project's.

| Term | Meaning | Banned synonyms |
|---|---|---|
| **File** | A file in a chat. It is either an **attachment**, which a person added to a message and which stays as it was sent, or one a bot made, such as a document or an HTML page, which belongs to the project and keeps every version. A project's **Files** are those from its chats, so a bot's are those from its own chats. A collaboration's files are filed under the chat it was opened from. | asset, blob (outside the blob store) |
| **Computer** | A machine a project's bots work on: run commands, keep files, use a desktop. A bot working in a project's chat uses the project's computer once its **computer use** is on. An **online computer** runs at the workspace's computer provider and **sleeps** when idle; a **personal computer** (with the desktop app) is a person's own machine they let a bot use. | VM, container, box, environment, server (a Sugabots installation) |
| **Computer provider** | The service the workspace's computers run at. | cloud, backend, host (an allowed host is an address) |
| **Allowed host** | An internet address a computer may reach, set for the workspace or for one project. | whitelist, allowed domain, allowed site |
| **Blocked host** | An address no computer may reach. | blacklist, denylist, blocked domain |
| **Connector** | A service a project is connected to: an MCP server or an HTTP endpoint, signed in with a key or OAuth, or its GitHub app. Belongs to one project. A bot working in a project's chat uses the project's connectors and its own. | connection, integration, plugin, extension, app (a GitHub app is one kind) |
| **Built-in connector** | A hosted MCP server Sugabots ships settings for, which a project connects in one step. | preset, catalog entry, app directory, marketplace |
| **GitHub app** | A project's own GitHub App, made for it and installed on a GitHub account or organisation. Each project, so each bot, has at most one. | GitHub integration, GitHub bot |
| **Repository** | A GitHub repository a project works on, picked from what its GitHub app's installation can reach. | repo (in the product) |
| **Automation** | Work a project's lead bot does on its own, with instructions, started by its routines and triggers, in a chat of the project, on its computer. | workflow (the workflow engine's word), job, cron job |
| **Routine** | When an automation runs on a timetable, such as every weekday at 9, in the workspace's time zone. | cron, timer, recurrence |
| **Trigger** | An event that starts an automation: a **webhook** call or a **GitHub** event. An automation may have several routines and triggers. | hook (alone), listener, event |
| **Automation feed** | Where an automation posts and lists its runs, in its project. Anyone in the project may answer there, and the lead bot replies. | log, history, output |
| **Run** | One time an automation ran, with its own chat. | job, invocation, instance |
| **Usage** | What the workspace spent on models, by model and by bot. | billing, credits, consumption |
| **Cost** | What one model request cost, in US dollars: the figure the model provider reports, or else an estimate from its model's price. A local model provider's or a subscription sign-in's requests cost nothing. Usage adds these up. | price, spend, charge, bill, estimated cost |
| **Search provider** | The service web search runs through. | search engine, search backend |
| **Tool access** | Whether a connector's tool may run: **Allow** (it runs), **Ask** (it waits for approval) or **Off** (bots can't use it). | tool permission, tool policy |
| **Credential** | The **secret** a connector or provider signs in with: a key or an OAuth sign-in. | token |
| **Secret** | A value Sugabots stores encrypted for one stated use, such as a credential or a webhook secret, which opens only for that same use, so one can't be passed off as another. | seal, sealed value, encrypted value, vault |
| **Computer disk** | A computer's storage, kept while it sleeps, which can be cleared. | volume, storage |
| **Computer image** | What a new computer is built from. | template, snapshot |
| **Desktop viewer** | Where a person watches or uses a computer's desktop. | VNC, screen share, remote view |
| **Webhook** | A URL that starts an automation when it is called. | hook (alone), callback, endpoint |
| **Webhook secret** | How a webhook's caller proves itself: a webhook source's own signature, an HMAC signature, a bearer token, basic auth, an API-key header, or none, which lets anyone with the address start a run. | token, key (a connector's) |
| **Webhook filter** | Tests on a webhook call's body that must all pass before a run starts. | condition, rule, match |
| **Paused** | An automation switched off, by a person or by itself after two failed runs in a row: its routines and triggers start no runs until it is resumed. | disabled, inactive, suspended, asleep |
| **Manual run** | A run someone started by hand, outside the automation's routines and triggers. | run now, ad-hoc run, test run |
| **Unknown cost** | A model request's cost when its model's price isn't known: the request is counted, but adds nothing to usage. | unpriced request, free request, no price |
| **Webhook source** | The known sender a webhook is set up for (GitHub, Stripe, Slack or Linear), whose own signature it checks; or generic. | sender, integration |
| **Connector augmentation** | Tools Sugabots adds to a connector whose server leaves something undone, such as Linear's, which can't send a file. They are listed, given tool access and approved like the server's own, under the connector's name. | extension, plugin, shim |
| **File version** | A numbered copy kept each time a bot writes or edits a file. Deleting the file deletes every version. | revision, snapshot |
| **Trusted host** | A host every computer may reach whatever the settings, such as code hosts and package registries. | default host, built-in allowlist |
| **Network mode** | Whether computers reach every host except blocked ones (**open**, the default), or only trusted and allowed hosts (**allowed hosts only**). | allowlist mode, firewall |
| **Host request** | A bot asking, in its chat, for its project's computer to reach another host. It waits for someone who manages the computer; a blocked host is refused at once. | network access request, allowlist request |
| **Home folder** | A bot's own folder on its project's computer, for its tools, settings and caches, kept across its chats. | home directory |
| **Chat folder** | Each chat's own folder on its project's computer, where bots clone, install and build. | working directory, workdir, scratch |
| **Computer reset** | Starting a computer afresh. Waits while a turn is using it. | rebuild, recreate, wipe |
| **Computer upgrade** | Moving a computer's chat folders onto a new computer built from the current computer image. Installed programs and anything running are lost. | migrate, refresh, update |
| **Computer lease** | A turn using a computer, or a person watching its desktop, which keeps it awake. Only a turn's lease holds off a computer reset, upgrade or disk clearing; a lease left behind expires. | lock, keepalive, hold |
| **Computer size** | The CPUs and memory each computer gets, set for each computer provider. | spec, plan |
| **Computer sign-in** | What a project's computer is signed in to, such as its repositories. The computer provider adds the credentials outside the computer, so it holds only placeholders. | injected credentials, git credentials |
| **Computer take over** | A person moving from watching a computer's desktop to controlling it. | remote control, drive, take control |
| **Computer hand back** | A person giving control of a computer's desktop back to the bot. | release, give back |
| **Web access** | The workspace switch that lets bots read web pages and search the web. | internet access, browsing |
| **Connector test** | Trying a connector's settings, and recording whether it answered for exactly those settings. | health check, ping, probe, verify |
| **Provider access** | Where a model, search or computer provider is and the credential it signs in with. | connection (a connector's) |
| **Provider test** | Trying a provider's settings, and recording whether it answered. | health check, ping, probe |
| **Asleep** | An online computer's state while it sleeps. | — |
| **Filter test** | One test in a webhook filter. | condition |
| **Mark** | The logo a connector, webhook source or service is drawn with. | look, icon |

## Architecture

Words for how Sugabots is built, which [ARCHITECTURE.md](https://github.com/nitrictech/sugabots-architecture-docs/blob/main/ARCHITECTURE.md) explains.

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Entrypoint** | A way into the core: the **HTTP API** (which the web app, the SDK and the desktop viewer use), the **event stream**, **webhooks**, the **scheduler** and the **bot loop**. An entrypoint authenticates through an authenticator, decodes input with an operation's schema, calls the operation and encodes the result. It decides nothing about who may do what. | entry point, adapter, handler, door |
| **Scheduler** | The entrypoint for work that falls due: routines, and upkeep such as putting an idle computer to sleep. Nothing comes in through it; it authenticates the work it starts from stored ids. | cron (a routine's word), job runner, worker |
| **Bot loop** | The entrypoint bots work through, in turns, automation runs and system bots' work. It runs a turn: calls the bot's model, offers it the operations exposed to it as tools, and calls each tool the model picks as an operation for the turn's principal. | agent loop, agent runtime, runner, harness, executor |
| **Principal** | Who an operation acts for, as an entrypoint authenticated them: a person signed in, a bot acting for its asker, an automation's run, a webhook, or work Sugabots does on its own (a system bot's, or upkeep). Operations take it as an argument. | actor, caller, user, identity |
| **Authenticator** | The code in core that checks what came in through an entrypoint (a session's cookie or token, a webhook's signature, or the stored ids of a turn, a run or a piece of system work) and builds its principal. Nothing else builds one. | auth middleware, identity provider, session check |
| **Asker** | The person a turn acts for: whoever wrote the message it answers. When a bot wrote it, as the asking bot's question in a collaboration or a brief that starts a chat, the asker carries over from the turn that wrote it; a Personal Assistant's automations' runs act for its person. A turn acts for its asker: its tools have no more access than the asker and the bot both have, only the asker may steer it, and anyone else's message gets a turn of its own. Other automations' runs have no asker. | requester, initiator, user |
| **Operation** | One thing a principal can do, such as `chats.setResolved`, defined once in the **operation registry** with a name, a description, input and output schemas, its errors and its body. Every entrypoint calls the same one. | use case, action, command, mutation, endpoint (an HTTP route) |
| **Exposure manifest** | Each operation's explicit decision for the HTTP API and for the bot loop: offered, or held back with a reason; for the bot loop, also covered by a named tool that does the same, or called by the loop itself and offered to no model. For a tool, it also says when a bot's call needs approval: never, always, or by its tool access. | publication list, tool registry |
| **Service** | An Effect `Context.Service` in core that does the work and the IO. Services demand proofs. A **store** is the service that owns one **aggregate**'s rows. | manager, helper, DAO, util |
| **Permission** | Something the core checks before an operation goes ahead, such as `project.manage` (managing a project: its owner and admins may, or in a bot's default project, the bot's creator and admins, or a Personal Assistant's person). A bot has no role: acting for its asker, it has the asker's permissions in what both of them reach, in its chat's project and its own default project; in an automation's run, it may do what it reaches in the automation's project, but manage nothing there; a Personal Assistant's runs act for its person. | scope, capability, right, privilege |
| **Reach** | Whether someone can see a project, bot or chat at all. A project is reached by its members, a bot by whoever can talk to it, and a bot's default project through its bot. | access (for this meaning) |
| **Proof** | An opaque, frozen value recording that a fact was checked about specific named values, such as `ReachesProject<P, J>`, which services demand as an argument. Made only in `core/src/proofs/`, readable only while the operation that named its values runs, and never stored. | standing, token, guard, witness, evidence, assertion |
| **Prover** | The one function in `core/src/proofs/` that checks one fact and returns its proof, or fails with a typed error. | checker, guard, policy, authorizer |
| **Named value** | An id given a name only the type checker sees, by `named(...)`, so proofs can be about that exact value. Readable only while the operation that named it runs. | branded value (brands are a different thing) |
| **Hidden** | The refusal for something the principal can't reach, whatever they asked, so an id can't be probed for. | — |
| **Forbidden** | The refusal for something the principal reaches but may not act on. | unauthorised, 403 |
| **Tier** | How long something lives once built: **process** (once, at boot), **workspace** (kept empty: the workspace is passed to each call) or **request** (one operation call: an HTTP request, a tool call or one of the bot loop's own calls, a webhook call, or a piece of work the scheduler starts; streams prove again as they go). A longer-lived thing may not depend on a shorter-lived one. | scope, lifetime, level, layer |
| **Lane** | A key that runs one workflow at a time, such as one bot in one chat. What arrives while it's busy joins a waiting one it belongs with, replaces one, or queues. | queue, mutex, slot |
| **Step** | One model request and the tool calls it makes. A turn is made of steps; the tools and settings offered stay fixed for a step. | iteration, round, cycle, turn (a turn is the whole reply) |
| **Turn input** | A steer or an interrupt recorded for a running turn. A steer is read at its next step; an interrupt is also signalled to the process running the step, which stops it at once. | — |
| **Steer** | A message from the asker that reaches a running turn and is read before its next step, or in one more step if it arrives after the last. One that arrives while the turn waits for approval withdraws the approval. Anyone else's message waits for a turn of its own. | nudge, inject, follow-up |
| **Interrupt** | Ending a running turn partway through: the step under way stops, any approval it waits for is withdrawn, and the turn ends. Its asker may interrupt it, and so may anyone who may manage its project. Interrupting a turn interrupts its helpers' turns. | stop, cancel, abort, halt, kill |
| **Step text** | The words one step wrote; a message's text is its steps' text joined. | — |
| **Thinking** | What a model works through before it replies, kept with its step. Anyone who can read the chat can see a bot's thinking. | reasoning (except in a model provider's API), chain of thought, thoughts |
| **Event** | A recorded change, written to the **event outbox** in the same transaction as the change, then sent to the event stream. | update, change, signal, broadcast |
| **Ledger** | The record of every model request and its cost, which usage is read from. | log, meter |
| **Token stream** | A reply reaching clients as it is written, in batches of ephemeral events. Each step's full text is stored. | streaming, live typing |
| **Checkpoint** | What a turn keeps so it can resume after waiting or a restart, its thinking included. | snapshot, save state |
| **Event stream** | The entrypoint that pushes events to clients as they happen, over server-sent events. | event bus (in the product), realtime, websocket |
| **Store** | The service that owns one aggregate's rows: the only one that reads and writes them. | DAO, table |
| **Aggregate** | Rows a store owns and changes together. | entity, table |
| **Egress** | The server's own requests out to the internet, to model providers, connectors and web pages, under its rules for private addresses. A computer's traffic is governed by its **network mode** instead. | outbound, network access |
| **Blob store** | Where file contents are kept. | bucket, storage, S3 |
| **Model request** | One call to a model provider. A step makes one; usage and the ledger count them. | model call, completion, inference |
| **Dialect** | One model provider's variation on the API it speaks. | flavour, adapter, format |
| **Changes** (an operation's) | Whether an operation changes anything; a Personal Assistant asks before calling one that does. | mutating, mutates |
| **Write/delete tool call** | A tool call that may change or delete something outside Sugabots: any not marked read-only. A turn that fails after one is not retried, and people are told to check what it did. | mutating tool call, side effect, destructive call |
| **Long tool result** | A tool result too long to give the model whole. It is kept as a file in the chat, and the model gets its start and a way to read the rest. | overflow, spill file, truncated output |
| **Stream** | One event stream a client follows: a workspace's, a chat's or a person's own. | channel, topic, room |
| **Stream audience** | Who may hear an event on a workspace's stream: those who reach its chat (a collaboration's, through the chat it was opened from), or for an event about no chat, its project. | subscribers, listeners |
| **Retry** | A failed turn starting again by itself, up to a limit, unless it made a write/delete tool call. | rerun, restart |
| **Request purpose** | What a model request was made for: a bot's turn, compaction, a model test or a connector test. It decides whose usage the request counts as: background work is never charged to a bot. | activity, reason, kind |

## Errors

| Term | Meaning | Banned synonyms |
|---|---|---|
| **Error** | An expected way an operation can go wrong, as one tagged error class that implements `DomainError`. | failure, exception, problem |
| **Defect** | A bug or something unexpected. Never a `DomainError`: logged in full, and shown only as a fixed message with a reference id. | crash, panic, internal error, unknown error |
| **User message** | The words people read, and bots read in the bot loop, written in our own words: what happened, what is safe, who can fix it, and a way on. | error text, display message, copy |
| **Log message** | Words for operators, which may quote other systems' text and ids. | debug message, details |
| **Display name** | A name people chose, such as a bot's or a project's, put into a user message. | label, title |
| **Public error** | The only shape an error takes when it leaves the core. | API error, wire error |
| **Reference id** | The id shown with a defect, which finds its full log entry. | error id, trace id, incident number |
| **Upstream error** | An error from a model provider, connector or computer provider. Its text goes in the log message; the user message is ours. | provider error, third-party error |
| **Refusal** | An expected error where the core says no, logged at Info. Hidden and Forbidden are refusals; an upstream error is not. | rejection |
| **Retryable** | Whether sending the same request again might work, and how long to wait if the other side said. | transient, recoverable |

## Retired terms

Words for things that no longer exist. Don't use them, even in comments explaining old behaviour.

| Term | Was | Now |
|---|---|---|
| **Pod** | A group of people and bots sharing a computer, connectors and access. | **Public** and **private** bots, and **projects**; resources belong to each **project**, a bot's to its default project. |
| **Personal pod** | A person's private pod. | Their **Personal Assistant** and **private** bots. |
| **Pod chat** | A pod's chat. | A project's **chats**. |
| **Bot channel** | A bot's own channel inside a pod. | The bot's **chats**. |
| **Crew** | The bots in a pod. | A project's bots. |
| **Channel** | A long-running space for many people and bots. | **Project**. |
| **Main chat**, **main thread** | A channel's or project's own chat, beside its other chats, which every project had and none could archive. | Gone: a project is made of its **chats**, any of which can be marked **resolved**. |
| **Task** (a chat with one bot) | A chat with one bot about one piece of work. | A bot's **chat**. |
| **Schedule** (an automation's) | When an automation runs on a timetable. | **Routine**. |
| **Artifact** | Something a bot made to keep. | A **file**. |
| **Document** (as a kind of thing) | What a bot makes. | A **file**; "document" only describes what a file contains. |
| **Sandbox** | A bot's machine. | **Computer**. |
| **Routine** (work a bot does on its own) | An automation as a whole. | **Automation**; a routine is now when an automation runs on a timetable. |
| **Agent** | A bot. | **Bot**. |
| **Summary**, **bot summary**, **Summariser** | A short account of one chat, or of what a bot had been doing across its chats, and the system bot that wrote them. | Gone. |
| **Scribe** | The system bot that wrote summaries, named as a character. | Gone, with summaries. |
| **Inbox** | What needed a person's attention: mentions, replies, finished work. | Gone: their **Personal Assistant** tells them what needs their attention. |
| **Direct message** | A chat between two or more people, with no bots, which only its people saw. | Gone: people talk in a project's **chats**, or with bots. |
| **Archive** (a chat) | Removing a chat from its list for good, by a manager. | Gone: a chat is **resolved**, and can be reopened. |

## Kept names

Every older name was renamed when its word was. Only migrations keep them.

| Name | Where | Why it is kept |
|---|---|---|
| Migration names and SQL | `packages/core/drizzle/` | Migrations are history: each names the tables as they were when it ran. |

### The `chat` table

Messages, turns, tool calls, compactions, read state and files each belong to one chat, so they all point at one shared parent: a `chat` row holding only what every kind has (its workspace, kind, title and times). What makes each kind what it is lives in its own table: `project_chat` (its project, who started it, when it was resolved), `automation_feed` and `system_chat`, keyed by the chat's id, and `collaboration` and `run`, which have ids of their own and point at their chat. Say "chat" in code that works the same for every kind; otherwise name the kind.

### Spelling in identifiers

Identifiers spell colour `color`, as CSS and every library do. The avatars package calls the avatar it draws a "face".
