; Per-user installer + uninstaller. Built by build.mjs, which passes
; -DVERSION -DCOMMIT -DBRANCH -DREMOTE_URL -DSTAGE -DOUTFILE.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\code-conductor"

Name "code-conductor"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\code-conductor"
SetCompressor /SOLID lzma
ShowInstDetails show

!define MUI_FINISHPAGE_RUN "$INSTDIR\code-conductor.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch code-conductor"
!define MUI_FINISHPAGE_TEXT "code-conductor is installed.$\r$\n$\r$\nIf you have not signed in to Claude yet, run $\"claude auth login$\" once in a terminal."

!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Stops a running server (found through its health endpoint) after asking.
!macro StopRunning PREFIX
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
  ${AndIf} ${FileExists} "$INSTDIR\app\installer\windows\launch.mjs"
    nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\installer\windows\launch.mjs" --status'
    Pop $0
    ${If} $0 == 0
      MessageBox MB_YESNO|MB_ICONQUESTION "code-conductor is running and must be stopped first. Stop it now?" /SD IDYES IDYES ${PREFIX}stop
      Abort
      ${PREFIX}stop:
      nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\installer\windows\launch.mjs" --stop'
      Pop $0
      ${If} $0 != 0
        Abort "Could not stop the running code-conductor."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Section "Install"
  SetShellVarContext current
  !insertmacro StopRunning "i"

  RMDir /r "$INSTDIR\node"
  SetOutPath "$INSTDIR\node"
  File /r "${STAGE}\node\*.*"

  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${STAGE}\cc.bundle"
  File "${STAGE}\installer\windows\setup.mjs"
  File "${STAGE}\installer\windows\toolchain.mjs"
  File "${STAGE}\installer\windows\pins.json"
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$PLUGINSDIR\setup.mjs" --install-dir "$INSTDIR" --bundle "$PLUGINSDIR\cc.bundle" --branch "${BRANCH}" --remote "${REMOTE_URL}"'
  Pop $0
  ${If} $0 != 0
    Abort "Setup failed (exit $0). See $INSTDIR\logs\setup.log"
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${STAGE}\code-conductor.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "code-conductor"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}+${COMMIT}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "UnmanagedCode"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\code-conductor.exe"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" $0

  CreateShortcut "$SMPROGRAMS\code-conductor.lnk" "$INSTDIR\code-conductor.exe"

  ; the user PATH may have changed (claude's dir)
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

; Keeps the projects root and its store, Git, claude and the PATH entry.
Section "Uninstall"
  SetShellVarContext current
  !insertmacro StopRunning "u"
  Delete "$SMPROGRAMS\code-conductor.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
