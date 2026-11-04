#!/bin/sh
# Builds the app's Swift copies of the web's rules into a Mac program with
# RuleChecks/main.swift, and runs the web's shared cases against them. Each file
# compiled here imports only Foundation, so it runs off the simulator.
set -eu
app="$(cd "$(dirname "$0")/.." && pwd)"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cd "$app/Sugabots"
xcrun swiftc -enable-bare-slash-regex -o "$build/rule-checks" \
	API/API.generated.swift \
	API/APIClient.swift \
	API/APISupport.swift \
	API/Limits.generated.swift \
	API/TokenStore.swift \
	API/RoutineModels.swift \
	API/Models.swift \
	Conversation/BuiltInTools.generated.swift \
	Conversation/Names.swift \
	Conversation/Times.swift \
	Conversation/ToolNames.swift \
	Conversation/ToolSteps.swift \
	Conversation/Previews.swift \
	Conversation/Mentions.swift \
	Conversation/Segments.swift \
	Conversation/ChatGroups.swift \
	Conversation/FileLook.swift \
	Conversation/MarkdownBlocks.swift \
	Design/Avatars.swift \
	Home/Mutes.swift \
	Settings/TimeZoneChoices.swift \
	Routines/ScheduleWords.swift \
	"$app/RuleChecks/main.swift"
"$build/rule-checks" "$app/../../packages/contracts/cases"
