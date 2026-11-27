#!/usr/bin/env python3
"""Checks the English UI translation against the Qt sources.

Every ui::tr("...") / ui::trTrash("...") string in qt-app/src must have a
finished English translation in qt-app/translations/vellora_en.ts, with plural
forms for counted strings and one entry per trash variant ("recycle-bin" for
Windows, "trash" elsewhere). The .ts must not keep translations nothing uses,
and no Chinese text may reach the UI without going through ui::tr. Run it from
anywhere; it reads files only. Exit status 1 lists every problem.
"""

from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "qt-app" / "src"
TS_FILE = ROOT / "qt-app" / "translations" / "vellora_en.ts"
CONTEXT = "Vellora"
TRASH_VARIANTS = ("recycle-bin", "trash")
HAN = re.compile(r"[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]")
# Content, not interface: a font-metrics sample in a test-only layout dump.
ALLOWED_CHINESE = ("Vellora 用于阅读、直接编辑与源码编辑。",)

STRING = r'"(?:[^"\\\n]|\\.)*"'
CALL = re.compile(r"ui::(tr|trTrash)\(\s*((?:" + STRING + r"\s*)+)(,\s*[^)]+)?\)")
ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "'": "'"}


def unescape(literals: str) -> str:
  text = "".join(re.findall(r'"((?:[^"\\\n]|\\.)*)"', literals))
  return re.sub(r"\\(.)", lambda m: ESCAPES.get(m.group(1), m.group(0)), text)


def strip_comments(code: str) -> str:
  # Keeps string literals intact; drops // and /* */ comments.
  pattern = re.compile(STRING + r"|//[^\n]*|/\*.*?\*/", re.S)
  return pattern.sub(lambda m: m.group(0) if m.group(0).startswith('"') else " ", code)


def used_strings() -> tuple[dict[tuple[str, str], bool], list[str]]:
  used: dict[tuple[str, str], bool] = {}
  problems: list[str] = []
  for path in sorted(list(SOURCES.glob("*.cpp")) + list(SOURCES.glob("*.h"))):
    code = strip_comments(path.read_text(encoding="utf-8"))
    for match in CALL.finditer(code):
      kind, literals, extra = match.groups()
      source = unescape(literals)
      numerus = bool(extra) and kind == "tr"
      comments = TRASH_VARIANTS if kind == "trTrash" else ("",)
      for comment in comments:
        used[(source, comment)] = used.get((source, comment), False) or numerus
    # Chinese outside ui::tr reaches the UI untranslated.
    remaining = CALL.sub(" ", code)
    for literal in re.findall(STRING, remaining):
      if HAN.search(literal) and not any(allowed in literal for allowed in ALLOWED_CHINESE):
        problems.append(f"{path.relative_to(ROOT)}: Chinese text outside ui::tr: {literal}")
  return used, problems


def translations() -> tuple[dict[tuple[str, str], ET.Element], list[str]]:
  problems: list[str] = []
  tree = ET.parse(TS_FILE)
  root = tree.getroot()
  if root.get("language") != "en" or root.get("sourcelanguage") != "zh_CN":
    problems.append("vellora_en.ts must declare language=\"en\" sourcelanguage=\"zh_CN\"")
  entries: dict[tuple[str, str], ET.Element] = {}
  for context in root.iter("context"):
    name = context.findtext("name")
    if name != CONTEXT:
      problems.append(f"unexpected context {name!r}; ui::tr uses {CONTEXT!r}")
      continue
    for message in context.iter("message"):
      key = (message.findtext("source") or "", message.findtext("comment") or "")
      if key in entries:
        problems.append(f"duplicate translation: {key}")
      entries[key] = message
  return entries, problems


def main() -> int:
  # A Windows console may not encode Chinese; never fail on reporting itself.
  sys.stdout.reconfigure(errors="backslashreplace")
  sys.stderr.reconfigure(errors="backslashreplace")
  used, problems = used_strings()
  entries, ts_problems = translations()
  problems += ts_problems
  for key, numerus in sorted(used.items()):
    message = entries.get(key)
    label = repr(key[0]) + (f" ({key[1]})" if key[1] else "")
    if message is None:
      problems.append(f"missing English translation: {label}")
      continue
    translation = message.find("translation")
    if translation is None or translation.get("type") in ("unfinished", "obsolete", "vanished"):
      problems.append(f"unfinished translation: {label}")
      continue
    forms = [form.text or "" for form in translation.findall("numerusform")]
    if numerus:
      if message.get("numerus") != "yes" or len(forms) != 2 or not all("%n" in form for form in forms):
        problems.append(f"counted string needs two English forms with %n: {label}")
    elif message.get("numerus") == "yes" or not (translation.text or "").strip():
      problems.append(f"empty or plural translation for an uncounted string: {label}")
    english = " ".join(forms) if numerus else translation.text or ""
    if HAN.search(english):
      problems.append(f"translation still contains Chinese: {label}")
    for placeholder in sorted(set(re.findall(r"%\d", key[0]))):
      if placeholder not in english:
        problems.append(f"translation drops {placeholder}: {label}")
  for key in sorted(set(entries) - set(used)):
    problems.append(f"translation of a string the UI no longer uses: {key}")
  for problem in problems:
    print(problem, file=sys.stderr)
  if not problems:
    print(f"English translation covers all {len(used)} UI strings.")
  return 1 if problems else 0


if __name__ == "__main__":
  sys.exit(main())
