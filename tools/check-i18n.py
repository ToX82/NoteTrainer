#!/usr/bin/env python3
"""Check that every translatable string is declared, translated and consistent.

Run after touching any UI string or locale file:

    python3 tools/check-i18n.py

It reports four kinds of problem:
  * a key used by the code but missing from en.json (unless the call site
    passes a fallback, which is how data-driven text — level names, interval
    names, achievements — carries its own English);
  * a key in en.json that nothing uses any more;
  * a key en.json has and a translation does not (or the reverse);
  * a placeholder like {count} that appears in one locale but not the other,
    which would silently print a blank where a number belongs.

Exits non-zero if anything is wrong, so it can gate a commit.
"""

import json
import re
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"
I18N = DOCS / "i18n"
BASE_LOCALE = "en"

# Files scanned for T(...)/tr(...) calls and data-i18n attributes.
# app/i18n.js is deliberately absent: the only keys in it are usage examples in
# its own doc comment.
SOURCES = ["screen.html", "screen.js", "settings-panel.html", "settings.html",
           "index.html", "app/boot.js", "app/input.js", "app/theme.js"] + \
          [str(p.relative_to(DOCS)) for p in sorted((DOCS / "utils").glob("*.js"))]


def split_args(text: str):
    """Split a call's argument list on top-level commas."""
    args, depth, current, quote = [], 0, "", None
    for ch in text:
        if quote:
            current += ch
            if ch == quote and not current.endswith("\\" + ch):
                quote = None
            continue
        if ch in "'\"":
            quote, current = ch, current + ch
        elif ch in "([{":
            depth, current = depth + 1, current + ch
        elif ch in ")]}":
            depth, current = depth - 1, current + ch
        elif ch == "," and depth == 0:
            args.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        args.append(current.strip())
    return args


def strip_condition(arg: str) -> str:
    """Drop a ternary's condition: only its branches can be keys.

    T(mode === 'interval' ? 'ear.intro_interval' : 'ear.intro') must not report
    'interval' — that literal is part of the test, not a key.
    """
    quote = None
    for i, ch in enumerate(arg):
        if quote:
            if ch == quote and arg[i - 1] != "\\":
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "?":
            return arg[i + 1:]
    return arg


def find_calls(source: str, func: str):
    """Yield (key, is_dynamic, has_fallback) for every func(…) call.

    The first argument is not always a bare literal: it can be a ternary
    (T(cond ? 'a' : 'b') — both branches are real keys) or a concatenation
    (T('levels.' + id + '.label') — only a prefix is knowable statically).
    """
    for m in re.finditer(r"\b" + func + r"\(", source):
        open_paren = m.end() - 1
        depth, i, quote = 1, open_paren + 1, None
        while i < len(source) and depth:
            ch = source[i]
            if quote:
                if ch == quote and source[i - 1] != "\\":
                    quote = None
            elif ch in "'\"":
                quote = ch
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            i += 1
        args = split_args(source[open_paren + 1:i - 1])
        if not args:
            continue
        first = args[0]
        dynamic = "+" in first
        # A ternary picking between two keys yields both; a concatenation yields
        # only prefixes, and there the condition's literals are prefixes too —
        # harmless, so it is left whole rather than risking a lost prefix.
        keys = re.findall(r"'([^']*)'", first if dynamic else strip_condition(first))
        if not keys:
            continue
        if func == "tr":
            has_fallback = len(args) >= 2      # tr(key, fallback)
        else:
            has_fallback = len(args) >= 3      # T(key, params, fallback)
        for key in keys:
            yield key, dynamic, has_fallback


def collect_used():
    """(required, optional, dynamic_prefixes) key sets across all sources."""
    required, optional, prefixes = set(), set(), set()
    for rel in SOURCES:
        path = DOCS / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".html":
            for attr in ("data-i18n", "data-i18n-html"):
                required.update(re.findall(attr + r'="([^"]+)"', text))
            for group in re.findall(r'data-i18n-attr="([^"]+)"', text):
                for pair in group.split(";"):
                    if ":" in pair:
                        required.add(pair.split(":", 1)[1].strip())
        # Keys reached indirectly (a table of key names, a helper that calls T
        # for you) are declared with an `i18n-used:` comment at the call site.
        for group in re.findall(r"i18n-used:\s*([^\n*]+)", text):
            required.update(k.strip() for k in group.split(",") if k.strip())
        for func in ("T", "tr"):
            for key, dynamic, has_fallback in find_calls(text, func):
                if dynamic:
                    prefixes.add(key)
                elif has_fallback:
                    optional.add(key)
                else:
                    required.add(key)
    return required, optional, prefixes


def placeholders(value: str):
    return set(re.findall(r"\{(\w+)\}", value))


def main() -> int:
    base = json.loads((I18N / f"{BASE_LOCALE}.json").read_text(encoding="utf-8"))
    required, optional, prefixes = collect_used()
    problems = []

    # Plural variants live under key_one / key_other; the code asks for "key".
    def declared(key, table):
        return key in table or any(k.startswith(key + "_") for k in table)

    for key in sorted(required):
        if not declared(key, base):
            problems.append(f"missing from {BASE_LOCALE}.json: {key}")

    for prefix in sorted(prefixes):
        if not any(k.startswith(prefix) for k in base):
            # Data-driven prefixes (levels., interval., achievement.) legitimately
            # have no English entry — their fallback is the source data.
            continue

    used_any = required | optional
    for key in sorted(base):
        stem = re.sub(r"_(one|other|few|many|two|zero)$", "", key)
        if stem in used_any or key in used_any:
            continue
        if any(stem.startswith(p) or key.startswith(p) for p in prefixes):
            continue
        problems.append(f"unused in {BASE_LOCALE}.json: {key}")

    for path in sorted(I18N.glob("*.json")):
        code = path.stem
        if code == BASE_LOCALE:
            continue
        other = json.loads(path.read_text(encoding="utf-8"))
        for key in sorted(base):
            if key not in other:
                problems.append(f"{code}.json: not translated: {key}")
            elif placeholders(base[key]) != placeholders(other[key]):
                problems.append(
                    f"{code}.json: placeholders differ for {key}: "
                    f"{sorted(placeholders(base[key]))} vs {sorted(placeholders(other[key]))}")
        for key in sorted(other):
            if key in base:
                continue
            # Extra keys are how a locale translates data-driven text.
            if any(key.startswith(p) for p in prefixes):
                continue
            problems.append(f"{code}.json: key not in {BASE_LOCALE}.json: {key}")

    if problems:
        for p in problems:
            print("  " + p)
        print(f"i18n: {len(problems)} problem(s)")
        return 1

    locales = sorted(p.stem for p in I18N.glob("*.json"))
    print(f"i18n: ok — {len(base)} keys, locales: {', '.join(locales)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
