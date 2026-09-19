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


def get_experiences():
    path = _data_path("experiences.json")
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
    path = _data_path("coursework.json")
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
    path = _data_path("projects.json")
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
    # Generates cover letter — session-aware file channel
    try:
        # Coerce None/empty (e.g. missing cache fields) so the template
        # substitution in cv_pipeline never receives a non-string.
        if not isinstance(company_name, str) or not company_name.strip():
            company_name = "Hiring Team"
        if not isinstance(title, str) or not title.strip():
            title = "this position"
        output_path = cv_pipeline(company_name, title, body)
        if output_path and os.path.exists(output_path):
            safe_company = "".join(c for c in company_name if c not in '/\\"').strip() or "Hiring Team"
            safe_title = "".join(c for c in title if c not in '/\\"').strip() or "this position"
            filename = f"{safe_company}_{safe_title}_CoverLetter.pdf".replace(" ", "_")
            session_id = None
            try:
                if tool_context is not None:
                    # Strands ToolContext carries invocation_state
                    inv = getattr(tool_context, "invocation_state", None)
                    if isinstance(inv, dict):
                        session_id = inv.get("session_id")
                    # Fallback: agent's session manager
                    if not session_id:
                        agent = getattr(tool_context, "agent", None)
                        sm = getattr(agent, "session_manager", None) if agent else None
                        session_id = getattr(sm, "session_id", None)
                        # FileSessionManager may sanitize; use raw
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