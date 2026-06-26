!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var RegisterMarkdownAssociation
Var RegisterMarkdownAssociationCheckbox

!macro customPageAfterChangeDir
  Page custom MarkdownAssociationPageCreate MarkdownAssociationPageLeave
!macroend

Function MarkdownAssociationPageCreate
  nsDialogs::Create 1018
  Pop $0

  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0u 20u 100% 16u "将 Vellora 设为默认打开 .md 和 .markdown 文件的程序"
  Pop $RegisterMarkdownAssociationCheckbox
  ${NSD_SetState} $RegisterMarkdownAssociationCheckbox ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function MarkdownAssociationPageLeave
  ${NSD_GetState} $RegisterMarkdownAssociationCheckbox $RegisterMarkdownAssociation
FunctionEnd

!macro customInstall
  ${If} $RegisterMarkdownAssociation != ${BST_CHECKED}
    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.md" ""
    ${If} $0 == "Markdown File"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.md" ""
    ${EndIf}
    !insertmacro APP_UNASSOCIATE "md" "Markdown File"

    ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.markdown" ""
    ${If} $0 == "Markdown File"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown" ""
    ${EndIf}
    !insertmacro APP_UNASSOCIATE "markdown" "Markdown File"
  ${EndIf}
!macroend
!endif
