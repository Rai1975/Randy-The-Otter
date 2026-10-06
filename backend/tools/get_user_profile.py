import os
from strands import tool

try:
    from tex_to_pdf import cv_pipeline
except ImportError:
    from tools.tex_to_pdf import cv_pipeline

try:
    from tools.file_channel import set_pending_file
except ImportError:
    from file_channel import set_pending_file

MAX_PORTFOLIO_ITEMS = 100
MAX_TEXT_CHARS = 10000

PORTFOLIO_TABS = ("experiences", "projects", "coursework")


def _clean_text(value, cap=500):
    if not isinstance(value, str):
        return ""
    return value.strip()[:cap]


def _normalize_experience(item):
    if not isinstance(item, dict):
        return None
    title = _clean_text(item.get("title"), 300)
    if not title:
        return None
    return {
        "title": title,
        "organization": _clean_text(item.get("organization"), 300),
        "date": _clean_text(item.get("date"), 200),
        "link": _clean_text(item.get("link"), 500),
        "description": _clean_text(item.get("description"), MAX_TEXT_CHARS),
    }


def _normalize_project_or_coursework(item):
    if not isinstance(item, dict):
        return None
    title = _clean_text(item.get("title"), 300)
    if not title:
        return None
    return {
        "title": title,
        "link": _clean_text(item.get("link"), 500),
        "stack": _clean_text(item.get("stack"), 500),
        "category": _clean_text(item.get("category"), 200),
        "description": _clean_text(item.get("description"), MAX_TEXT_CHARS),
    }


def _normalize_portfolio(raw=None) -> dict:
    """Validate the extension-owned portfolio shape from chrome.storage.local.

    Accepts {experiences:[...], projects:[...], coursework:[...]} (or None).
    Drops invalid entries (missing title), enforces caps. Empty by default —
    no backend files, no seeding.
    """
    if not isinstance(raw, dict):
        return {tab: [] for tab in PORTFOLIO_TABS}
    out = {}
    for tab in PORTFOLIO_TABS:
        items = raw.get(tab)
        if not isinstance(items, list):
            out[tab] = []
            continue
        normalizer = _normalize_experience if tab == "experiences" else _normalize_project_or_coursework
        cleaned = []
        for item in items[:MAX_PORTFOLIO_ITEMS]:
            n = normalizer(item)
            if n:
                cleaned.append(n)
        out[tab] = cleaned
    return out


def _get_portfolio_from_context(tool_context):
    """Extract normalized portfolio from Strands ToolContext invocation_state."""
    try:
        if tool_context is not None:
            inv = getattr(tool_context, "invocation_state", None)
            if isinstance(inv, dict):
                return _normalize_portfolio(inv.get("portfolio"))
    except Exception:
        pass
    return {tab: [] for tab in PORTFOLIO_TABS}


def get_autofill_profile(preferences=None):
    """Return the explicit profile subset used by form autofill."""
    personal = preferences.get("personalInformation", {}) if isinstance(preferences, dict) else {}
    personal = personal if isinstance(personal, dict) else {}
    return {
        "first_name": personal.get("firstName") or os.getenv("FIRST_NAME", ""),
        "last_name": personal.get("lastName") or os.getenv("LAST_NAME", ""),
        "email": personal.get("email") or os.getenv("EMAIL", ""),
        "phone_number": personal.get("phoneNumber") or os.getenv("PHONE_NUMBER", ""),
        "address": personal.get("homeAddress") or os.getenv("ADDRESS", ""),
        "linkedin_url": personal.get("linkedinUrl", ""),
        "website_url": personal.get("websiteUrl", ""),
        "veteran_status": personal.get("veteranStatus", ""),
        "disability_status": personal.get("disabilityStatus", ""),
        "race": personal.get("race", ""),
        "gender": personal.get("gender", ""),
    }


def _format_experiences(items) -> str:
    formatted_string = "# Experiences\n"
    if not items:
        return formatted_string + "\n(no experiences provided)\n"
    count = 1
    for experience in items[:20]:
        formatted_string += f"\n{count}) "
        formatted_string += f"Position: {experience.get('title')}\n\n"
        formatted_string += f"Company: {experience.get('organization')}\n\n"
        formatted_string += f"Description: {experience.get('description')}\n\n"
        formatted_string += f"Duration: {experience.get('date')}\n\n"
        formatted_string += "-"*60
        count += 1
    return formatted_string


def _format_coursework(items) -> str:
    formatted_string = "# Coursework\n"
    if not items:
        return formatted_string + "\n(no coursework provided)\n"
    count = 1
    for course in items[:20]:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {course.get('title')}\n\n"
        formatted_string += f"Stack and Course: {course.get('stack')}\n\n"
        formatted_string += f"Description: {course.get('description')}\n\n"
        formatted_string += "-"*60
        count += 1
    return formatted_string


def _format_projects(items) -> str:
    formatted_string = "# Projects\n"
    if not items:
        return formatted_string + "\n(no projects provided)\n"
    count = 1
    for project in items[:20]:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {project.get('title')}\n\n"
        formatted_string += f"Stack and Course: {project.get('stack')}\n\n"
        formatted_string += f"Description: {project.get('description')}\n\n"
        formatted_string += f"Link: {project.get('link')}\n\n"
        formatted_string += "-"*60
        count += 1
    return formatted_string


def format_portfolio_summary(portfolio=None) -> str:
    """Build the LLM ground-truth text from an extension-owned portfolio dict."""
    normalized = _normalize_portfolio(portfolio)
    combined_string = ""
    combined_string += "\n\n" + _format_experiences(normalized.get("experiences", []))
    combined_string += "\n\n" + _format_projects(normalized.get("projects", []))
    combined_string += "\n\n" + _format_coursework(normalized.get("coursework", []))
    return combined_string


@tool(context=True)
def get_profile_summary(tool_context=None):
    """Return experiences/projects/coursework sent from chrome.storage.local.

    Portfolio arrives via invocation_state["portfolio"]
    (see jobs_controller envelope + randy_main). Empty by default — never
    fabricate entries not present here.
    """
    portfolio = _get_portfolio_from_context(tool_context)
    return format_portfolio_summary(portfolio)

@tool(context=True)
def generate_cover_letter(company_name: str, title: str, body: str, tool_context=None):
    # Generates cover letter — session-aware file channel.
    # Header fields are REQUIRED from chrome.storage preferences (no env fallback).
    try:
        # Coerce None/empty (e.g. missing cache fields) so the template
        # substitution in cv_pipeline never receives a non-string.
        if not isinstance(company_name, str) or not company_name.strip():
            company_name = "Hiring Team"
        if not isinstance(title, str) or not title.strip():
            title = "this position"

        # Preferences are REQUIRED — pulled from invocation_state
        preferences = None
        session_id = None
        try:
            if tool_context is not None:
                inv = getattr(tool_context, "invocation_state", None)
                if isinstance(inv, dict):
                    preferences = inv.get("preferences")
                    session_id = inv.get("session_id")
        except Exception:
            pass

        if not isinstance(preferences, dict):
            return "Error: cover letter requires chrome.storage preferences — missing preferences in invocation_state (personalInformation.firstName/lastName/email/phoneNumber/homeAddress required)"
        personal = preferences.get("personalInformation")
        if not isinstance(personal, dict):
            return "Error: cover letter requires chrome.storage preferences — personalInformation missing"
        for key in ("firstName", "lastName", "email", "phoneNumber", "homeAddress"):
            val = personal.get(key)
            if not isinstance(val, str) or not val.strip():
                return f"Error: cover letter requires chrome.storage preferences — personalInformation.{key} is required"

        output_path = cv_pipeline(company_name, title, body, preferences=preferences)
        if output_path and os.path.exists(output_path):
            safe_company = "".join(c for c in company_name if c not in '/\\"').strip() or "Hiring Team"
            safe_title = "".join(c for c in title if c not in '/\\"').strip() or "this position"
            filename = f"{safe_company}_{safe_title}_CoverLetter.pdf".replace(" ", "_")
            # Reuse session_id already extracted above; fallback to agent session_manager if missing
            if not session_id:
                try:
                    if tool_context is not None:
                        agent = getattr(tool_context, "agent", None)
                        sm = getattr(agent, "session_manager", None) if agent else None
                        session_id = getattr(sm, "session_id", None)
                        if not isinstance(session_id, str):
                            session_id = None
                except Exception:
                    session_id = None
            set_pending_file(output_path, filename=filename, session_id=session_id)
        return "Success!"
    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    print(get_profile_summary())