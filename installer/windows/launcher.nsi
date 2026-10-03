; Start-menu stub: a GUI-subsystem exe (no console flash) that runs the
; bundled node on launch.mjs, which holds all launcher logic. It only knows
; two paths relative to itself. On failure it shows launch.mjs's one-line
; error. Built by build.mjs: makensis -DOUTFILE=<path> launcher.nsi
Unicode true
Name "code-conductor"
OutFile "${OUTFILE}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow

Section
  nsExec::ExecToStack '"$EXEDIR\node\node.exe" "$EXEDIR\app\installer\windows\launch.mjs"'
  Pop $0
  Pop $1
  StrCmp $0 "0" done
  MessageBox MB_ICONSTOP|MB_OK "code-conductor could not start.$\r$\n$\r$\n$1"
  done:
SectionEnd
