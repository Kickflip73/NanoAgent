#!/usr/bin/env python3
"""Deterministic style gate for writing-partner outputs.

The gate catches high-signal AI-sounding Chinese patterns before an article,
memo, or report is shown to the user, saved, previewed, or published.

Three layers:
  1. Line-level regex scan for AI-sounding phrases (the original gate).
  2. Paragraph-level statistic that flags articles where almost every
     sentence has been broken onto its own line — the failure mode that
     showed up across `03-outputs/articles/tw93-ai-series/`.
  3. Advisory-only sentence-rhythm hints (never affect the exit code):
     runs of consecutive long sentences read as monotonous report prose.
     Deliberate list-density closers (sentences with 3+ 顿号) are exempt.

Paragraph profiles
------------------
- ``article`` (公众号长文 / 默认 ``03-outputs/articles/``):
    * single-sentence ratio ≤ 15% (large sample)
    * longest consecutive single-sentence run ≤ 6
    * small-sample fallback: ≤ 3 single-sentence paragraphs total
- ``report`` (商务工作 / 默认 ``03-outputs/reports/``):
    * no ratio gate (reports rely on tables, lists, captions)
    * longest consecutive single-sentence run ≤ 8
- ``auto`` (default): infer from path; unknown paths fall back to ``article``.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Rule:
    code: str
    pattern: re.Pattern[str]
    reason: str
    fix: str


RULES = [
    Rule(
        "binary_contrast",
        re.compile(r"不是[^。！？；;\n]{0,80}(?:而是|，是|,是|是)|而不是"),
        "二元对照句会显得像模板化纠偏。",
        "直接写后半句的判断，再补依据、动作、边界或代价。",
    ),
    Rule(
        "not_only_but",
        re.compile(r"不仅[^。！？；;\n]{0,80}更是"),
        "递进感常被写成虚假的升格。",
        "拆成两个事实，只保留真正影响判断的那一个。",
    ),
    Rule(
        "cannot_but_should",
        re.compile(r"(?:不能|不应|不要)[^。！？；;\n]{0,80}而(?:要|应|是)"),
        "先否定再拔高，容易变成说教。",
        "写清失败条件、边界或下一步动作。",
    ),
    Rule(
        "lecture_transition",
        re.compile(r"值得注意的是|不难发现|可以看到|不难看出|更重要的是"),
        "常见 AI 转场，信息量低。",
        "删掉转场，直接进入判断或事实。",
    ),
    Rule(
        "teacher_pose",
        re.compile(r"有一(?:个|点)很关键|关键在于|真正重要的是|这里面每一步都不神秘|并不复杂|说穿了"),
        "先摆讲课姿态，再给判断。",
        "改成具体判断、真实难点、流程细节或业务动作。",
    ),
    Rule(
        "abstract_logic",
        re.compile(r"这背后反映的是|背后的逻辑是|本质上|这意味着|意味着什么"),
        "把具体问题抽象化，容易空转。",
        "先写事实，再写它改变了什么判断或动作。",
    ),
    Rule(
        "balanced_voice",
        re.compile(r"一方面|另一方面"),
        "平衡腔容易掩盖取舍。",
        "如果有取舍，直接写推荐方向和放弃代价。",
    ),
    Rule(
        "empty_progress",
        re.compile(r"持续优化|继续推进|进一步完善|不断提升|仍需完善|有待进一步完善|取得显著进展|打下坚实基础"),
        "正确但空泛，读者看不到具体动作。",
        "替换成下一步动作、责任边界、时间节点、数据缺口或待决策问题。",
    ),
    Rule(
        "author_intent",
        re.compile(r"我更关心的是|我不太想|我想表达的是|本文想表达|本文将|下文将"),
        "作者意图说明会暴露写作框架，读者仍然没有得到新信息。",
        "删掉意图说明，直接写你要表达的对象、动作、边界或判断。",
    ),
    Rule(
        "abstract_cushion",
        re.compile(r"背景很现实|更现实的是|这件事的本质是|真正的问题是|这才是问题所在"),
        "抽象垫片容易显得像 AI 在下总结，信息密度低。",
        "直接写具体变化、业务动作、失败代价或真实约束。",
    ),
    Rule(
        "zero_info_bridge",
        re.compile(r"这段话没有错|这也是问题所在|放到[^。！？；;\n]{1,30}场景里[^。！？；;\n]{0,20}具体|从[^。！？；;\n]{1,30}视角来看"),
        "显性转场或桥接句通常不增加信息量。",
        "删掉桥接句，直接进入下一层事实、判断或业务动作。",
    ),
    Rule(
        "pseudo_product_name",
        re.compile(r"(?<![\u4e00-\u9fff])(?!(?:[^。！？；;\n]{0,12}做\s*Agent))[\u4e00-\u9fff]{2,10}\s*(?:Agent|大脑|中台)"),
        "未定义的产品化命名容易显得宽泛，把注意力从业务动作带走。",
        "如果不是已有产品或前文已定义概念，改成业务对象、系统动作或人审链路。",
    ),
    Rule(
        "heading_teacher_pose",
        re.compile(r"^#{1,6}\s*[^#\n]{0,40}(?:卡住，往往|关键在于|真正重要的是|真正的问题是)"),
        "标题像专家教育读者，会削弱探讨口吻。",
        "标题改成具体问题、业务场景、对象或动作链。",
    ),
]


# Sentence terminators that count as a "complete sentence" boundary.
SENTENCE_TERMINATORS = re.compile(r"[。！？；…]|[.!?;](?=\s|$)")

# Inline patterns to strip before counting sentences in a paragraph.
INLINE_CODE = re.compile(r"`[^`\n]*`")
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\([^)]*\)")
HTML_TAG = re.compile(r"<[^>\n]+>")

# A paragraph that is just a short bold/italic *section label* like
# "**推荐参考项目：**" or "*风险一:*" — common section-headers inside business
# reports. Strictly limited to labels that end in a colon (full-width or
# half-width). Bold sentences ending in 。！？ are real emphasis and must
# still count as single-sentence paragraphs (otherwise authors can bypass
# the gate by wrapping every sentence in `**...**`).
SHORT_BOLD_LABEL = re.compile(r"^\*\*[^*\n]{1,30}[：:]\*\*$")
SHORT_BOLD_LABEL_OUTER_COLON = re.compile(r"^\*\*[^*\n]{1,30}\*\*[：:]$")
SHORT_ITALIC_LABEL = re.compile(r"^\*[^*\n]{1,30}[：:]\*$")
SHORT_ITALIC_LABEL_OUTER_COLON = re.compile(r"^\*[^*\n]{1,30}\*[：:]$")
# Metadata-style line: "**GitHub**: https://..." — leading bold key, colon, value.
METADATA_LINE = re.compile(r"^\*\*[^*\n]{1,40}\*\*\s*[:：]")


# Advisory sentence-rhythm thresholds (hints only, never fail the gate).
LONG_SENTENCE_CHARS = 45
LONG_SENTENCE_RUN = 3
LIST_DENSITY_COMMAS = 3  # sentences with >= 3 顿号 are deliberate density closers


PROFILE_DEFAULTS = {
    "article": {
        "ratio": 0.15,
        "max_run": 6,
        "min_sample": 20,
        "small_allowance": 3,
        "use_ratio": True,
    },
    "report": {
        "ratio": 0.35,  # advisory only; not enforced
        "max_run": 8,
        "min_sample": 20,
        "small_allowance": 4,
        "use_ratio": False,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan Markdown files for writing-partner AI-sounding patterns.",
    )
    parser.add_argument("files", nargs="+", help="Markdown files to scan")
    parser.add_argument(
        "--ignore-blockquotes",
        action="store_true",
        help="Ignore Markdown blockquotes. Use only for rule/example documents, not final writing outputs.",
    )
    parser.add_argument(
        "--max-context",
        type=int,
        default=120,
        help="Maximum characters of matched line context to print.",
    )
    parser.add_argument(
        "--no-paragraph-check",
        dest="paragraph_check",
        action="store_false",
        help="Disable the paragraph-level checks (default on).",
    )
    parser.add_argument(
        "--profile",
        choices=("article", "report", "auto"),
        default="auto",
        help="Paragraph-check profile. auto = infer from path (articles/ → article, reports/ → report, else article).",
    )
    parser.add_argument(
        "--no-advisory",
        dest="advisory",
        action="store_false",
        help="Suppress advisory-only hints (sentence rhythm). Advisories never affect the exit code.",
    )
    parser.set_defaults(paragraph_check=True, advisory=True)
    return parser.parse_args()


def iter_scannable_lines(text: str, ignore_blockquotes: bool) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    in_fence = False

    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if ignore_blockquotes and stripped.startswith(">"):
            continue
        if not stripped:
            continue
        lines.append((lineno, line))

    return lines


def scan_file(path: Path, ignore_blockquotes: bool) -> list[tuple[int, Rule, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text()

    findings: list[tuple[int, Rule, str]] = []
    for lineno, line in iter_scannable_lines(text, ignore_blockquotes):
        for rule in RULES:
            if rule.pattern.search(line):
                findings.append((lineno, rule, line.strip()))
    return findings


def _is_excluded_paragraph_line(stripped: str) -> bool:
    """Detect lines that are structural, not natural-paragraph prose."""
    if not stripped:
        return True
    if stripped.startswith("#"):
        return True
    if stripped.startswith(("- ", "* ", "+ ")):
        return True
    if re.match(r"^\d+[.)]\s", stripped):
        return True
    if stripped.startswith("|"):
        return True
    if stripped.startswith(">"):
        return True
    if stripped.startswith("---") or stripped.startswith("***") or stripped.startswith("___"):
        return True
    if re.match(r"^!\[[^\]]*\]\([^)]*\)\s*$", stripped):
        return True
    if re.match(r"^<[^>]+>\s*$", stripped):
        return True
    if re.match(r"^\[\^[^\]]+\]:", stripped):
        return True
    return False


def _is_structural_paragraph(joined: str) -> bool:
    """A whole paragraph that's just a section label or metadata line.

    Only excludes labels that end with a colon (full- or half-width). Bold
    sentences ending in 。！？ are real emphasis and must remain counted as
    single-sentence paragraphs.
    """
    text = joined.strip()
    if not text:
        return True
    if SHORT_BOLD_LABEL.match(text) or SHORT_BOLD_LABEL_OUTER_COLON.match(text):
        return True
    if SHORT_ITALIC_LABEL.match(text) or SHORT_ITALIC_LABEL_OUTER_COLON.match(text):
        return True
    if METADATA_LINE.match(text):
        return True
    return False


def _strip_front_matter(text: str) -> str:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return text
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            return "\n".join(lines[idx + 1 :])
    return text


def _extract_natural_paragraphs(text: str) -> list[str]:
    """Yield natural-prose paragraphs from Markdown text.

    Skips front matter, code fences, structural lines, and whole paragraphs
    that are just short bold/italic section labels or metadata.
    """
    body = _strip_front_matter(text)
    paragraphs: list[str] = []
    buffer: list[str] = []
    buffer_excluded = False
    in_fence = False

    def flush() -> None:
        nonlocal buffer, buffer_excluded
        if buffer and not buffer_excluded:
            joined = " ".join(line.strip() for line in buffer).strip()
            if joined and not _is_structural_paragraph(joined):
                paragraphs.append(joined)
        buffer = []
        buffer_excluded = False

    for raw in body.splitlines():
        stripped = raw.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            flush()
            continue
        if in_fence:
            continue
        if not stripped:
            flush()
            continue
        if _is_excluded_paragraph_line(stripped):
            buffer_excluded = True
            buffer.append(raw)
            continue
        buffer.append(raw)

    flush()
    return paragraphs


def _count_sentences(paragraph: str) -> int:
    cleaned = MARKDOWN_LINK.sub(" ", paragraph)
    cleaned = INLINE_CODE.sub(" ", cleaned)
    cleaned = HTML_TAG.sub(" ", cleaned)
    cleaned = cleaned.strip()
    if not cleaned:
        return 0
    terminators = len(SENTENCE_TERMINATORS.findall(cleaned))
    if terminators == 0:
        return 1
    if not SENTENCE_TERMINATORS.search(cleaned[-1]):
        terminators += 1
    return terminators


def _split_sentences(paragraph: str) -> list[str]:
    cleaned = MARKDOWN_LINK.sub(" ", paragraph)
    cleaned = INLINE_CODE.sub(" ", cleaned)
    cleaned = HTML_TAG.sub(" ", cleaned)
    parts = SENTENCE_TERMINATORS.split(cleaned)
    return [part.strip() for part in parts if part and part.strip()]


def sentence_rhythm_advisories(path: Path) -> list[str]:
    """Advisory-only hints for monotonous long-sentence runs.

    A run counts consecutive sentences inside one paragraph that each exceed
    ``LONG_SENTENCE_CHARS``. Sentences with ``LIST_DENSITY_COMMAS``+ 顿号 are
    deliberate density closers and reset the run. Never affects the exit code.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text()

    advisories: list[str] = []
    for para in _extract_natural_paragraphs(text):
        run = 0
        worst = 0
        for sentence in _split_sentences(para):
            if sentence.count("、") >= LIST_DENSITY_COMMAS:
                run = 0
                continue
            if len(sentence) > LONG_SENTENCE_CHARS:
                run += 1
                worst = max(worst, run)
            else:
                run = 0
        if worst >= LONG_SENTENCE_RUN:
            preview = para[:40]
            advisories.append(
                f"{path}: advisory: long_sentence_run: 段内连续 {worst} 句超过 "
                f"{LONG_SENTENCE_CHARS} 字（段落开头：{preview}…）。\n"
                "  hint: 只检查信息推进是否停滞；返工靠删冗余或拆信息，"
                "不要造表演性短拍句（顿号列举收束句已豁免）。仅提示，不计入退出码。"
            )
    return advisories


def _max_consecutive_single(paragraphs: list[str]) -> int:
    longest = 0
    current = 0
    for para in paragraphs:
        if _count_sentences(para) <= 1:
            current += 1
            if current > longest:
                longest = current
        else:
            current = 0
    return longest


def _resolve_profile(path: Path, requested: str) -> str:
    if requested != "auto":
        return requested
    parts = {p.lower() for p in path.parts}
    if "reports" in parts:
        return "report"
    if "articles" in parts:
        return "article"
    return "article"


def check_paragraph_health(
    path: Path,
    profile: str,
) -> list[str]:
    """Return a list of human-readable failure messages (empty if all checks pass)."""
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text()

    paragraphs = _extract_natural_paragraphs(text)
    total = len(paragraphs)
    if total == 0:
        return []

    config = PROFILE_DEFAULTS[profile]
    single = sum(1 for para in paragraphs if _count_sentences(para) <= 1)
    ratio = single / total
    max_run = _max_consecutive_single(paragraphs)
    failures: list[str] = []

    # Ratio gate (article profile only).
    if config["use_ratio"]:
        if total < config["min_sample"]:
            if single > config["small_allowance"]:
                failures.append(
                    f"{path}: paragraph_ratio: {single}/{total} 段是单句(={ratio:.0%})。"
                    f"小样本(<{config['min_sample']}段)允许最多 {config['small_allowance']} 个单句段，"
                    "已超出。\n"
                    "  fix: 合并普通判断为自然段，只保留章节首尾判断和锤子句独立成段。"
                )
        elif ratio > config["ratio"]:
            failures.append(
                f"{path}: paragraph_ratio: 全文 {total} 段中 {single} 段是单句"
                f"，占比 {ratio:.0%}，{profile} profile 要求 ≤ {config['ratio']:.0%}。\n"
                "  fix: 合并普通判断为自然段，只保留章节首句总判断、"
                "章节尾句冷锤句、全文核心锤子句独立成段。"
            )

    # Max-run gate (both profiles).
    if max_run > config["max_run"]:
        failures.append(
            f"{path}: paragraph_run: 出现 {max_run} 段连续单句段，"
            f"{profile} profile 要求 ≤ {config['max_run']}。\n"
            "  fix: 把连续的短判断合并成 1-2 段自然段；连续断点是公众号'提示卡'感的最强信号。"
        )

    return failures


def main() -> int:
    args = parse_args()
    total_issues = 0

    for raw_path in args.files:
        path = Path(raw_path)
        if not path.exists():
            print(f"{path}: missing file", file=sys.stderr)
            total_issues += 1
            continue

        findings = scan_file(path, args.ignore_blockquotes)
        for lineno, rule, line in findings:
            context = line[: args.max_context]
            print(f"{path}:{lineno}: {rule.code}: {context}")
            print(f"  reason: {rule.reason}")
            print(f"  fix: {rule.fix}")
        total_issues += len(findings)

        if args.paragraph_check:
            profile = _resolve_profile(path, args.profile)
            for failure in check_paragraph_health(path, profile):
                print(failure)
                total_issues += 1

        if args.advisory:
            for advisory in sentence_rhythm_advisories(path):
                print(advisory)

    if total_issues:
        print(f"\nstyle gate failed: {total_issues} issue(s) found", file=sys.stderr)
        return 1

    print("style gate passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
