; ELviewer installer hooks (included by Tauri's NSIS template).
;
; Lists ELviewer under "Open with" for the formats it reads. Only the "Open with"
; list is touched: the default app of each type (Word, Hangul, the browser,
; Notepad...) stays as it is, and the user can pick ELviewer with "Always".
; Tauri's own `fileAssociations` would also take the default where no user
; choice is recorded, so it is not used.

!define ELV_PROGID "ELviewer.Document"

!macro ELV_EXTS _MACRO
  !insertmacro ${_MACRO} "txt"
  !insertmacro ${_MACRO} "md"
  !insertmacro ${_MACRO} "markdown"
  !insertmacro ${_MACRO} "html"
  !insertmacro ${_MACRO} "htm"
  !insertmacro ${_MACRO} "xhtml"
  !insertmacro ${_MACRO} "rtf"
  !insertmacro ${_MACRO} "docx"
  !insertmacro ${_MACRO} "hwp"
  !insertmacro ${_MACRO} "hwpx"
  !insertmacro ${_MACRO} "epub"
  !insertmacro ${_MACRO} "mobi"
  !insertmacro ${_MACRO} "azw"
  !insertmacro ${_MACRO} "azw3"
  !insertmacro ${_MACRO} "fb2"
  !insertmacro ${_MACRO} "cbz"
  !insertmacro ${_MACRO} "pdf"
!macroend

!macro ELV_ADD_EXT EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${ELV_PROGID}" ""
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities\FileAssociations" ".${EXT}" "${ELV_PROGID}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro ELV_REMOVE_EXT EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${ELV_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}" "" "ELviewer document"
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}" "FriendlyTypeName" "ELviewer document"
  ; The Windows 11 picker only lists a ProgID it can tie to an installed app: the
  ; same app ID Tauri gives the Start menu shortcut (the bundle identifier).
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}" "AppUserModelID" "${BUNDLEID}"
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}\shell\open" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe"'
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}\Application" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}\Application" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${ELV_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  ; Windows 10/11 build the "Open with" picker and Settings > Default apps from
  ; registered applications: without this ELviewer stays off the new picker.
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" "ApplicationDescription" "ELviewer novel and document reader"
  WriteRegStr SHCTX "Software\${PRODUCTNAME}\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "Software\${PRODUCTNAME}\Capabilities"
  !insertmacro ELV_EXTS ELV_ADD_EXT
  ; SHCNE_ASSOCCHANGED: Explorer re-reads the lists without a restart.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ELV_EXTS ELV_REMOVE_EXT
  DeleteRegKey SHCTX "Software\Classes\${ELV_PROGID}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "Software\${PRODUCTNAME}\Capabilities"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
