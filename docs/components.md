# Components

The per-module catalogue: one row per module or topic, each linking to its entry under `docs/components/`.

## [instances.md](components/instances.md) — instances, idle wake and session renewal

- [`server.ts`](components/instances.md#serverts)
- [`src/securityHeaders.ts`](components/instances.md#srcsecurityheadersts)
- [`src/upgradeOrigin.ts`](components/instances.md#srcupgradeorigints)
- [`src/pluginTheme.ts`](components/instances.md#srcpluginthemets)
- [`src/instances.ts`](components/instances.md#srcinstancests)
- [`src/idleSubscriptions.ts`](components/instances.md#srcidlesubscriptionsts)
- [`src/overageResume.ts`](components/instances.md#srcoverageresumets)
- [`src/usageWindowDomains.ts`](components/instances.md#srcusagewindowdomainsts)
- [`src/usageOverageMonitor.ts`](components/instances.md#srcusageoveragemonitorts)
- [`src/sessionLineage.ts`](components/instances.md#srcsessionlineagets)
- [`src/sessionRenew.ts`](components/instances.md#srcsessionrenewts)
- [Overage trip detection + central routing](components/instances.md#overage-trip-detection--central-routing)

## [sessions.md](components/sessions.md) — hooks, transcripts, session edits and usage

- [`src/hookBroker.ts`](components/sessions.md#srchookbrokerts)
- [`src/hookContext.ts`](components/sessions.md#srchookcontextts)
- [`src/toolResultNudges.ts`](components/sessions.md#srctoolresultnudgests)
- [`src/conductorReadNudge.ts`](components/sessions.md#srcconductorreadnudgets)
- [`src/taskNotification.ts`](components/sessions.md#srctasknotificationts)
- [`src/settings.ts`](components/sessions.md#srcsettingsts)
- [`src/coreClaudePlugin.ts`](components/sessions.md#srccoreclaudeplugints)
- [`src/transcript.ts`](components/sessions.md#srctranscriptts)
- [`src/planFile.ts`](components/sessions.md#srcplanfilets)
- [`src/eventArchive.ts`](components/sessions.md#srceventarchivets)
- [`src/lineagePager.ts`](components/sessions.md#srclineagepagerts)
- [`src/retiredPagers.ts`](components/sessions.md#srcretiredpagersts)
- [`src/taskReconstruct.ts`](components/sessions.md#srctaskreconstructts)
- [src/instances.ts `Instance.reconstructActiveTasks(beforeSeq)`](components/sessions.md#srcinstancests-instancereconstructactivetasksbeforeseq)
- [`src/renewalBoundary.ts`](components/sessions.md#srcrenewalboundaryts)
- [`src/sessionEdit.ts`](components/sessions.md#srcsessioneditts)
- [`src/sessionPrune.ts`](components/sessions.md#srcsessionprunets)
- [`src/imageCost.ts`](components/sessions.md#srcimagecostts)
- [`src/narration.ts`](components/sessions.md#srcnarrationts)
- [`src/idleRenewNudge.ts`](components/sessions.md#srcidlerenewnudgets)
- [`src/promptAuthor.ts`](components/sessions.md#srcpromptauthorts)
- [`src/parser.ts`](components/sessions.md#srcparserts)
- [`src/callUsage.ts`](components/sessions.md#srccallusagets)

## [systems.md](components/systems.md) — the System seam

- [`src/systems/`](components/systems.md#srcsystems)
- [Terminals — `System.openTerminal` (`src/systems/terminal.ts`, `src/systems/ptyHost.ts`, `src/systems/ptyHelper.py`)](components/systems.md#terminals--systemopenterminal-srcsystemsterminalts-srcsystemsptyhostts-srcsystemsptyhelperpy)
- [The System modules](components/systems.md#the-system-modules)

## [fuse.md](components/fuse.md) — the FUSE-union chroot (cc side)

- [`src/systems/fuse/`](components/fuse.md#srcsystemsfuse)
- [What `fileBridge` carried, and where it has to land again](components/fuse.md#what-filebridge-carried-and-where-it-has-to-land-again)
- [FUSE teardown](components/fuse.md#fuse-teardown)

## [fuse-daemon.md](components/fuse-daemon.md) — the FUSE daemon

- [`union.c` + `policy.h`](components/fuse-daemon.md#unionc--policyh)

## [store.md](components/store.md) — project and session stores, conventions

- [`src/claudeConfigDir.ts`](components/store.md#srcclaudeconfigdirts)
- [`src/projects.ts`](components/store.md#srcprojectsts)
- [`src/awaitingUser.ts`](components/store.md#srcawaitinguserts)
- [`src/questionAnswerStamp.ts`](components/store.md#srcquestionanswerstampts)
- [`src/awaitingUserTranscript.ts`](components/store.md#srcawaitingusertranscriptts)
- [`src/sessionActivity.ts`](components/store.md#srcsessionactivityts)
- [`src/sessionStore.ts`](components/store.md#srcsessionstorets)
- [`src/pristine.ts`](components/store.md#srcpristinets)
- [`src/sessionCleanup.ts`](components/store.md#srcsessioncleanupts)
- [`src/conductorSpawns.ts`](components/store.md#srcconductorspawnsts)
- [`src/conduct.ts`](components/store.md#srcconductts)
- [`src/conductorConventions.ts`](components/store.md#srcconductorconventionsts)
- [`src/conventionSelection.ts`](components/store.md#srcconventionselectionts)
- [`shared/skillPart.ts`](components/store.md#sharedskillpartts)
- [`src/conventionSkills.ts`](components/store.md#srcconventionskillsts)
- [`src/conventionsDir.ts`](components/store.md#srcconventionsdirts)
- [`src/fragmentCatalog.ts`](components/store.md#srcfragmentcatalogts)
- [`src/identifiers.ts`](components/store.md#srcidentifiersts)
- [`src/codeMode/`](components/store.md#srccodemode)
- [`src/mcp/argValidation.ts`](components/store.md#srcmcpargvalidationts)
- [`src/mcp/jsonSchemaSubset.ts`](components/store.md#srcmcpjsonschemasubsetts)
- [`src/sessionOneShot.ts`](components/store.md#srcsessiononeshotts)

## [platform.md](components/platform.md) — the host-OS seam and shared helpers

- [`src/platform/`](components/platform.md#srcplatform)
- [`src/platform/win32.ts`](components/platform.md#srcplatformwin32ts)
- [Stopping the CLI without `softSigterm`](components/platform.md#stopping-the-cli-without-softsigterm)
- [Platform capabilities](components/platform.md#platform-capabilities)
- [`src/groupedCommand.ts`](components/platform.md#srcgroupedcommandts)
- [`src/httpError.ts`](components/platform.md#srchttperrorts)
- [`src/env.ts`](components/platform.md#srcenvts)
- [`src/duration.ts`](components/platform.md#srcdurationts)
- [`src/backgroundJobs.ts`](components/platform.md#srcbackgroundjobsts)
- [`web/src/features/dialogs/PathInput.tsx`](components/platform.md#websrcfeaturesdialogspathinputtsx)
- [`shared/uiEvent.ts`](components/platform.md#shareduieventts)
- [`shared/userQuestionAnswers.ts`](components/platform.md#shareduserquestionanswersts)
- [`shared/toolName.ts`](components/platform.md#sharedtoolnamets)
- [`shared/wakeCallback.ts`](components/platform.md#sharedwakecallbackts)
- [`shared/idleRenewNudge.ts`](components/platform.md#sharedidlerenewnudgets)
- [`shared/renewSeed.ts`](components/platform.md#sharedrenewseedts)
- [`shared/forwardFrame.ts`](components/platform.md#sharedforwardframets)
- [`shared/promptPreview.ts`](components/platform.md#sharedpromptpreviewts)
- [`shared/injectedTurns.ts`](components/platform.md#sharedinjectedturnsts)
- [`shared/planApproval.ts`](components/platform.md#sharedplanapprovalts)
- [`shared/promptOrigin.ts`](components/platform.md#sharedpromptorigints)
- [`web/src/features/session/SessionWidthHandles.tsx`](components/platform.md#websrcfeaturessessionsessionwidthhandlestsx)
- [`web/src/features/session/promptFocus.ts`](components/platform.md#websrcfeaturessessionpromptfocusts)
- [`web/src/app/viewport.ts`](components/platform.md#websrcappviewportts)

## [plugin-host.md](components/plugin-host.md) — the plugin host

- [`src/plugins/`](components/plugin-host.md#srcplugins)

## [restart.md](components/restart.md) — routes, restart and resume, git and services

- [`src/routes.ts`](components/restart.md#srcroutests)
- [`src/restartSupervisor.ts`](components/restart.md#srcrestartsupervisorts)
- [`src/restart.ts`](components/restart.md#srcrestartts)
- [`src/gitLive.ts`](components/restart.md#srcgitlivets)
- [`src/depsDrift.ts`](components/restart.md#srcdepsdriftts)
- [`src/relaunchPrep.ts`](components/restart.md#srcrelaunchprepts)
- [`src/selfUpdate.ts`](components/restart.md#srcselfupdatets)
- [`src/claudeUpdate.ts`](components/restart.md#srcclaudeupdatets)
- [`src/ndjsonAction.ts`](components/restart.md#srcndjsonactionts)
- [`src/resumeManifest.ts`](components/restart.md#srcresumemanifestts)
- [`src/resumeRestart.ts`](components/restart.md#srcresumerestartts)
- [`src/runningRecord.ts`](components/restart.md#srcrunningrecordts)
- [`src/pendingContinue.ts`](components/restart.md#srcpendingcontinuets)
- [`src/resumeBoot.ts`](components/restart.md#srcresumebootts)
- [`src/waitFor.ts`](components/restart.md#srcwaitforts)
- [`src/worktrees.ts`](components/restart.md#srcworktreests)
- [`src/gitDiff.ts`](components/restart.md#srcgitdiffts)
- [`src/attachments.ts`](components/restart.md#srcattachmentsts)
- [`src/transcribe.ts`](components/restart.md#srctranscribets)
- [`src/appSettings.ts`](components/restart.md#srcappsettingsts)
- [`src/hostTarget.ts`](components/restart.md#srchosttargetts)
- [`src/hostTerminal.ts`](components/restart.md#srchostterminalts)
- [`src/hostExec.ts`](components/restart.md#srchostexects)
- [`src/dirListing.ts`](components/restart.md#srcdirlistingts)
- [`src/projectSuggestions.ts`](components/restart.md#srcprojectsuggestionsts)
- [`src/projectConventions.ts`](components/restart.md#srcprojectconventionsts)
- [`src/workspaceConventions.ts`](components/restart.md#srcworkspaceconventionsts)
- [`src/whisperModels.ts`](components/restart.md#srcwhispermodelsts)
- [`src/ollamaCloudModels.ts`](components/restart.md#srcollamacloudmodelsts)
- [`src/effortLevels.ts`](components/restart.md#srceffortlevelsts)
- [`src/modelVersions.ts`](components/restart.md#srcmodelversionsts)
- [`src/installRunner.ts`](components/restart.md#srcinstallrunnerts)
- [`src/whisperInstall.ts`](components/restart.md#srcwhisperinstallts)
- [`src/tts.ts`](components/restart.md#srcttsts)
- [`bin/piper-synth.py`](components/restart.md#binpiper-synthpy)
- [`src/ttsModels.ts`](components/restart.md#srcttsmodelsts)
- [`src/ttsInstall.ts`](components/restart.md#srcttsinstallts)
- [`src/keyedQueue.ts`](components/restart.md#srckeyedqueuets)
- [`src/logRotation.ts`](components/restart.md#srclogrotationts)

## [web.md](components/web.md) — project instructions, MCP, the web build and the web UI

- [`src/projectClaudeMd.ts`](components/web.md#srcprojectclaudemdts)
- [`src/conventionsCheckout.ts`](components/web.md#srcconventionscheckoutts)
- [`src/conventionsImport.ts`](components/web.md#srcconventionsimportts)
- [`src/wsHub.ts`](components/web.md#srcwshubts)
- [`src/accountUsage.ts`](components/web.md#srcaccountusagets)
- [`src/cacheEstimate.ts`](components/web.md#srccacheestimatets)
- [`src/costTracking.ts`](components/web.md#srccosttrackingts)
- [`src/projectsCache.ts`](components/web.md#srcprojectscachets)
- [`src/projectsChanged.ts`](components/web.md#srcprojectschangedts)
- [`src/health.ts`](components/web.md#srchealthts)
- [`src/claudeAuthStatus.ts`](components/web.md#srcclaudeauthstatusts)
- [`src/claudeLogin.ts`](components/web.md#srcclaudelogints)
- [`src/mcp/`](components/web.md#srcmcp)
- [`src/webBuild.ts`](components/web.md#srcwebbuildts)
- [`src/bootCommit.ts`](components/web.md#srcbootcommitts)
- [`src/webPostMerge.ts` + `src/webPostMergeMain.ts`](components/web.md#srcwebpostmergets--srcwebpostmergemaints)
- [`src/restartStatus.ts`](components/web.md#srcrestartstatusts)
- [`src/serverImports.ts`](components/web.md#srcserverimportsts)
- [`web/`](components/web.md#web)
- [Markdown rendering](components/web.md#markdown-rendering)
- [`shared/`](components/web.md#shared)
- [`tests/`](components/web.md#tests)
- [`harness/mutation/`](components/web.md#harnessmutation)
- [`harness/pluginDir.mjs`](components/web.md#harnessplugindirmjs)
- [`migrations/`](components/web.md#migrations)

## [headless.md](components/headless.md) — the projects-root lock and headless mode

- [The projects-root lock](components/headless.md#the-projects-root-lock)
- [Headless mode](components/headless.md#headless-mode) (modules include `src/headless/rootPolicy.ts`, the root's no-person policy)
- [Replay](components/headless.md#replay) — a pointer to headless-replay.md

## [headless-replay.md](components/headless-replay.md) — the `--replay` process

- [Replay](components/headless-replay.md#replay)
- [Replay under view](components/headless-replay.md#replay-under-view)
- [Replay under interact and full](components/headless-replay.md#replay-under-interact-and-full)
- [The run's HOME](components/headless-replay.md#the-runs-home)

## [playbooks.md](components/playbooks.md) — playbooks and convention skill parts

- [Playbooks](components/playbooks.md#playbooks)
- [Convention skill parts](components/playbooks.md#convention-skill-parts)
