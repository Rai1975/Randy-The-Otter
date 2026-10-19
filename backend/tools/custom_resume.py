"""Resume pipeline — mirrors tex_to_pdf.py but for resume_template.tex.

Header fields (FullName, Email, URLs, etc.) are sourced from chrome.storage
(randyPreferences.personalInformation) via `preferences` dict. The extension
sends this on every envelope (see randy-backend.js:postRandyEnvelope), and
jobs_controller._normalize_preferences sanitizes it. When called outside the
extension flow, falls back to os.getenv / hardcoded defaults (same pattern as
tex_to_pdf.generate_cover_letter:51).

Experience/Projects: the portfolio (randyPortfolio from chrome.storage.local)
controls the pool of entries, rendered with the template's exact macros. The
resume specialist (resume_agent.py) selects the most relevant entries (at most
4 experiences, 3 projects) and supplies job-tailored bullet TEXT as JSON keyed
by portfolio index; key order sets the resume order. The backend does all
LaTeX escaping/formatting and caps the counts. When a selected entry has no
rewritten bullets, its newline-delimited description lines become bullets. With
no selection, the first entries in stored order are used; an empty portfolio
falls back to legacy tailored LaTeX (if any), then to the template's stock
sections. Technical Skills stays static.
"""

import json
import logging
import os
import re
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

DEFAULT_LATEX_SERVICE_URL = "https://randy-the-otter-production.up.railway.app/compile"

try:
    from tools.file_channel import set_pending_file
except ImportError:
    from file_channel import set_pending_file

try:
    from strands import tool
except ImportError:
    # fallback no-op decorator when strands not installed (tests)
    def tool(*_a, **_kw):
        def deco(f):
            return f
        return deco

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
# Portfolio-driven Experience / Projects sections
# ---------------------------------------------------------------------------

MAX_EXPERIENCE_ENTRIES = 4
MAX_PROJECT_ENTRIES = 3
MAX_BULLETS_PER_ENTRY = 4

_BULLET_PREFIX_RE = re.compile(r"^\s*(?:[-*\u2022\u2013\u2014]+|\d+[.)])\s*")


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


def _portfolio_indexed(portfolio, key):
    """Return [(stored_index, item)] for valid entries (title required)."""
    if not isinstance(portfolio, dict):
        return []
    items = portfolio.get(key)
    if not isinstance(items, list):
        return []
    indexed = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if not _portfolio_text(item, "title", 300):
            continue
        indexed.append((index, item))
    return indexed


def _select_entries(indexed, order, limit):
    """Pick entries by an explicit index order, else the first `limit` stored.

    `order` is the list of 0-based portfolio indices the agent chose (most
    relevant first). Only valid indices are used; when `order` is empty the
    stored order is used as a fallback.
    """
    if order:
        by_index = {index: item for index, item in indexed}
        selected = []
        seen = set()
        for index in order:
            if index in by_index and index not in seen:
                selected.append((index, by_index[index]))
                seen.add(index)
            if len(selected) >= limit:
                break
        if selected:
            return selected
    return indexed[:limit]


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


def _parse_bullet_rewrites(raw):
    """Parse LLM bullet rewrites into {portfolio_index: [bullet, ...]}.

    Accepts a JSON string or an already-parsed dict/list. Supported shapes:
      {"0": ["bullet", "bullet"], "1": ["bullet"]}
      [{"index": 0, "bullets": ["bullet"]}]
      [["bullet", "bullet"], ["bullet"]]
    Invalid input is ignored so the description-derived bullets are used.
    """
    if not raw:
        return {}

    parsed = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            logger.warning("Ignoring invalid resume bullet JSON: %s", raw[:200])
            return {}

    rewrites = {}

    def _add(index, bullets):
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return
        if idx < 0:
            return
        if isinstance(bullets, str):
            bullets = [bullets]
        if not isinstance(bullets, list):
            return
        cleaned = [b.strip() for b in bullets if isinstance(b, str) and b.strip()]
        if cleaned:
            rewrites[idx] = cleaned[:MAX_BULLETS_PER_ENTRY]

    if isinstance(parsed, dict):
        for key, value in parsed.items():
            if isinstance(value, dict):
                value = value.get("bullets")
            _add(key, value)
    elif isinstance(parsed, list):
        for pos, item in enumerate(parsed):
            if isinstance(item, dict):
                _add(item.get("index", item.get("id", pos)), item.get("bullets", item.get("items")))
            elif isinstance(item, list):
                _add(pos, item)
            elif isinstance(item, str):
                _add(pos, [item])

    return rewrites


def _build_experience_section(portfolio, rewritten_bullets=None):
    """Build the Experience section body using the template's exact macros."""
    indexed = _portfolio_indexed(portfolio, "experiences")
    if not indexed:
        return None

    rewrites = _parse_bullet_rewrites(rewritten_bullets)
    entries = _select_entries(indexed, list(rewrites), MAX_EXPERIENCE_ENTRIES)
    blocks = []
    for index, experience in entries:
        title = _latex_text(_portfolio_text(experience, "title", 300))
        date = _latex_text(_portfolio_text(experience, "date", 200))
        organization = _latex_text(_portfolio_text(experience, "organization", 300))
        bullets = rewrites.get(index)
        if not bullets:
            bullets = _split_description_bullets(_portfolio_text(experience, "description", 10000))
        bullet_lines = "\n".join(
            "        \\resumeItem{" + _latex_bullet(bullet) + "}"
            for bullet in bullets[:MAX_BULLETS_PER_ENTRY]
        )
        item_list = "      \\resumeItemListStart"
        if bullet_lines:
            item_list += "\n" + bullet_lines
        item_list += "\n      \\resumeItemListEnd"
        blocks.append(
            "    \\resumeSubheading\n"
            f"      {{{title}}}{{{date}}}\n"
            f"      {{{organization}}}{{}}\n"
            f"{item_list}"
        )
    return "\n\n".join(blocks)


def _build_projects_section(portfolio, rewritten_bullets=None):
    """Build the Projects section body using the template's exact macros."""
    indexed = _portfolio_indexed(portfolio, "projects")
    if not indexed:
        return None

    rewrites = _parse_bullet_rewrites(rewritten_bullets)
    entries = _select_entries(indexed, list(rewrites), MAX_PROJECT_ENTRIES)
    blocks = []
    for index, project in entries:
        title = _latex_text(_portfolio_text(project, "title", 300))
        stack = _latex_text(_portfolio_text(project, "stack", 500))
        heading = f"\\textbf{{{title}}}"
        if stack:
            heading += f" $|$ \\emph{{{stack}}}"
        bullets = rewrites.get(index)
        if not bullets:
            bullets = _split_description_bullets(_portfolio_text(project, "description", 10000))
        bullet_lines = "\n".join(
            "        \\resumeItem{" + _latex_bullet(bullet) + "}"
            for bullet in bullets[:MAX_BULLETS_PER_ENTRY]
        )
        item_list = "      \\resumeItemListStart"
        if bullet_lines:
            item_list += "\n" + bullet_lines
        item_list += "\n      \\resumeItemListEnd"
        blocks.append(
            "    \\resumeProjectHeading\n"
            f"      {{{heading}}}{{}}\n"
            f"{item_list}"
        )
    return "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Template / output locations
# ---------------------------------------------------------------------------

RESUME_TEX_FILE = "resume_template.tex"
# Mirror tex_to_pdf.OUTPUT_DIR but resolve relative to project so it works
# regardless of CWD (backend/ is the package root).
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pdf_out")
TEMPLATE_PATH = Path(__file__).with_name(RESUME_TEX_FILE)


def _display_from_url(url: str, fallback: str) -> str:
    """Derive a display like linkedin.com/in/... from a full https URL."""
    if isinstance(url, str) and url.strip():
        u = url.strip()
        # strip scheme
        u = re.sub(r"^https?://", "", u)
        u = re.sub(r"^www\.", "", u)
        u = u.rstrip("/")
        return u or fallback
    return fallback


def _coalesce(*vals, default=""):
    for v in vals:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return default


# ---------------------------------------------------------------------------
# Replacements builder — chrome.storage -> \\newcommand values
# ---------------------------------------------------------------------------

def build_resume_replacements(preferences=None) -> dict:
    """Build the \\newcommand replacement dict from chrome.storage preferences.

    `preferences` is the normalized shape from jobs_controller._normalize_preferences
    (i.e. {"personalInformation": {"firstName": ..., "email": ..., ...}}).
    When None/empty or when a field is blank, falls back to os.getenv then to
    the existing hardcoded defaults so the template always compiles.

    Static academic/GitHub fields are intentionally NOT sourced from storage
    (user asked to keep them static for now).
    """
    personal = {}
    if isinstance(preferences, dict):
        pi = preferences.get("personalInformation")
        if isinstance(pi, dict):
            personal = pi

    first_name = _coalesce(personal.get("firstName"), os.getenv("FIRST_NAME"), "Raihan")
    last_name = _coalesce(personal.get("lastName"), os.getenv("LAST_NAME"), "Rafeek")
    full_name = f"{first_name} {last_name}".strip() or "Raihan Rafeek"

    email = _coalesce(personal.get("email"), os.getenv("EMAIL"), "rafeekrn@mail.uc.edu")
    linkedin_url = _coalesce(personal.get("linkedinUrl"), os.getenv("LINKEDIN_URL"), "https://linkedin.com/in/raihan-rafeek")
    portfolio_url = _coalesce(personal.get("websiteUrl"), os.getenv("PORTFOLIO_URL"), "https://www.rai-1975.com")

    # GitHub stays static as requested (no personalInformation field for it yet)
    github_url = _coalesce(os.getenv("GITHUB_URL"), "https://github.com/rai1975")
    github_display = _coalesce(os.getenv("GITHUB_DISPLAY"), "github.com/rai1975")

    linkedin_display = _display_from_url(linkedin_url, "linkedin.com/in/raihan-rafeek")
    portfolio_display = _display_from_url(portfolio_url, "rai-1975.com")

    # Academic — static, env-overridable
    university = _coalesce(os.getenv("UNIVERSITY"), "University of Cincinnati")
    university_location = _coalesce(os.getenv("UNIVERSITY_LOCATION"), "Cincinnati, OH")
    degree = _coalesce(os.getenv("DEGREE"), "Bachelor of Science in Computer Science")
    gpa = _coalesce(os.getenv("GPA"), "3.97")
    graduation = _coalesce(os.getenv("GRADUATION_DATE"), "May 2027")

    # Escape display values but keep raw URLs intact for \\href (hyperref handles them).
    # For \\newcommand args we still escape &,%,$,#, but NOT _ in URLs would break
    # hyperref if escaped, so leave URLs raw; escape the rest.
    raw = {
        "FullName": full_name,
        "FirstName": first_name,
        "LastName": last_name,
        "ResumeEmail": email,
        "LinkedInURL": linkedin_url,
        "LinkedInDisplay": linkedin_display,
        "GitHubURL": github_url,
        "GitHubDisplay": github_display,
        "PortfolioURL": portfolio_url,
        "PortfolioDisplay": portfolio_display,
        "University": university,
        "UniversityLocation": university_location,
        "Degree": degree,
        "GPA": gpa,
        "GraduationDate": graduation,
    }

    # Apply escaping: URLs stay raw, everything else escaped+normalized.
    url_keys = {"LinkedInURL", "GitHubURL", "PortfolioURL"}
    escaped = {}
    for k, v in raw.items():
        v = normalize_unicode(v)
        if k in url_keys:
            escaped[k] = v  # hyperref URL — don't escape
        else:
            escaped[k] = escape_latex(v)
    return escaped


# ---------------------------------------------------------------------------
# Low-level helper — kept for backwards compat (direct file -> file)
# ---------------------------------------------------------------------------

def customize_resume(template_path, output_path, replacements):
    """Regex-replace \\newcommand{\\KEY}{old} -> \\newcommand{\\KEY}{value}.

    This is the original API; new code should prefer generate_resume_tex /
    resume_pipeline which source replacements from chrome.storage.
    """
    tex = Path(template_path).read_text(encoding="utf-8")
    for key, value in replacements.items():
        pattern = rf"(\\newcommand{{\\{re.escape(key)}}}{{)[^}}]*(}})"
        def _repl(m, _v=value):
            return m.group(1) + _v + m.group(2)
        tex = re.sub(pattern, _repl, tex)
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


def _inject_tailored_sections(tex: str, tailored_experience=None, tailored_projects=None) -> str:
    """If agent provides LaTeX fragments, splice them into the template.

    The agent is expected to supply ready-to-compile LaTeX (e.g. a sequence of
    \\resumeSubheading / \\resumeItem blocks). We normalize unicode but do NOT
    escape, because the fragment is already LaTeX. When None/empty, the stock
    section is left untouched.

    Technical Skills is intentionally never modified (static forever) — the
    template's stock Skills block is always kept.
    """
    # Normalize but don't escape — fragment is LaTeX already. Preserve the
    # fragment's first-line indentation; only trim leading/trailing blank lines.
    def _clean(fragment):
        if not isinstance(fragment, str) or not fragment.strip():
            return None
        return normalize_unicode(fragment.strip("\r\n"))

    # Experience: replace content between %-----------EXPERIENCE----------- and %-----------PROJECTS-----------
    exp = _clean(tailored_experience)
    if exp is not None:
        pattern = r"(\\section\{Experience\}.*?\\resumeSubHeadingListStart)(.*?)(\\resumeSubHeadingListEnd)(\s*%-----------PROJECTS-----------)"
        def _exp_repl(m, _exp=exp):
            return m.group(1) + "\n" + _exp + "\n" + m.group(3) + m.group(4)
        tex, n = re.subn(pattern, _exp_repl, tex, flags=re.DOTALL)
        if n == 0:
            tex = tex.replace("%-----------EXPERIENCE-----------", f"%-----------EXPERIENCE-----------\n% --- TAILORED EXPERIENCE OVERRIDE ---\n{exp}\n")

    proj = _clean(tailored_projects)
    if proj is not None:
        pattern = r"(\\section\{Projects\}.*?\\resumeSubHeadingListStart)(.*?)(\\resumeSubHeadingListEnd)(\s*%-----------SKILLS-----------)"
        def _proj_repl(m, _proj=proj):
            return m.group(1) + "\n" + _proj + "\n" + m.group(3) + m.group(4)
        tex, n = re.subn(pattern, _proj_repl, tex, flags=re.DOTALL)
        if n == 0:
            tex = tex.replace("%-----------PROJECTS-----------", f"%-----------PROJECTS-----------\n% --- TAILORED PROJECTS OVERRIDE ---\n{proj}\n")

    return tex


def generate_resume_tex(
    preferences=None,
    portfolio=None,
    experience_bullets=None,
    project_bullets=None,
    tailored_experience_latex=None,
    tailored_projects_latex=None,
    template_path: str | Path | None = None,
) -> str:
    """Build the filled-in resume tex string.

    Header fields come from chrome.storage (preferences). Experience and
    Projects are built from the portfolio; the resume agent selects up to 4
    experiences and 3 projects (most relevant first) and supplies rewritten
    bullet text as JSON keyed by portfolio index, but never LaTeX. With no
    selection the first stored entries are used; when the portfolio has no
    entries, legacy tailored LaTeX fragments are used as a fallback, otherwise
    the template's stock sections remain untouched. Technical Skills is always
    the template's static block.

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

    replacements = build_resume_replacements(preferences)
    tex = _apply_replacements(tex, replacements)

    portfolio_experience = _build_experience_section(portfolio, experience_bullets)
    portfolio_projects = _build_projects_section(portfolio, project_bullets)
    tex = _inject_tailored_sections(
        tex,
        tailored_experience=(
            portfolio_experience if portfolio_experience is not None else tailored_experience_latex
        ),
        tailored_projects=(
            portfolio_projects if portfolio_projects is not None else tailored_projects_latex
        ),
    )
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
            timeout=400,  # 5 minutes — covers cold start
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
    experience_bullets=None,
    project_bullets=None,
    tailored_experience_latex=None,
    tailored_projects_latex=None,
    identifier: str = "resume",
    template_path: str | Path | None = None,
) -> str | None:
    """One-call pipeline: preferences + portfolio -> tex string -> PDF path.

    Technical Skills is static — no tailored_skills arg forwarded.
    """
    filled = generate_resume_tex(
        preferences=preferences,
        portfolio=portfolio,
        experience_bullets=experience_bullets,
        project_bullets=project_bullets,
        tailored_experience_latex=tailored_experience_latex,
        tailored_projects_latex=tailored_projects_latex,
        template_path=template_path,
    )
    return compile_resume_tex(filled, identifier=identifier)


# ---------------------------------------------------------------------------
# Agent tool — session-aware, mirrors get_user_profile.generate_cover_letter
# ---------------------------------------------------------------------------

@tool(context=True)
def generate_resume(
    experience_bullets: str = None,
    project_bullets: str = None,
    identifier: str = None,
    tailored_experience: str = None,
    tailored_projects: str = None,
    tailored_skills: str = None,
    tool_context=None,
) -> str:
    """Strands tool: compile a portfolio-driven, job-tailored resume PDF.

    Header fields come from chrome.storage preferences carried in
    invocation_state. Experience/Projects come from the portfolio in
    invocation_state; the agent selects up to 4 experiences and 3 projects
    (key order sets the resume order) and supplies only rewritten bullet text —
    never LaTeX. With no selection the first stored entries are used. Technical
    Skills is static forever and never modified (any `tailored_skills` kwarg is
    ignored).

    Args:
        experience_bullets: JSON string mapping 0-based experience index to a
            list of rewritten bullet strings, e.g. '{"3": ["bullet"], "0": ["bullet"]}'.
            Keys select which entries appear and their order; a selected entry
            with missing/invalid bullets falls back to its stored description.
        project_bullets: JSON string mapping 0-based project index to bullets.
        identifier: filename-safe base for the PDF (e.g. company name). Defaults
            to "resume" (or derived from invocation_state).
        tailored_experience: Deprecated LaTeX fragment, only used when the
            portfolio has no experiences. Prefer experience_bullets.
        tailored_projects: Deprecated LaTeX fragment, only used when the
            portfolio has no projects. Prefer project_bullets.
        tailored_skills: Accepted for backward compatibility; always ignored
            because Technical Skills is static.
        tool_context: Strands ToolContext (provides invocation_state with
            session_id, preferences, and portfolio).
    """
    try:
        preferences = None
        portfolio = None
        session_id = None
        safe_identifier = identifier

        # Pull session_id + preferences + portfolio + optional company/title for filename from invocation_state
        try:
            if tool_context is not None:
                inv = getattr(tool_context, "invocation_state", None)
                if isinstance(inv, dict):
                    session_id = inv.get("session_id")
                    # preferences may be the full normalized object or raw
                    if isinstance(inv.get("preferences"), dict):
                        preferences = inv["preferences"]
                    if isinstance(inv.get("portfolio"), dict):
                        portfolio = inv["portfolio"]
                    # identifier fallback: company or title if supplied by HTTP layer
                    if not safe_identifier:
                        comp = inv.get("company")
                        tit = inv.get("title")
                        if isinstance(comp, str) and comp.strip():
                            safe_identifier = comp.strip()
                        elif isinstance(tit, str) and tit.strip():
                            safe_identifier = tit.strip()
                if not session_id:
                    agent = getattr(tool_context, "agent", None)
                    sm = getattr(agent, "session_manager", None) if agent else None
                    session_id = getattr(sm, "session_id", None)
                    if not isinstance(session_id, str):
                        session_id = None
        except Exception:
            session_id = None

        if not isinstance(safe_identifier, str) or not safe_identifier.strip():
            safe_identifier = "resume"

        # tailored_skills is accepted for backward compat and intentionally
        # ignored — Technical Skills stays static.
        output_path = resume_pipeline(
            preferences=preferences,
            portfolio=portfolio,
            experience_bullets=experience_bullets,
            project_bullets=project_bullets,
            tailored_experience_latex=tailored_experience,
            tailored_projects_latex=tailored_projects,
            identifier=safe_identifier,
        )

        if output_path and os.path.exists(output_path):
            safe_id = "".join(c for c in safe_identifier if c not in '/\\"').strip() or "resume"
            filename = f"{safe_id}_resume.pdf".replace(" ", "_")
            set_pending_file(output_path, filename=filename, session_id=session_id)
            return "Success! Resume PDF compiled."

        return "Error: PDF compilation failed — no file produced."

    except Exception as e:
        return f"Error: {e}"


# ---------------------------------------------------------------------------
# Backwards-compat demo — only runs when executed directly, not on import.
# (Previous version executed customize_resume unconditionally at import time.)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Demo with chrome.storage-like preferences shape; falls back to env/defaults.
    demo_preferences = {
        "personalInformation": {
            "firstName": os.getenv("FIRST_NAME", "Raihan"),
            "lastName": os.getenv("LAST_NAME", "Rafeek"),
            "email": os.getenv("EMAIL", "rafeekrn@mail.uc.edu"),
            "linkedinUrl": "https://linkedin.com/in/raihan-rafeek",
            "websiteUrl": "https://www.rai-1975.com",
            "phoneNumber": os.getenv("PHONE_NUMBER", ""),
            "homeAddress": os.getenv("ADDRESS", ""),
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
