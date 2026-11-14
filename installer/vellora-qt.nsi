; Vellora (Qt) — per-user installer.
;
; Ships the Qt runtime next to the executable (windeployqt output) so the app
; needs nothing installed. Still no .md association: the legacy Vellora keeps the
; user's default handler until the switch is approved.

Unicode true
ManifestDPIAware true

!ifndef APP_VERSION
  !define APP_VERSION "0.2.0"
!endif
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\qt-app\dist"
!endif
!ifndef OUT_DIR
  !define OUT_DIR "out"
!endif

!define APP_DISPLAY "Vellora (Qt Preview)"
!define APP_PUBLISHER "Vellora Contributors"
!define APP_EXE "vellora.exe"
!define APP_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VelloraQt"

Name "${APP_DISPLAY}"
OutFile "${OUT_DIR}\VelloraQt-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\VelloraQt"
InstallDirRegKey HKCU "Software\VelloraQt" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP_DISPLAY} ${APP_VERSION}"
Icon "assets\vellora.ico"
UninstallIcon "assets\vellora.ico"
XPStyle on

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_DISPLAY}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${APP_DISPLAY} Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright" "MIT License"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_ICON "assets\vellora.ico"
!define MUI_UNICON "assets\vellora.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APP_DISPLAY}"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\README.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看使用说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "assets\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Vellora" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${SOURCE_DIR}\*.*"
  File "assets\README-QT.txt"

  CreateDirectory "$SMPROGRAMS\Vellora Qt"
  CreateShortCut "$SMPROGRAMS\Vellora Qt\Vellora.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\Vellora Qt\卸载 Vellora.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\Vellora (Qt).lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\VelloraQt" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\VelloraQt" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayName" "${APP_DISPLAY}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_REGKEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${APP_REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${APP_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Vellora Qt\Vellora.lnk"
  Delete "$SMPROGRAMS\Vellora Qt\卸载 Vellora.lnk"
  RMDir "$SMPROGRAMS\Vellora Qt"
  Delete "$DESKTOP\Vellora (Qt).lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${APP_REGKEY}"
  DeleteRegKey HKCU "Software\VelloraQt"
SectionEnd
