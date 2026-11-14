; Vellora Native — per-user preview installer.
;
; Deliberately independent from the legacy Tauri installation:
;   * own product name and install directory (%LOCALAPPDATA%\Programs\VelloraNative)
;   * no .md file association, so the legacy app keeps the user's default handler
;   * no machine-wide changes, no admin rights (RequestExecutionLevel user)
;
; Build:  makensis /DAPP_VERSION=0.1.0 vellora-native.nsi

Unicode true
ManifestDPIAware true

!ifndef APP_VERSION
  !define APP_VERSION "0.1.0"
!endif
!ifndef SOURCE_EXE
  !define SOURCE_EXE "..\target\release\vellora-native.exe"
!endif
!ifndef OUT_DIR
  !define OUT_DIR "out"
!endif

!define APP_NAME "Vellora Native"
!define APP_DISPLAY "Vellora Native (Preview)"
!define APP_PUBLISHER "Vellora Contributors"
!define APP_REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VelloraNative"
!define APP_EXE "vellora-native.exe"

Name "${APP_DISPLAY}"
OutFile "${OUT_DIR}\VelloraNative-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\VelloraNative"
InstallDirRegKey HKCU "Software\VelloraNative" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
BrandingText "${APP_DISPLAY} ${APP_VERSION}"
Icon "assets\vellora.ico"
UninstallIcon "assets\vellora.ico"
XPStyle on
ShowInstDetails show
ShowUninstDetails show

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

Section "Vellora Native" SEC_MAIN
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "${SOURCE_EXE}"
  File "assets\README.txt"
  File "assets\LICENSE.txt"

  ; Shortcuts: Start menu for the current user, desktop opt-in.
  CreateDirectory "$SMPROGRAMS\Vellora Native"
  CreateShortCut "$SMPROGRAMS\Vellora Native\Vellora Native.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\Vellora Native\卸载 Vellora Native.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\Vellora Native.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "Software\VelloraNative" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\VelloraNative" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayName" "${APP_DISPLAY}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${APP_REGKEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "${APP_REGKEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${APP_REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${APP_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${APP_REGKEY}" "NoRepair" 1

  ; No file association is written: the legacy Vellora keeps the user's .md
  ; handler until the switch is explicitly approved.
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\Vellora Native\Vellora Native.lnk"
  Delete "$SMPROGRAMS\Vellora Native\卸载 Vellora Native.lnk"
  RMDir "$SMPROGRAMS\Vellora Native"
  Delete "$DESKTOP\Vellora Native.lnk"

  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${APP_REGKEY}"
  DeleteRegKey HKCU "Software\VelloraNative"
SectionEnd
