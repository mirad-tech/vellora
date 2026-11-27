; Vellora per-user installer. Building this file never executes Setup.
Unicode true
ManifestDPIAware true
!ifndef APP_VERSION
  !define APP_VERSION "0.1.8"
!endif
!ifndef SOURCE_DIR
  !error "SOURCE_DIR is required"
!endif
!ifndef OUT_DIR
  !error "OUT_DIR is required"
!endif
!ifndef UNINSTALL_LIST
  !error "UNINSTALL_LIST is required"
!endif
!define INSTALLER_ID "Vellora.Windows.Standalone.v1"
!define INSTALL_KEY "Software\VelloraInstaller"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Vellora"
Name "Vellora"
OutFile "${OUT_DIR}\Vellora-Setup-${APP_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\Vellora"
RequestExecutionLevel user
SetCompressor /SOLID lzma
Icon "assets\vellora.ico"
UninstallIcon "assets\vellora.ico"
BrandingText "Vellora ${APP_VERSION}"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Vellora"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "Vellora Setup"
VIAddVersionKey "FileVersion" "${APP_VERSION}.0"
VIAddVersionKey "LegalCopyright" "Vellora Contributors; third-party licenses included"
!include "FileFunc.nsh"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!define ASSOC_PROGID "Vellora.Markdown"
!define ASSOC_CAPABILITIES "Software\Vellora\Capabilities"
Var AssociationDialog
Var AssociationCheckbox
Var AssociationSelected
Var AssociationRegistered
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "assets\LICENSE.txt"
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE VerifyDestination
!insertmacro MUI_PAGE_DIRECTORY
Page custom AssociationPageCreate AssociationPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
; English first: the default for every display language that is not Chinese.
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

; Chinese Windows display languages (Simplified or Traditional) get the Chinese
; setup, every other language English, without asking.
; /LANG=en or /LANG=zh on the command line overrides it (for testing).
!macro VELLORA_PICK_LANGUAGE UN
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0x3FF
  ${If} $0 = 0x04
    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  ${Else}
    StrCpy $LANGUAGE ${LANG_ENGLISH}
  ${EndIf}
  ${${UN}GetParameters} $1
  ClearErrors
  ${${UN}GetOptions} $1 "/LANG=" $2
  ${IfNot} ${Errors}
    ${If} $2 == "en"
      StrCpy $LANGUAGE ${LANG_ENGLISH}
    ${ElseIf} $2 == "zh"
      StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
    ${EndIf}
  ${EndIf}
!macroend

; The uninstall shortcut is named in the language setup ran in; both names are
; this installer's own.
!define UNINSTALL_LINK_ZH "卸载 Vellora.lnk"
!define UNINSTALL_LINK_EN "Uninstall Vellora.lnk"
LangString UninstallLink ${LANG_SIMPCHINESE} "${UNINSTALL_LINK_ZH}"
LangString UninstallLink ${LANG_ENGLISH} "${UNINSTALL_LINK_EN}"
LangString AssocTitle ${LANG_SIMPCHINESE} "Markdown 文件关联"
LangString AssocTitle ${LANG_ENGLISH} "Markdown File Association"
LangString AssocSubtitle ${LANG_SIMPCHINESE} "可选设置，不会直接覆盖现有默认应用。"
LangString AssocSubtitle ${LANG_ENGLISH} "Optional. Your current default app is not replaced."
LangString AssocCheckbox ${LANG_SIMPCHINESE} "将 Vellora 添加到 Markdown 打开方式，并打开默认应用设置"
LangString AssocCheckbox ${LANG_ENGLISH} "Add Vellora to Open with for Markdown files and open Default apps settings"
LangString AssocDetails ${LANG_SIMPCHINESE} "仅关联候选类型：.md 和 .markdown。$\r$\n$\r$\n勾选后，安装完成会打开 Windows 默认应用设置，由您选择是否将 Vellora 设为默认。安装器不会强行修改已有默认选择。$\r$\n$\r$\n不勾选：保持当前文件关联不变。"
LangString AssocDetails ${LANG_ENGLISH} "File types: .md and .markdown only.$\r$\n$\r$\nIf checked, Windows Default apps settings open after setup, so you can choose whether Vellora becomes the default. Setup never changes an existing default.$\r$\n$\r$\nIf unchecked, current file associations stay as they are."
LangString ProgIdName ${LANG_SIMPCHINESE} "Markdown 文档"
LangString ProgIdName ${LANG_ENGLISH} "Markdown Document"
LangString AppDescription ${LANG_SIMPCHINESE} "阅读和编辑 Markdown 文档"
LangString AppDescription ${LANG_ENGLISH} "Read and edit Markdown documents"
LangString AssocConflict ${LANG_SIMPCHINESE} "已存在其他位置的 Vellora 文件关联注册。为保留原有选择，本次未修改关联；您可稍后在 Windows 默认应用设置中处理。"
LangString AssocConflict ${LANG_ENGLISH} "Another Vellora installation already registered file associations. To keep your existing choice, they were not changed. You can manage them later in Windows Default apps settings."
LangString AssocFailed ${LANG_SIMPCHINESE} "Vellora 已安装，但文件关联候选注册未完全成功。当前默认应用未被修改；您可稍后在 Windows 设置中手动选择。"
LangString AssocFailed ${LANG_ENGLISH} "Vellora is installed, but registering it for Markdown files did not fully succeed. Your default app was not changed. You can choose it later in Windows Settings."
LangString SettingsManual ${LANG_SIMPCHINESE} "安装已完成。请手动打开 Windows 设置 → 应用 → 默认应用，为 .md 和 .markdown 选择 Vellora。"
LangString SettingsManual ${LANG_ENGLISH} "Setup is complete. To open .md and .markdown files with Vellora, go to Windows Settings → Apps → Default apps and choose it there."
LangString OtherInstall ${LANG_SIMPCHINESE} "已存在其他位置的 Vellora 安装。请先通过原安装程序卸载；本程序不会覆盖它。"
LangString OtherInstall ${LANG_ENGLISH} "Vellora is already installed in another location. Uninstall it with its original setup first; this setup won't overwrite it."
LangString OtherRegistration ${LANG_SIMPCHINESE} "已存在 Vellora 安装登记。请先正常卸载旧版；本程序不会接管它。"
LangString OtherRegistration ${LANG_ENGLISH} "An existing Vellora installation is registered. Uninstall the old version first; this setup won't take it over."
LangString OtherShortcuts ${LANG_SIMPCHINESE} "已存在 Vellora 快捷方式。请先处理旧入口；本程序不会覆盖它。"
LangString OtherShortcuts ${LANG_ENGLISH} "Vellora shortcuts already exist. Remove the old shortcuts first; this setup won't overwrite them."
LangString OtherVersion ${LANG_SIMPCHINESE} "目标目录已有其他版本。为避免降级或覆盖，请先卸载原版本或选择新的空目录。"
LangString OtherVersion ${LANG_ENGLISH} "The destination folder contains another version. To avoid a downgrade or overwrite, uninstall it first or choose a new empty folder."
LangString EmptyFolder ${LANG_SIMPCHINESE} "请选择空目录。现有文件不会被覆盖。"
LangString EmptyFolder ${LANG_ENGLISH} "Choose an empty folder. Existing files are never overwritten."
LangString CloseToInstall ${LANG_SIMPCHINESE} "请先保存文档并关闭 Vellora，再继续安装。程序文件当前不可替换。"
LangString CloseToInstall ${LANG_ENGLISH} "Save your documents and close Vellora before continuing. Its program files can't be replaced while it is running."
LangString CopyFailed ${LANG_SIMPCHINESE} "复制文件失败。请关闭占用文件的程序后重试；安装未完成。"
LangString CopyFailed ${LANG_ENGLISH} "Couldn't copy the files. Close any program using them and try again. Setup did not finish."
LangString MarkerMismatch ${LANG_SIMPCHINESE} "安装标记不匹配，已停止卸载以保护现有文件。"
LangString MarkerMismatch ${LANG_ENGLISH} "The installation marker doesn't match. Uninstall stopped to protect existing files."
LangString CloseToUninstall ${LANG_SIMPCHINESE} "请先保存文档并关闭 Vellora，再卸载。"
LangString CloseToUninstall ${LANG_ENGLISH} "Save your documents and close Vellora before uninstalling."

Function .onInit
  !insertmacro VELLORA_PICK_LANGUAGE ""
  StrCpy $AssociationSelected ${BST_UNCHECKED}
  StrCpy $AssociationRegistered 0
FunctionEnd

Function AssociationPageCreate
  !insertmacro MUI_HEADER_TEXT "$(AssocTitle)" "$(AssocSubtitle)"
  nsDialogs::Create 1018
  Pop $AssociationDialog
  ${If} $AssociationDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 24u "$(AssocCheckbox)"
  Pop $AssociationCheckbox
  ${NSD_SetState} $AssociationCheckbox $AssociationSelected
  ${NSD_OnClick} $AssociationCheckbox AssociationChoiceChanged
  ${NSD_CreateLabel} 0 46u 100% 62u "$(AssocDetails)"
  Pop $0
  nsDialogs::Show
FunctionEnd

; Page leave is not called on Back, so persist each checkbox change immediately.
Function AssociationChoiceChanged
  Pop $0
  ${NSD_GetState} $AssociationCheckbox $AssociationSelected
FunctionEnd

Function AssociationPageLeave
  ${NSD_GetState} $AssociationCheckbox $AssociationSelected
FunctionEnd

Function RegisterMarkdownAssociations
  ; Registration only. Never write extension defaults or protected UserChoice.
  ; A reused ProgID must not retarget a default belonging to another installation.
  ReadRegStr $0 HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" ""
  ${If} $0 != ""
  ${AndIf} $0 != '$\"$INSTDIR\vellora.exe$\" $\"%1$\"'
    Goto association_conflict
  ${EndIf}
  ReadRegStr $0 HKCU "Software\RegisteredApplications" "Vellora"
  ${If} $0 != ""
  ${AndIf} $0 != "${ASSOC_CAPABILITIES}"
    Goto association_conflict
  ${EndIf}
  ReadRegStr $0 HKCU "${ASSOC_CAPABILITIES}" "ApplicationName"
  ReadRegStr $1 HKCU "${ASSOC_CAPABILITIES}" "VelloraInstallerOwner"
  ${If} $1 != ""
  ${AndIf} $1 != $INSTDIR
    Goto association_conflict
  ${EndIf}
  ReadRegStr $2 HKCU "${ASSOC_CAPABILITIES}" "ApplicationIcon"
  ReadRegStr $3 HKCU "${ASSOC_CAPABILITIES}\FileAssociations" ".md"
  ReadRegStr $4 HKCU "${ASSOC_CAPABILITIES}\FileAssociations" ".markdown"
  ReadRegStr $5 HKCU "Software\RegisteredApplications" "Vellora"
  ReadRegStr $6 HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" ""
  ReadRegStr $7 HKCU "Software\Classes\${ASSOC_PROGID}" "VelloraInstallerOwner"
  ${If} $7 != ""
  ${AndIf} $7 != $INSTDIR
    Goto association_conflict
  ${EndIf}
  ; Adopt ownerless legacy registration only when every identity field matches.
  ; Completely absent registration remains valid for a fresh opt-in installation.
  ${If} $1 == ""
    ${If} $0 != ""
    ${OrIf} $2 != ""
    ${OrIf} $3 != ""
    ${OrIf} $4 != ""
    ${OrIf} $5 != ""
    ${OrIf} $6 != ""
      ${If} $0 != "Vellora"
      ${OrIf} $2 != '$\"$INSTDIR\vellora.exe$\",0'
      ${OrIf} $3 != "${ASSOC_PROGID}"
      ${OrIf} $4 != "${ASSOC_PROGID}"
      ${OrIf} $5 != "${ASSOC_CAPABILITIES}"
      ${OrIf} $6 != '$\"$INSTDIR\vellora.exe$\" $\"%1$\"'
        Goto association_conflict
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}" "" "$(ProgIdName)"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}" "VelloraInstallerOwner" "$INSTDIR"
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\DefaultIcon" "" '$\"$INSTDIR\vellora.exe$\",0'
  WriteRegStr HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" "" '$\"$INSTDIR\vellora.exe$\" $\"%1$\"'
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "${ASSOC_PROGID}" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "${ASSOC_PROGID}" ""
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}" "ApplicationName" "Vellora"
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}" "ApplicationDescription" "$(AppDescription)"
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}" "ApplicationIcon" '$\"$INSTDIR\vellora.exe$\",0'
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}" "VelloraInstallerOwner" "$INSTDIR"
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}\FileAssociations" ".md" "${ASSOC_PROGID}"
  WriteRegStr HKCU "${ASSOC_CAPABILITIES}\FileAssociations" ".markdown" "${ASSOC_PROGID}"
  WriteRegStr HKCU "Software\RegisteredApplications" "Vellora" "${ASSOC_CAPABILITIES}"
  IfErrors association_failed
  StrCpy $AssociationRegistered 1
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  Return
  association_conflict:
  MessageBox MB_ICONINFORMATION|MB_OK "$(AssocConflict)" /SD IDOK
  Return
  association_failed:
  MessageBox MB_ICONEXCLAMATION|MB_OK "$(AssocFailed)" /SD IDOK
FunctionEnd

Function .onInstSuccess
  ${If} $AssociationSelected == ${BST_CHECKED}
  ${AndIf} $AssociationRegistered == 1
    ClearErrors
    ExecShell "open" "ms-settings:defaultapps?registeredAppUser=Vellora"
    ${If} ${Errors}
      ClearErrors
      ExecShell "open" "ms-settings:defaultapps"
      ${If} ${Errors}
        MessageBox MB_ICONINFORMATION|MB_OK "$(SettingsManual)" /SD IDOK
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.RemoveOwnedMarkdownAssociations
  ; Only remove this install's registrations, never extension defaults or UserChoice.
  ReadRegStr $0 HKCU "Software\Classes\${ASSOC_PROGID}" "VelloraInstallerOwner"
  ReadRegStr $1 HKCU "Software\Classes\${ASSOC_PROGID}\shell\open\command" ""
  ${If} $0 == $INSTDIR
  ${AndIf} $1 == '$\"$INSTDIR\vellora.exe$\" $\"%1$\"'
    DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "${ASSOC_PROGID}"
    DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "${ASSOC_PROGID}"
    DeleteRegKey HKCU "Software\Classes\${ASSOC_PROGID}"
  ${EndIf}
  ReadRegStr $0 HKCU "${ASSOC_CAPABILITIES}" "VelloraInstallerOwner"
  ${If} $0 == $INSTDIR
    ReadRegStr $1 HKCU "Software\RegisteredApplications" "Vellora"
    ${If} $1 == "${ASSOC_CAPABILITIES}"
      DeleteRegValue HKCU "Software\RegisteredApplications" "Vellora"
    ${EndIf}
    DeleteRegKey HKCU "${ASSOC_CAPABILITIES}"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
FunctionEnd

; Never replace a foreign installation or downgrade; only the tested upgrade is allowed.
; Same-version repair and 0.1.0/0.1.1/0.1.2/0.1.3/0.1.4/0.1.5/0.1.6/0.1.7 -> 0.1.8 require this installer marker; upgrade also requires the registered directory.
Function VerifyDestination
  SetShellVarContext current
  ReadRegStr $0 HKCU "${INSTALL_KEY}" "InstallDir"
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    MessageBox MB_ICONSTOP|MB_OK "$(OtherInstall)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $2 HKCU "${UNINSTALL_KEY}" "UninstallString"
    ${If} $2 != ""
      MessageBox MB_ICONSTOP|MB_OK "$(OtherRegistration)" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\Vellora.lnk"
    ${OrIf} ${FileExists} "$SMPROGRAMS\Vellora\Vellora.lnk"
    ${OrIf} ${FileExists} "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_ZH}"
    ${OrIf} ${FileExists} "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_EN}"
      MessageBox MB_ICONSTOP|MB_OK "$(OtherShortcuts)" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\vellora-install.ini" "Vellora" "InstallerId"
  ${If} $0 == "${INSTALLER_ID}"
    ReadINIStr $0 "$INSTDIR\vellora-install.ini" "Vellora" "Version"
    StrCpy $3 0
    ${If} $0 == "${APP_VERSION}"
      StrCpy $3 1
    ${EndIf}
!if "${APP_VERSION}" == "0.1.8"
    ; Only known older versions with matching ownership may upgrade in place.
    ${If} $0 == "0.1.0"
    ${OrIf} $0 == "0.1.1"
    ${OrIf} $0 == "0.1.2"
    ${OrIf} $0 == "0.1.3"
    ${OrIf} $0 == "0.1.4"
    ${OrIf} $0 == "0.1.5"
    ${OrIf} $0 == "0.1.6"
    ${OrIf} $0 == "0.1.7"
      ReadRegStr $2 HKCU "${INSTALL_KEY}" "InstallDir"
      ${If} $2 == $INSTDIR
        StrCpy $3 1
      ${EndIf}
    ${EndIf}
!endif
    ${If} $3 != 1
      MessageBox MB_ICONSTOP|MB_OK "$(OtherVersion)" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${Else}
    FindFirst $0 $1 "$INSTDIR\*.*"
    loop:
      StrCmp $1 "" empty
      StrCmp $1 "." next
      StrCmp $1 ".." next
      FindClose $0
      MessageBox MB_ICONSTOP|MB_OK "$(EmptyFolder)" /SD IDOK
      SetErrorLevel 2
      Abort
    next:
      FindNext $0 $1
      Goto loop
    empty:
      FindClose $0
  ${EndIf}
  IfFileExists "$INSTDIR\vellora.exe" 0 unlocked
  ; Exclusive write-open checks sharing/image locks without changing file bytes.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\vellora.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_ICONSTOP|MB_OK "$(CloseToInstall)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  unlocked:
FunctionEnd

Section "Vellora"
  Call VerifyDestination
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File /r "${SOURCE_DIR}\*.*"
  IfErrors 0 copied
  MessageBox MB_ICONSTOP|MB_OK "$(CopyFailed)" /SD IDOK
  SetErrorLevel 2
  Abort
  copied:
  WriteINIStr "$INSTDIR\vellora-install.ini" "Vellora" "InstallerId" "${INSTALLER_ID}"
  WriteINIStr "$INSTDIR\vellora-install.ini" "Vellora" "Version" "${APP_VERSION}"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Vellora"
  CreateShortCut "$SMPROGRAMS\Vellora\Vellora.lnk" "$INSTDIR\vellora.exe" "" "$INSTDIR\vellora.exe" 0
  ; An upgrade in the other language replaces the old uninstall shortcut.
  Delete "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_ZH}"
  Delete "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_EN}"
  CreateShortCut "$SMPROGRAMS\Vellora\$(UninstallLink)" "$INSTDIR\uninstall.exe"
  CreateShortCut "$DESKTOP\Vellora.lnk" "$INSTDIR\vellora.exe" "" "$INSTDIR\vellora.exe" 0
  WriteRegStr HKCU "${INSTALL_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Vellora"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Vellora Contributors"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\vellora.exe,0"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${If} $AssociationSelected == ${BST_CHECKED}
    Call RegisterMarkdownAssociations
  ${EndIf}
  ; No forced defaults, autostart, application launch, or machine-wide changes.
SectionEnd

Function un.onInit
  !insertmacro VELLORA_PICK_LANGUAGE "un."
  SetShellVarContext current
  ReadINIStr $0 "$INSTDIR\vellora-install.ini" "Vellora" "InstallerId"
  ${If} $0 != "${INSTALLER_ID}"
    MessageBox MB_ICONSTOP|MB_OK "$(MarkerMismatch)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  IfFileExists "$INSTDIR\vellora.exe" 0 unlocked
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\vellora.exe", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_ICONSTOP|MB_OK "$(CloseToUninstall)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  unlocked:
FunctionEnd

Section "Uninstall"
  ; Only the exact package manifest is removed; unknown user files are retained.
  !include "${UNINSTALL_LIST}"
  Delete "$INSTDIR\vellora-install.ini"
  Delete "$INSTDIR\uninstall.exe"
  ReadRegStr $0 HKCU "${INSTALL_KEY}" "InstallDir"
  ${If} $0 == $INSTDIR
    Call un.RemoveOwnedMarkdownAssociations
    Delete "$SMPROGRAMS\Vellora\Vellora.lnk"
    Delete "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_ZH}"
    Delete "$SMPROGRAMS\Vellora\${UNINSTALL_LINK_EN}"
    RMDir "$SMPROGRAMS\Vellora"
    Delete "$DESKTOP\Vellora.lnk"
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    DeleteRegKey HKCU "${INSTALL_KEY}"
  ${EndIf}
  RMDir "$INSTDIR"
SectionEnd