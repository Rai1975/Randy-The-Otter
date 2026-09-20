"""Resume pipeline — mirrors tex_to_pdf.py but for resume_template.tex.

Header fields (FullName, Email, URLs, etc.) are sourced from chrome.storage
(randyPreferences.personalInformation) via `preferences` dict. The extension
sends this on every envelope (see randy-backend.js:postRandyEnvelope), and
jobs_controller._normalize_preferences sanitizes it. When called outside the
extension flow, falls back to os.getenv / hardcoded defaults (same pattern as
tex_to_pdf.generate_cover_letter:51).

Job-tailored bullets: the resume specialist (resume_agent.py) calls
get_profile_summary, crafts LaTeX fragments for Experience/Projects/Skills
tailored to the job description, and passes them here. If None, the template's
stock sections are kept as-is (user requested to keep academics/experience/
projects intact by default).
"""

import os
import re
import subprocess
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

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
    # Normalize but don't escape — fragment is LaTeX already.
    def _clean(fragment):
        if not isinstance(fragment, str) or not fragment.strip():
            return None
        return normalize_unicode(fragment.strip())

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
    tailored_experience_latex=None,
    tailored_projects_latex=None,
    template_path: str | Path | None = None,
) -> str:
    """Build the filled-in resume tex string.

    Sources header fields from chrome.storage (preferences) and optionally
    splices job-tailored LaTeX for Experience/Projects (provided by the
    resume agent after consulting get_profile_summary). Technical Skills is
    never spliced — always the template's static block.

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
    tex = _inject_tailored_sections(
        tex,
        tailored_experience=tailored_experience_latex,
        tailored_projects=tailored_projects_latex,
    )
    return tex


def compile_resume_tex(filestring: str, identifier: str = "resume") -> str | None:
    """Write filestring to pdf_out/<identifier>_resume.tex, run pdflatex, return pdf path.

    Mirrors tex_to_pdf.compile_tex: runs twice, cleans aux files, keeps PDF.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    safe_id = "".join(c for c in str(identifier) if c not in '/\\"').strip() or "resume"
    base_name = f"{safe_id}_resume"
    output_tex = os.path.join(OUTPUT_DIR, f"{base_name}.tex")

    with open(output_tex, "w", encoding="utf-8") as f:
        f.write(filestring)

    result = None
    for _ in range(2):
        result = subprocess.run(
            ["pdflatex", "-interaction=nonstopmode", "-output-directory", OUTPUT_DIR, output_tex],
            capture_output=True,
            text=True,
        )

    if result is None or result.returncode != 0:
        # tex_to_pdf prints stdout tail; do the same
        print("Resume compilation failed. Log output:")
        try:
            print(result.stdout[-2000:] if result else "no result")
        except Exception:
            pass
        return None

    pdf_path = os.path.join(OUTPUT_DIR, f"{base_name}.pdf")
    for ext in (".tex", ".aux", ".log", ".out"):
        stray = os.path.join(OUTPUT_DIR, f"{base_name}{ext}")
        if os.path.exists(stray):
            try:
                os.remove(stray)
            except Exception:
                pass
    print(f"Compiled resume: {pdf_path}")
    return pdf_path


def resume_pipeline(
    preferences=None,
    tailored_experience_latex=None,
    tailored_projects_latex=None,
    identifier: str = "resume",
    template_path: str | Path | None = None,
) -> str | None:
    """One-call pipeline: preferences -> tex string -> PDF path. Mirrors tex_to_pdf.cv_pipeline.

    Technical Skills is static — no tailored_skills arg forwarded.
    """
    filled = generate_resume_tex(
        preferences=preferences,
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
    tailored_experience: str = None,
    tailored_projects: str = None,
    identifier: str = None,
    tool_context=None,
    **kwargs,
) -> str:
    """Strands tool: compile a (optionally job-tailored) resume PDF.

    Header fields are sourced from chrome.storage preferences carried in
    invocation_state. The resume agent crafts LaTeX fragments for Experience/
    Projects only — Technical Skills is static forever and never modified
    (any `tailored_skills` kwarg is ignored for backward compat).

    Args:
        tailored_experience: LaTeX fragment for the Experience section (e.g.
            a series of \\resumeSubheading + \\resumeItem blocks). When None,
            the template's stock Experience section is kept.
        tailored_projects: LaTeX fragment for the Projects section.
        identifier: filename-safe base for the PDF (e.g. company name). Defaults
            to "resume" (or derived from invocation_state).
        tool_context: Strands ToolContext (provides invocation_state with
            session_id and preferences).
    """
    try:
        preferences = None
        session_id = None
        safe_identifier = identifier

        # Pull session_id + preferences + optional company/title for filename from invocation_state
        try:
            if tool_context is not None:
                inv = getattr(tool_context, "invocation_state", None)
                if isinstance(inv, dict):
                    session_id = inv.get("session_id")
                    # preferences may be the full normalized object or raw
                    if isinstance(inv.get("preferences"), dict):
                        preferences = inv["preferences"]
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

        # tailored_skills is intentionally ignored — Technical Skills stays static
        if "tailored_skills" in kwargs or "tailored_skills_latex" in kwargs:
            # backward compat: old agent sessions may still send it; drop it
            pass
        output_path = resume_pipeline(
            preferences=preferences,
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
    # Optionally compile if pdflatex is available
    try:
        pdf = compile_resume_tex(tex_str, identifier="preview")
        print(f"Preview PDF: {pdf}")
    except FileNotFoundError:
        print("pdflatex not found — skipping compile")
