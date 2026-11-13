"""Read-only installer policy checks; these do not install or touch the registry."""
from pathlib import Path
import re
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / "vellora-qt-preview.nsi").read_text(encoding="utf-8")
INSTRUCTIONS = "\n".join(line for line in SOURCE.splitlines() if not line.lstrip().startswith(";"))

def function(name):
    return SOURCE.split("Function " + name + "\n", 1)[1].split("FunctionEnd", 1)[0]

class AssociationPolicy(unittest.TestCase):
    def test_default_is_opt_out(self):
        self.assertIn("StrCpy $AssociationSelected ${BST_UNCHECKED}", function(".onInit"))
        self.assertIn("${NSD_SetState} $AssociationCheckbox $AssociationSelected", function("AssociationPageCreate"))
    def test_choice_is_visible_and_retained(self):
        self.assertIn("Page custom AssociationPageCreate AssociationPageLeave", SOURCE)
        self.assertIn("${NSD_GetState} $AssociationCheckbox $AssociationSelected", function("AssociationPageLeave"))
        self.assertIn("${NSD_OnClick} $AssociationCheckbox AssociationChoiceChanged", function("AssociationPageCreate"))
        self.assertIn("Pop $0", function("AssociationChoiceChanged"))
        self.assertIn("${NSD_GetState} $AssociationCheckbox $AssociationSelected", function("AssociationChoiceChanged"))
    def test_registration_is_guarded_by_choice(self):
        self.assertRegex(SOURCE, r'\$\{If\} \$AssociationSelected == \$\{BST_CHECKED\}\s+Call RegisterMarkdownAssociations\s+\$\{EndIf\}')
    def test_no_forced_default_or_machine_registration(self):
        writes = [line for line in INSTRUCTIONS.splitlines() if re.match(r"\s*(WriteReg|DeleteReg)", line)]
        self.assertFalse(any("UserChoice" in line or " HKLM " in line for line in writes))
        self.assertFalse(any(re.search(r'Software\\Classes\\\.(?:md|markdown)"\s+""', line) for line in writes))
    def test_exact_supported_file_types(self):
        body = function("RegisterMarkdownAssociations")
        self.assertEqual(set(re.findall(r'FileAssociations" "([^\"]+)"', body)), {".md", ".markdown"})
        self.assertEqual(body.count("\\OpenWithProgids"), 2)
    def test_existing_other_install_is_not_retargeted(self):
        body = function("RegisterMarkdownAssociations")
        self.assertIn("Goto association_conflict", body)
        self.assertLess(body.index("Goto association_conflict"), body.index("WriteRegStr"))
    def test_ownerless_legacy_adoption_requires_complete_identity(self):
        body = function("RegisterMarkdownAssociations")
        guard = body.split('; Adopt ownerless legacy registration', 1)[1].split('  ClearErrors', 1)[0]
        for check in ('$1 == ""', '$0 != "Vellora"', '$3 != "${ASSOC_PROGID}"', '$4 != "${ASSOC_PROGID}"', '$5 != "${ASSOC_CAPABILITIES}"'):
            self.assertIn(check, guard)
        self.assertIn('${OrIf} $2 !=', guard)
        self.assertIn('${OrIf} $6 !=', guard)
        self.assertIn('Goto association_conflict', guard)
        for owner in ('$1', '$7'):
            self.assertIn('${If} ' + owner + ' != ""', body)
            self.assertIn('${AndIf} ' + owner + ' != $INSTDIR', body)

    def test_cleanup_requires_owner_and_open_command(self):
        body = function("un.RemoveOwnedMarkdownAssociations")
        self.assertIn('"VelloraInstallerOwner"', body)
        self.assertIn('${If} $0 == $INSTDIR', body)
        self.assertIn('${AndIf} $1 ==', body)
        self.assertNotIn('DeleteRegKey HKCU "Software\\Vellora"', body)
    def test_settings_only_after_successful_opt_in(self):
        body = function(".onInstSuccess")
        self.assertIn('$AssociationSelected == ${BST_CHECKED}', body)
        self.assertIn('$AssociationRegistered == 1', body)
        self.assertIn('ms-settings:defaultapps?registeredAppUser=Vellora', body)
        self.assertIn('"ms-settings:defaultapps"', body)
    def test_original_upgrade_and_data_guards_remain(self):
        body = function("VerifyDestination")
        for value in ('${INSTALLER_ID}', '$0 == "0.1.0"', 'kernel32::CreateFileW', 'FindFirst'):
            self.assertIn(value, body)
        self.assertIn('!include "${UNINSTALL_LIST}"', SOURCE)
        self.assertNotIn('RMDir /r "$INSTDIR"', SOURCE)

if __name__ == "__main__":
    unittest.main(verbosity=2)
