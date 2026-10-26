"""Resume pipeline — mirrors tex_to_pdf.py but for resume_template.tex.

The header (name, phone, email, LinkedIn, website, additional link) and the
Education section are sourced only from chrome.storage
(randyPreferences.personalInformation) via the `preferences` dict. The
extension sends this on every envelope (see randy-backend.js:postRandyEnvelope),
and jobs_controller._normalize_preferences sanitizes it. There is no env or
hardcoded fallback: a blank field is left off the resume, so one user's details
can never leak into another's. PREFERENCE_RENDERERS fills the CONTACT and
EDUCATION slots.

Body sections are modular. The template marks each replaceable section with
%<<SLOT:NAME>> ... %<</SLOT:NAME>>, and SECTION_RENDERERS maps each slot to a
renderer that turns the portfolio (randyPortfolio from chrome.storage.local)
plus the resume specialist's structured output (TailoredResume) into LaTeX
using the template's exact macros. The LLM never writes LaTeX; the backend
does all escaping/formatting and caps the counts. Each renderer emits its
whole section, heading included; an empty string leaves the section off. The
template has no stock content, so nothing but the user's own data can appear.

To add a section: wrap it in slot markers in the template, add a field to
TailoredResume, and register a renderer in SECTION_RENDERERS.
"""

import json
import logging
import os
import re
from pathlib import Path

import requests
from dotenv import load_dotenv
from pydantic import BaseModel, Field, ValidationError

load_dotenv()

logger = logging.getLogger(__name__)

DEFAULT_LATEX_SERVICE_URL = "https://randy-the-otter-production.up.railway.app/compile"

try:
    from tools.file_channel import set_pending_file
except ImportError:
    from file_channel import set_pending_file

# ---------------------------------------------------------------------------
# LaTeX sanitizers (copied from tex_to_pdf.py for parity)
# ---------------------------------------------------------------------------

def escape_latex(text: str) -> str:
    """Escape LaTeX special characters so the value is safe inside \\newcommand."""
    if not isinstance(text, str):
        return ""
    replacements = {
        "&": "\\&",
        "%": "\\%",
        "$": "\\$",
        "#": "\\#",
        "_": "\\_",
        "{": r"\{",
        "}": r"\}",
        "~": r"\textasciitilde{}",
        "^": r"\textasciicircum{}",
    }
    for char, escaped in replacements.items():
        text = text.replace(char, escaped)
    return text


def normalize_unicode(text: str) -> str:
    if not isinstance(text, str):
        return ""
    replacements = {
        "\u2014": "---",
        "\u2013": "--",
        "\u2018": "`",
        "\u2019": "'",
        "\u201c": "``",
        "\u201d": "''",
    }
    for char, replacement in replacements.items():
        text = text.replace(char, replacement)
    return text


# ---------------------------------------------------------------------------
# Structured output contract — what the resume specialist returns
# ---------------------------------------------------------------------------

MAX_EXPERIENCE_ENTRIES = 4
MAX_PROJECT_ENTRIES = 3
MAX_BULLETS_PER_ENTRY = 3
MAX_SKILL_GROUPS = 5
MAX_SKILLS_PER_GROUP = 10
MAX_DERIVED_SKILLS = 20
MAX_ACHIEVEMENT_GROUPS = 5
MAX_EDUCATION_ENTRIES = 4


class TailoredEntry(BaseModel):
    """One selected portfolio entry with job-tailored bullets."""

    entry: int = Field(
        description="Entry number exactly as numbered by get_profile_summary within its section (starts at 1)"
    )
    bullets: list[str] = Field(
        default_factory=list,
        description=f"Exactly {MAX_BULLETS_PER_ENTRY} plain-text, job-tailored bullets (fewer only if the entry "
        "lacks facts), each 1-2 resume lines (about 20-35 words) using only facts from this entry. "
        "No LaTeX. Wrap at most one or two key phrases per bullet in **double asterisks** for bold.",
    )


class SkillGroup(BaseModel):
    """One Technical Skills row, e.g. Languages: Python, TypeScript."""

    category: str = Field(description="Short row label, e.g. 'Languages', 'Frameworks & Libraries', 'Cloud & Tools'")
    skills: list[str] = Field(
        description="Skills for this row, most job-relevant first. Only skills named in the profile summary."
    )


class TailoredResume(BaseModel):
    """Structured resume body; each field feeds one template slot."""

    experiences: list[TailoredEntry] = Field(
        default_factory=list,
        description=f"Most relevant experiences first, at most {MAX_EXPERIENCE_ENTRIES}. List order is resume order.",
    )
    projects: list[TailoredEntry] = Field(
        default_factory=list,
        description=f"Most relevant projects first, at most {MAX_PROJECT_ENTRIES}. List order is resume order.",
    )
    skills: list[SkillGroup] = Field(
        default_factory=list,
        description=f"Technical Skills rows, 2-{MAX_SKILL_GROUPS} groups, most relevant group first.",
    )


def coerce_tailored_resume(raw) -> TailoredResume:
    """Accept a TailoredResume, dict, or JSON string; invalid input -> empty."""
    if isinstance(raw, TailoredResume):
        return raw
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            logger.warning("Ignoring invalid tailored resume JSON: %s", raw[:200])
            return TailoredResume()
    if isinstance(raw, dict):
        try:
            return TailoredResume.model_validate(raw)
        except ValidationError:
            logger.warning("Ignoring tailored resume that failed validation", exc_info=True)
    return TailoredResume()


# ---------------------------------------------------------------------------
# Section renderers — portfolio + TailoredResume -> slot LaTeX
# ---------------------------------------------------------------------------

_BULLET_PREFIX_RE = re.compile(r"^\s*(?:[-*\u2022\u2013\u2014]+|\d+[.)])\s*")
_STACK_SPLIT_RE = re.compile(r"[,;|/\n]+")


def _portfolio_text(item, key, cap=1000):
    value = item.get(key)
    if not isinstance(value, str):
        return ""
    return value.strip()[:cap]


def _latex_text(value):
    """Escape a single-line portfolio field for use inside a LaTeX macro."""
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", normalize_unicode(value.strip()))
    return escape_latex(text)


def _latex_bullet(value):
    """Escape bullet text, converting optional **bold** markers to \\textbf."""
    text = _latex_text(value)
    return re.sub(r"\*\*(.+?)\*\*", lambda m: r"\textbf{" + m.group(1) + "}", text)


def _portfolio_items(portfolio, key):
    """Valid entries, in the order get_profile_summary numbers them.

    Entries need a title (skill and achievement groups need a category instead).
    """
    if not isinstance(portfolio, dict):
        return []
    items = portfolio.get(key)
    if not isinstance(items, list):
        return []
    required = "category" if key in ("skills", "achievements") else "title"
    return [item for item in items if isinstance(item, dict) and _portfolio_text(item, required, 300)]


def _split_description_bullets(description, limit=MAX_BULLETS_PER_ENTRY):
    """Turn a newline-delimited description into template bullet strings."""
    if not isinstance(description, str):
        return []
    normalized = description.replace("\r\n", "\n").replace("\r", "\n")
    bullets = []
    for line in normalized.split("\n"):
        line = _BULLET_PREFIX_RE.sub("", line).strip()
        if not line:
            continue
        bullets.append(line)
        if len(bullets) >= limit:
            break
    return bullets


def _select_entries(items, tailored_entries, limit):
    """Return [(item, bullets)] in the agent's order, else the first `limit` stored.

    A selected entry with no usable bullets falls back to its description lines.
    Unknown/duplicate entry numbers are ignored.
    """
    selected = []
    seen = set()
    for tailored in tailored_entries:
        position = tailored.entry - 1
        if not 0 <= position < len(items) or position in seen:
            continue
        seen.add(position)
        bullets = [b.strip() for b in tailored.bullets if isinstance(b, str) and b.strip()]
        selected.append((items[position], bullets))
        if len(selected) >= limit:
            break
    if not selected:
        selected = [(item, []) for item in items[:limit]]
    return [
        (item, bullets or _split_description_bullets(_portfolio_text(item, "description", 10000)))
        for item, bullets in selected
    ]


def _item_list(bullets):
    lines = ["      \\resumeItemListStart"]
    lines += ["        \\resumeItem{" + _latex_bullet(b) + "}" for b in bullets[:MAX_BULLETS_PER_ENTRY]]
    lines.append("      \\resumeItemListEnd")
    return "\n".join(lines)


def _subheading_section(heading, blocks):
    return (
        f"\\section{{{heading}}}\n"
        "  \\resumeSubHeadingListStart\n"
        + "\n\n".join(blocks)
        + "\n  \\resumeSubHeadingListEnd"
    )


def _render_experience(portfolio, tailored):
    items = _portfolio_items(portfolio, "experiences")
    if not items:
        return ""
    blocks = []
    for experience, bullets in _select_entries(items, tailored.experiences, MAX_EXPERIENCE_ENTRIES):
        title = _latex_text(_portfolio_text(experience, "title", 300))
        date = _latex_text(_portfolio_text(experience, "date", 200))
        organization = _latex_text(_portfolio_text(experience, "organization", 300))
        blocks.append(
            "    \\resumeSubheading\n"
            f"      {{{title}}}{{{date}}}\n"
            f"      {{{organization}}}{{}}\n"
            f"{_item_list(bullets)}"
        )
    return _subheading_section("Experience", blocks)


def _render_projects(portfolio, tailored):
    items = _portfolio_items(portfolio, "projects")
    if not items:
        return ""
    blocks = []
    for project, bullets in _select_entries(items, tailored.projects, MAX_PROJECT_ENTRIES):
        title = _latex_text(_portfolio_text(project, "title", 300))
        stack = _latex_text(_portfolio_text(project, "stack", 500))
        heading = f"\\textbf{{{title}}}"
        if stack:
            heading += f" $|$ \\emph{{{stack}}}"
        blocks.append(
            "    \\resumeProjectHeading\n"
            f"      {{{heading}}}{{}}\n"
            f"{_item_list(bullets)}"
        )
    return _subheading_section("Projects", blocks)


def _skill_norm(text):
    """Lowercase, keep skill-ish chars (c++, c#, node.js), collapse the rest to spaces."""
    text = re.sub(r"[^a-z0-9+#.]+", " ", text.lower())
    text = re.sub(r"\.(?=\s|$)", " ", text)
    return " ".join(text.split())


def _portfolio_corpus(portfolio):
    """Every portfolio string, normalized — the ground truth for skill names."""
    if not isinstance(portfolio, dict):
        return ""
    parts = []
    for key in ("experiences", "projects", "coursework", "skills"):
        for item in _portfolio_items(portfolio, key):
            parts += [v for v in item.values() if isinstance(v, str)]
    return _skill_norm(" ".join(parts))


def _grounded_skill_groups(portfolio, groups):
    """Drop skills the portfolio never mentions (whole-word match) and empty groups."""
    corpus = f" {_portfolio_corpus(portfolio)} "
    if not corpus.strip():
        return []
    grounded = []
    used = set()
    for group in groups:
        category = group.category.strip() if isinstance(group.category, str) else ""
        if not category:
            continue
        skills = []
        for skill in group.skills:
            if not isinstance(skill, str):
                continue
            norm = _skill_norm(skill)
            if not norm or norm in used or f" {norm} " not in corpus:
                continue
            used.add(norm)
            skills.append(skill.strip())
            if len(skills) >= MAX_SKILLS_PER_GROUP:
                break
        if skills:
            grounded.append((category, skills))
        if len(grounded) >= MAX_SKILL_GROUPS:
            break
    return grounded


def _split_skills(text, used):
    """Split a comma/stack-style list into unique skill names (dedupe via `used`)."""
    skills = []
    for skill in _STACK_SPLIT_RE.split(text):
        skill = skill.strip()
        norm = _skill_norm(skill)
        if norm and norm not in used:
            used.add(norm)
            skills.append(skill)
    return skills


def _user_skill_groups(portfolio):
    """Fallback 1: the skill groups the user entered in settings, as stored."""
    groups = []
    used = set()
    for item in _portfolio_items(portfolio, "skills"):
        skills = _split_skills(_portfolio_text(item, "skills", 1000), used)
        if skills:
            groups.append((_portfolio_text(item, "category", 200), skills[:MAX_SKILLS_PER_GROUP]))
        if len(groups) >= MAX_SKILL_GROUPS:
            break
    return groups


def _derived_skill_groups(portfolio):
    """Fallback 2: one row built from project/coursework `stack` fields."""
    skills = []
    used = set()
    for key in ("projects", "coursework"):
        for item in _portfolio_items(portfolio, key):
            skills += _split_skills(_portfolio_text(item, "stack", 500), used)
    if not skills:
        return []
    return [("Technologies", skills[:MAX_DERIVED_SKILLS])]


def _render_skills(portfolio, tailored):
    groups = (
        _grounded_skill_groups(portfolio, tailored.skills)
        or _user_skill_groups(portfolio)
        or _derived_skill_groups(portfolio)
    )
    if not groups:
        return ""
    rows = "\n".join(
        f"     \\textbf{{{_latex_text(category)}}}: {', '.join(_latex_text(s) for s in skills)} \\\\"
        for category, skills in groups
    )
    return (
        "\\section{Technical Skills}\n"
        " \\begin{itemize}[leftmargin=0.15in, label={}]\n"
        "    \\small{\\item{\n"
        + rows
        + "\n    }}\n"
        " \\end{itemize}"
    )


def _render_achievements(portfolio, _tailored):
    """Whole Achievements section from the user's own entries, verbatim.

    No LLM rewriting: with no entries the slot stays empty and the section
    is omitted from the resume.
    """
    rows = []
    for item in _portfolio_items(portfolio, "achievements")[:MAX_ACHIEVEMENT_GROUPS]:
        details = [
            _latex_text(_BULLET_PREFIX_RE.sub("", line))
            for line in _portfolio_text(item, "details", 2000).splitlines()
            if _BULLET_PREFIX_RE.sub("", line).strip()
        ]
        if details:
            category = _latex_text(_portfolio_text(item, "category", 200))
            rows.append(f"    \\textbf{{{category}}}: {', '.join(details)} \\\\")
    if not rows:
        return ""
    return (
        "\\section{Achievements}\n"
        "\\begin{itemize}[leftmargin=0.15in, label={}]\n"
        "    \\small{\\item{\n"
        + "\n".join(rows)
        + "\n    }}\n"
        "\\end{itemize}"
    )


# Slot name in resume_template.tex -> renderer(portfolio, TailoredResume) -> LaTeX ("" omits it)
SECTION_RENDERERS = {
    "EXPERIENCE": _render_experience,
    "PROJECTS": _render_projects,
    "SKILLS": _render_skills,
    "ACHIEVEMENTS": _render_achievements,
}


def _fill_slot(tex: str, name: str, body: str) -> str:
    """Replace the stock content (possibly empty) between %<<SLOT:name>> and %<</SLOT:name>>."""
    pattern = re.compile(rf"(%<<SLOT:{re.escape(name)}>>\n).*?(%<</SLOT:{re.escape(name)}>>)", re.DOTALL)
    filled = body + "\n" if body else ""
    tex, n = pattern.subn(lambda m: m.group(1) + filled + m.group(2), tex, count=1)
    if n == 0:
        logger.warning("Resume template has no %%<<SLOT:%s>> marker; section left as-is", name)
    return tex


# ---------------------------------------------------------------------------
# Template / output locations
# ---------------------------------------------------------------------------

RESUME_TEX_FILE = "resume_template.tex"
# Mirror tex_to_pdf.OUTPUT_DIR but resolve relative to project so it works
# regardless of CWD (backend/ is the package root).
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pdf_out")
TEMPLATE_PATH = Path(__file__).with_name(RESUME_TEX_FILE)


def _personal_information(preferences):
    if isinstance(preferences, dict):
        personal = preferences.get("personalInformation")
        if isinstance(personal, dict):
            return personal
    return {}


def _href_target(url: str) -> str:
    """Make a user-entered URL safe as the first argument of \\href.

    hyperref takes # and ~ raw but not a bare %, and stray braces/backslashes
    would unbalance the macro, so those are stripped. Bare domains get https://.
    """
    target = re.sub(r"[\s{}\\]", "", normalize_unicode(url))
    if not target:
        return ""
    if not re.match(r"^(https?|mailto):", target, re.IGNORECASE):
        target = "https://" + target
    return target.replace("%", r"\%").replace("#", r"\#")


def _display_from_url(url: str) -> str:
    """Derive a display like linkedin.com/in/... from a full https URL."""
    u = re.sub(r"^https?://", "", url.strip(), flags=re.IGNORECASE)
    u = re.sub(r"^www\.", "", u, flags=re.IGNORECASE)
    return u.rstrip("/")


def _render_contact(preferences):
    """Contact line under the name: phone | email | LinkedIn | website | additional link.

    Blank fields are omitted; with none at all the name stands alone.
    """
    personal = _personal_information(preferences)
    items = []
    phone = _latex_text(_portfolio_text(personal, "phoneNumber", 300))
    if phone:
        items.append(phone)
    email = _portfolio_text(personal, "email", 300)
    if email:
        items.append(r"\href{" + _href_target("mailto:" + email) + "}{" + _latex_text(email) + "}")
    for key in ("linkedinUrl", "websiteUrl", "additionalUrl"):
        url = _portfolio_text(personal, key, 500)
        target = _href_target(url)
        display = _latex_text(_display_from_url(url))
        if target and display:
            items.append(r"\href{" + target + "}{" + display + "}")
    if not items:
        return ""
    return "    \\\\ \\vspace{1pt}\n    " + " $|$\n    ".join(items)


def _render_education(preferences):
    """Education section from personalInformation.education; omitted when empty."""
    personal = _personal_information(preferences)
    entries = personal.get("education") if isinstance(personal.get("education"), list) else []
    entries = [e for e in entries if isinstance(e, dict) and _portfolio_text(e, "school", 300)]
    if not entries:
        return ""
    blocks = []
    for entry in entries[:MAX_EDUCATION_ENTRIES]:
        school = _latex_text(_portfolio_text(entry, "school", 300))
        location = _latex_text(_portfolio_text(entry, "location", 300))
        gpa = _latex_text(_portfolio_text(entry, "gpa", 50))
        degree = _latex_text(_portfolio_text(entry, "degree", 300))
        graduation = _latex_text(_portfolio_text(entry, "graduationDate", 100))
        heading = f"{school}, {location}" if location else school
        blocks.append(
            "    \\resumeSubheading\n"
            "      {" + heading + "}{" + (f"GPA: {gpa}" if gpa else "") + "}\n"
            "      {" + degree + "}{" + graduation + "}"
        )
    return (
        "\\section{Education}\n"
        "  \\resumeSubHeadingListStart\n"
        + "\n".join(blocks)
        + "\n  \\resumeSubHeadingListEnd"
    )


# Slot name in resume_template.tex -> renderer(preferences) -> LaTeX ("" omits it)
PREFERENCE_RENDERERS = {
    "CONTACT": _render_contact,
    "EDUCATION": _render_education,
}


# ---------------------------------------------------------------------------
# Replacements builder — chrome.storage -> \\newcommand values
# ---------------------------------------------------------------------------

def build_resume_replacements(preferences=None) -> dict:
    """Build the \\newcommand replacement dict (the name) from chrome.storage preferences.

    `preferences` is the normalized shape from jobs_controller._normalize_preferences
    (i.e. {"personalInformation": {"firstName": ..., ...}}). Blank fields stay
    blank instead of falling back to defaults. Contact links and education are
    rendered into template slots by PREFERENCE_RENDERERS.
    """
    personal = _personal_information(preferences)
    first_name = _portfolio_text(personal, "firstName", 300)
    last_name = _portfolio_text(personal, "lastName", 300)
    raw = {
        "FullName": f"{first_name} {last_name}".strip(),
        "FirstName": first_name,
        "LastName": last_name,
    }
    return {k: _latex_text(v) for k, v in raw.items()}


# ---------------------------------------------------------------------------
# Low-level helper — kept for backwards compat (direct file -> file)
# ---------------------------------------------------------------------------

def customize_resume(template_path, output_path, replacements):
    """Regex-replace \\newcommand{\\KEY}{old} -> \\newcommand{\\KEY}{value}.

    This is the original API; new code should prefer generate_resume_tex /
    resume_pipeline which source replacements from chrome.storage.
    """
    tex = Path(template_path).read_text(encoding="utf-8")
    tex = _apply_replacements(tex, replacements)
    Path(output_path).write_text(tex, encoding="utf-8")


# ---------------------------------------------------------------------------
# Dynamic generation — mirrors tex_to_pdf.generate_cover_letter
# ---------------------------------------------------------------------------

def _apply_replacements(tex: str, replacements: dict) -> str:
    for key, value in replacements.items():
        pattern = rf"(\\newcommand{{\\{re.escape(key)}}}{{)[^}}]*(}})"
        # Use function to avoid backslash-escape interpretation in replacement (\%, \&, etc.)
        def _repl(m, _v=value):
            return m.group(1) + _v + m.group(2)
        tex = re.sub(pattern, _repl, tex)
    return tex


def generate_resume_tex(
    preferences=None,
    portfolio=None,
    tailored=None,
    template_path: str | Path | None = None,
) -> str:
    """Build the filled-in resume tex string.

    Header fields come from chrome.storage (preferences). Every slot in
    SECTION_RENDERERS is rendered from the portfolio plus `tailored` (a
    TailoredResume, dict, or JSON string from the resume specialist). With no
    tailoring, the first stored entries and their description lines are used;
    a section with nothing to show is left off.

    Mirrors tex_to_pdf.generate_cover_letter: never crashes on None/empty
    preferences, always returns a compilable string.
    """
    tpl = Path(template_path) if template_path else TEMPLATE_PATH
    # Fallback to cwd-relative like tex_to_pdf does if file not found
    if not tpl.exists():
        alt = Path(os.getcwd()) / "tools" / RESUME_TEX_FILE
        if alt.exists():
            tpl = alt
    tex = tpl.read_text(encoding="utf-8")

    tex = _apply_replacements(tex, build_resume_replacements(preferences))
    for slot, render in PREFERENCE_RENDERERS.items():
        tex = _fill_slot(tex, slot, render(preferences))

    tailored = coerce_tailored_resume(tailored)
    for slot, render in SECTION_RENDERERS.items():
        tex = _fill_slot(tex, slot, render(portfolio, tailored))
    return tex


def compile_resume_tex(filestring: str, identifier: str = "resume") -> str | None:
    """Compile resume tex via remote LaTeX service and save the returned PDF.

    Strictly remote — no local pdflatex fallback. Mirrors tex_to_pdf.compile_tex.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    safe_id = "".join(c for c in str(identifier) if c not in '/\\"').strip() or "resume"
    base_name = f"{safe_id}_resume"
    pdf_path = os.path.join(OUTPUT_DIR, f"{base_name}.pdf")

    token = os.getenv("LATEX_SERVICE_TOKEN")
    if not token or not token.strip():
        logger.error("LATEX_SERVICE_TOKEN not set — cannot compile resume")
        print("Resume compilation failed: LATEX_SERVICE_TOKEN not set")
        return None

    url = os.getenv("LATEX_SERVICE_URL", DEFAULT_LATEX_SERVICE_URL).strip() or DEFAULT_LATEX_SERVICE_URL
    payload = json.dumps({"tex": filestring})

    try:
        resp = requests.post(
            url,
            data=payload,
            headers={
                "Authorization": f"Bearer {token.strip()}",
                "Content-Type": "application/json",
            },
            timeout=700,
        )
    except requests.RequestException as e:
        logger.exception("LaTeX service request failed for %s: %s", base_name, e)
        print(f"Resume compilation failed: LaTeX service request error: {e}")
        return None

    if resp.status_code != 200:
        detail = resp.text[:5000] if resp.text else f"HTTP {resp.status_code}"
        logger.error("LaTeX service error %s for %s: %s", resp.status_code, base_name, detail[:500])
        print(f"Resume compilation failed. Service returned {resp.status_code}:")
        print(detail[-2000:])
        return None

    if not resp.content or not resp.content.startswith(b"%PDF"):
        logger.error("LaTeX service returned non-PDF for %s (len=%s, prefix=%r)", base_name, len(resp.content), resp.content[:20])
        print("Resume compilation failed: service did not return a PDF")
        return None

    try:
        with open(pdf_path, "wb") as f:
            f.write(resp.content)
    except Exception as e:
        logger.exception("Failed to write PDF %s: %s", pdf_path, e)
        print(f"Resume compilation failed: could not write PDF: {e}")
        return None

    print(f"Compiled resume via remote: {pdf_path}")
    return pdf_path


def resume_pipeline(
    preferences=None,
    portfolio=None,
    tailored=None,
    identifier: str = "resume",
    template_path: str | Path | None = None,
) -> str | None:
    """One-call pipeline: preferences + portfolio + tailoring -> tex string -> PDF path."""
    filled = generate_resume_tex(
        preferences=preferences,
        portfolio=portfolio,
        tailored=tailored,
        template_path=template_path,
    )
    return compile_resume_tex(filled, identifier=identifier)


def build_and_stage_resume(
    tailored=None,
    preferences=None,
    portfolio=None,
    identifier: str | None = None,
    session_id: str | None = None,
) -> bool:
    """Compile the resume and hand the PDF to the session file channel.

    resumes._generate picks it up via pop_pending_file. Returns True when a
    PDF was produced.
    """
    if not isinstance(identifier, str) or not identifier.strip():
        identifier = "resume"
    output_path = resume_pipeline(
        preferences=preferences,
        portfolio=portfolio,
        tailored=tailored,
        identifier=identifier.strip(),
    )
    if not output_path or not os.path.exists(output_path):
        return False
    safe_id = "".join(c for c in identifier if c not in '/\\"').strip() or "resume"
    filename = f"{safe_id}_resume.pdf".replace(" ", "_")
    set_pending_file(output_path, filename=filename, session_id=session_id)
    return True


# ---------------------------------------------------------------------------
# Backwards-compat demo — only runs when executed directly, not on import.
# (Previous version executed customize_resume unconditionally at import time.)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Demo with the chrome.storage preferences shape.
    demo_preferences = {
        "personalInformation": {
            "firstName": os.getenv("FIRST_NAME", "Ada"),
            "lastName": os.getenv("LAST_NAME", "Lovelace"),
            "email": os.getenv("EMAIL", "ada@example.com"),
            "phoneNumber": os.getenv("PHONE_NUMBER", ""),
            "linkedinUrl": "https://linkedin.com/in/ada",
            "websiteUrl": "https://ada.example.com",
            "additionalUrl": "https://github.com/ada",
            "education": [{
                "school": "University of London",
                "location": "London, UK",
                "degree": "B.S. in Mathematics",
                "gpa": "4.0",
                "graduationDate": "May 1835",
            }],
        }
    }
    tex_str = generate_resume_tex(preferences=demo_preferences)
    # Write a preview tex next to the template (not pdf_out) for manual inspection
    preview = Path(__file__).with_name("resume_preview.tex")
    preview.write_text(tex_str, encoding="utf-8")
    print(f"Wrote preview: {preview}")
    # Optionally compile via remote service (requires LATEX_SERVICE_TOKEN)
    pdf = compile_resume_tex(tex_str, identifier="preview")
    print(f"Preview PDF: {pdf}")
