import os
import json
from strands import tool

try:
    from tex_to_pdf import cv_pipeline
except ImportError:
    from tools.tex_to_pdf import cv_pipeline

try:
    from tools.file_channel import set_pending_file
except ImportError:
    from file_channel import set_pending_file

def _data_path(filename):
    """Resolve backend/data/<filename> regardless of CWD."""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", filename)


def _effective_data_path(filename):
    """Prefer user_*.json override if present, else default."""
    base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", filename)
    # map defaults to user files
    user_map = {
        "experiences.json": "user_experiences.json",
        "projects.json": "user_projects.json",
        "coursework.json": "user_coursework.json",
    }
    user_file = user_map.get(filename)
    if user_file:
        user_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", user_file)
        if os.path.exists(user_path) and os.path.getsize(user_path) > 0:
            try:
                # quick valid-check: must be JSON list
                with open(user_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    return user_path
            except Exception:
                pass
    return base


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


def get_experiences():
    path = _effective_data_path("experiences.json")
    with open(path, "r", encoding="utf-8") as f:
        exp = json.load(f)

    formatted_string = "# Experiences\n"
    count = 1
    for experience in exp:
        formatted_string += f"\n{count}) "
        formatted_string += f"Position: {experience.get('title')}\n\n"
        formatted_string += f"Company: {experience.get('organization')}\n\n"
        formatted_string += f"Description: {experience.get('description')}\n\n"
        formatted_string += f"Duration: {experience.get('date')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string


def get_coursework():
    path = _effective_data_path("coursework.json")
    with open(path, "r", encoding="utf-8") as f:
        coursework = json.load(f)

    formatted_string = "# Coursework\n"
    count = 1
    for course in coursework:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {course.get('title')}\n\n"
        formatted_string += f"Stack and Course: {course.get('stack')}\n\n"
        formatted_string += f"Description: {course.get('description')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string

def get_projects():
    path = _effective_data_path("projects.json")
    with open(path, "r", encoding="utf-8") as f:
        projects = json.load(f)

    formatted_string = "# Projects\n"
    count = 1
    for project in projects:
        formatted_string += f"\n{count}) "
        formatted_string += f"Title: {project.get('title')}\n\n"
        formatted_string += f"Stack and Course: {project.get('stack')}\n\n"
        formatted_string += f"Description: {project.get('description')}\n\n"
        formatted_string += f"Link: {project.get('link')}\n\n"
        formatted_string += "-"*60
        count += 1

    return formatted_string

@tool
def get_profile_summary():
    combined_string = ""
    combined_string += "\n\n" + get_experiences()
    combined_string += "\n\n" + get_projects()
    combined_string += "\n\n" + get_coursework()

    return combined_string

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