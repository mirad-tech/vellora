"""Static release guards. No installer execution, registry writes or UI."""
from pathlib import Path
import re
import unittest
import tomllib
R = Path(__file__).resolve().parents[2]
S = (R / 'installer/vellora-qt-preview.nsi').read_text(encoding='utf-8')
V = S.split('Function VerifyDestination\n', 1)[1].split('FunctionEnd', 1)[0]
PKG = (R / 'installer/package-qt.ps1').read_text(encoding='utf-8')
class ReleasePolicy(unittest.TestCase):
    def test_workspace_and_lock_versions(self):
        self.assertEqual(tomllib.loads((R/'Cargo.toml').read_text())['workspace']['package']['version'], '0.1.7')
        lock=tomllib.loads((R/'Cargo.lock').read_text())
        own=[p for p in lock['package'] if p['name'].startswith('vellora-')]
        self.assertEqual({p['name'] for p in own}, {'vellora-core','vellora-md','vellora-bridge'})
        self.assertTrue(all(p['version']=='0.1.7' for p in own))
    def test_all_release_labels_agree(self):
        for f, needle in [('qt-app/vellora.pro','VERSION = 0.1.7'),('qt-app/src/main.cpp','setApplicationVersion(QStringLiteral("0.1.7"))'),('installer/package-qt.ps1',"$Version = '0.1.7'")]:
            self.assertIn(needle,(R/f).read_text(encoding='utf-8'))
        self.assertIn('!define APP_VERSION "0.1.7"',S)
        self.assertIn('VIAddVersionKey "ProductName" "Vellora"',S)
    def test_explicit_upgrade_allowlist_with_registered_directory(self):
        branch=V.split('!if "${APP_VERSION}" == "0.1.7"',1)[1].split('!endif',1)[0]
        self.assertEqual(re.findall(r'\$0 == "([0-9.]+)"',branch), ['0.1.0','0.1.1','0.1.2','0.1.3','0.1.4','0.1.5','0.1.6'])
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
    def test_portable_marker_only_in_the_zip(self):
        # The setup and its uninstall list come from $portable: the marker must
        # only reach a separate copy, after NSIS, or installs would turn portable.
        files=PKG.index('$entries = Get-ChildItem -LiteralPath $portable -Recurse -File')
        nsis=PKG.index('& $MakeNsis')
        marker=PKG.index("'assets\\portable.txt'")
        self.assertLess(files,nsis);self.assertLess(nsis,marker)
        self.assertEqual(len(re.findall(r'Copy-Item[^\n]*portable\.txt',PKG)),1)
        self.assertIn(') -Destination $zipRoot',PKG[marker:marker+60])
        self.assertLess(PKG.index("throw 'The installer source must not contain portable.txt.'"),marker)
        self.assertIn('portable_zip_sha256=',PKG)
        self.assertTrue((R/'installer/assets/portable.txt').is_file())
        note=(R/'installer/assets/README-dist.txt').read_text(encoding='utf-8-sig')
        self.assertIn('{VERSION}',note);self.assertIn('portable.txt',note)
class InstallerLanguages(unittest.TestCase):
    """Chinese Windows display languages get the Chinese setup, all others English."""
    def test_english_default_and_chinese_by_display_language(self):
        langs=re.findall(r'!insertmacro MUI_LANGUAGE "(\w+)"',S)
        self.assertEqual(langs,['English','SimpChinese'])
        self.assertNotIn('MUI_LANGDLL',S)
        pick=S.split('!macro VELLORA_PICK_LANGUAGE',1)[1].split('!macroend',1)[0]
        self.assertIn('GetUserDefaultUILanguage',pick)
        self.assertIn('IntOp $0 $0 & 0x3FF',pick)
        self.assertIn('${If} $0 = 0x04\n    StrCpy $LANGUAGE ${LANG_SIMPCHINESE}',pick)
        self.assertIn('StrCpy $LANGUAGE ${LANG_ENGLISH}',pick)
        for init in ('Function .onInit\n','Function un.onInit\n'):
            body=S.split(init,1)[1].split('FunctionEnd',1)[0]
            self.assertTrue(body.lstrip().startswith('!insertmacro VELLORA_PICK_LANGUAGE'),init)
    def test_every_message_has_both_languages(self):
        defined={}
        for name,lang in re.findall(r'^LangString (\w+) \$\{LANG_(\w+)\} ',S,re.M):
            defined.setdefault(name,set()).add(lang)
        self.assertTrue(defined)
        for name,langs in defined.items():
            self.assertEqual(langs,{'ENGLISH','SIMPCHINESE'},name)
        used=set(re.findall(r'\$\((\w+)\)',S))
        self.assertEqual(used,set(defined))
        for line in S.splitlines():
            if line.lstrip().startswith((';','LangString','!define UNINSTALL_LINK_')): continue
            self.assertNotRegex(line,r'[\u4e00-\u9fff]',line)
    def test_both_uninstall_shortcut_names_are_guarded_and_removed(self):
        for name in ('${UNINSTALL_LINK_ZH}','${UNINSTALL_LINK_EN}'):
            self.assertIn('${OrIf} ${FileExists} "$SMPROGRAMS\\Vellora\\'+name+'"',V)
            uninstall=S.split('Section "Uninstall"',1)[1]
            self.assertIn('Delete "$SMPROGRAMS\\Vellora\\'+name+'"',uninstall)
        self.assertIn('!define UNINSTALL_LINK_ZH "卸载 Vellora.lnk"',S)
if __name__=='__main__': unittest.main(verbosity=2)
