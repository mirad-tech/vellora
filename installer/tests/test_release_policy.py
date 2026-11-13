"""Static release guards. No installer execution, registry writes or UI."""
from pathlib import Path
import re
import unittest
import tomllib
R = Path(__file__).resolve().parents[2]
S = (R / 'installer/vellora-qt-preview.nsi').read_text(encoding='utf-8')
V = S.split('Function VerifyDestination\n', 1)[1].split('FunctionEnd', 1)[0]
class ReleasePolicy(unittest.TestCase):
    def test_workspace_and_lock_versions(self):
        self.assertEqual(tomllib.loads((R/'Cargo.toml').read_text())['workspace']['package']['version'], '0.1.2')
        lock=tomllib.loads((R/'Cargo.lock').read_text())
        own=[p for p in lock['package'] if p['name'].startswith('vellora-')]
        self.assertEqual({p['name'] for p in own}, {'vellora-core','vellora-md','vellora-bridge'})
        self.assertTrue(all(p['version']=='0.1.2' for p in own))
    def test_all_release_labels_agree(self):
        for f, needle in [('qt-app/vellora.pro','VERSION = 0.1.2'),('qt-app/src/main.cpp','setApplicationVersion(QStringLiteral("0.1.2"))'),('installer/package-qt.ps1',"$Version = '0.1.2'")]:
            self.assertIn(needle,(R/f).read_text(encoding='utf-8'))
        self.assertIn('!define APP_VERSION "0.1.2"',S)
        self.assertIn('VIAddVersionKey "ProductName" "Vellora"',S)
    def test_explicit_upgrade_allowlist_with_registered_directory(self):
        branch=V.split('!if "${APP_VERSION}" == "0.1.2"',1)[1].split('!endif',1)[0]
        self.assertEqual(re.findall(r'\$0 == "([0-9.]+)"',branch), ['0.1.0','0.1.1'])
        self.assertIn('${If} $2 == $INSTDIR\n        StrCpy $3 1\n      ${EndIf}',branch)
        self.assertIn('ReadRegStr $2 HKCU "${INSTALL_KEY}" "InstallDir"',branch)
    def test_marker_version_and_foreign_directory_guards(self):
        self.assertLess(V.index('$0 == "${INSTALLER_ID}"'),V.index('StrCpy $3 0'))
        self.assertIn('${If} $0 == "${APP_VERSION}"\n      StrCpy $3 1',V)
        reject=V.split('${If} $3 != 1',1)[1].split('${EndIf}',1)[0]
        self.assertIn('SetErrorLevel 2',reject);self.assertIn('Abort',reject)
        self.assertIn('${AndIf} $0 != $INSTDIR',V)
        self.assertIn('FindFirst $0 $1 "$INSTDIR\\*.*"',V)
        self.assertIn('Call VerifyDestination',S.split('Section "Vellora"',1)[1])
    def test_non_destructive_defaults(self):
        self.assertIn('RequestExecutionLevel user',S)
        self.assertIn('StrCpy $AssociationSelected ${BST_UNCHECKED}',S)
        self.assertIn('!include "${UNINSTALL_LIST}"',S)
        self.assertNotRegex(S,r'(?im)^\s*RMDir\s+/r\s+"\$INSTDIR"')
        self.assertNotRegex(S,r'(?im)^\s*Delete\s+"\$INSTDIR\\\*')
if __name__=='__main__': unittest.main(verbosity=2)
