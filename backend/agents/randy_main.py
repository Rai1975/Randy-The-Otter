"""Randy orchestrator — session-scoped coordinator.

Pattern: agents-as-tools (Strands recommended). The orchestrator owns the
session memory (FileSessionManager) and delegates via @tool wrappers around
stateless specialists. Only the orchestrator is session-scoped; specialists
are stateless and receive only the description string.

Skills (via orchestrator):
  1. Roast            — placeholder prompt, description -> one-liner roast
  2. Job match score  — "X/10 — verdict", grounded via profile tool

Cover-letter is NOT routed through the orchestrator — it has its own
endpoint (POST /cover-letters) that calls the specialist directly via
generate_cover_letter_for_job() to avoid an extra agent hop and
invocation_state loss (see cover_letters.py).
"""

from strands import Agent, tool
from strands.session.file_session_manager import FileSessionManager

from agents.common import SESSION_STORAGE_DIR, model, sanitize_session_id
from agents.cover_letter_agent import build_cover_letter_agent
from agents.match_score_agent import MatchScoreResult, build_match_score_agent
from agents.resume_agent import build_resume_agent
from agents.roast_agent import build_roast_agent

# Stateless specialists — shared across sessions (the orchestrator is the
# session-scoped one).
_roast_agent = build_roast_agent()
_cover_letter_agent = build_cover_letter_agent()
_match_score_agent = build_match_score_agent()
_resume_agent = build_resume_agent()


def generate_cover_letter_for_job(
    session_id, description: str, preferences: dict, company: str | None = None, title: str | None = None
) -> str:
    """Run the stateless cover-letter specialist with chrome.storage preferences.

    Header fields (FirstName/LastName/Email/Phone/Address) are REQUIRED from
    `preferences` (randyPreferences.personalInformation) — no env fallback.
    Mirrors generate_resume_for_job but for cover letters (see
    tools/tex_to_pdf.py:generate_cover_letter and tools/get_user_profile.py:generate_cover_letter).

    When the extension supplies unified job metadata (Handshake cache keyed
    by jobId), the company/title are prepended as a verbatim directive so
    the agent passes them straight to the generate_cover_letter tool instead
    of re-inferring them from the description text. Missing/empty hints fall
    back to inference per the agent prompt.
    """
    if not isinstance(preferences, dict):
        raise ValueError("cover letter requires chrome.storage preferences — preferences must be a dict")
    personal = preferences.get("personalInformation")
    if not isinstance(personal, dict):
        raise ValueError("cover letter requires chrome.storage preferences — personalInformation missing")
    for _key in ("firstName", "lastName", "email", "phoneNumber", "homeAddress"):
        _val = personal.get(_key)
        if not isinstance(_val, str) or not _val.strip():
            raise ValueError(f"cover letter requires chrome.storage preferences — personalInformation.{_key} is required")

    prompt = description
    lines = []
    if isinstance(company, str) and company.strip():
        lines.append(f'Company: "{company.strip()}"')
    if isinstance(title, str) and title.strip():
        lines.append(f'Title: "{title.strip()}"')
    if lines:
        prompt = (
            "[Known job metadata — USE VERBATIM as generate_cover_letter args. "
            "Do not re-infer company/title from the description.]\n"
            + "\n".join(lines)
            + "\n\n"
            + description
        )
    invocation_state = {"session_id": sanitize_session_id(session_id), "preferences": preferences}
    if isinstance(company, str) and company.strip():
        invocation_state["company"] = company.strip()
    if isinstance(title, str) and title.strip():
        invocation_state["title"] = title.strip()
    return str(
        _cover_letter_agent(
            prompt,
            invocation_state=invocation_state,
        )
    )


def generate_resume_for_job(
    session_id, description: str, preferences=None, company: str | None = None, title: str | None = None
) -> str:
    """Run the stateless resume specialist with chrome.storage preferences.

    Header fields (name/email/URLs) are auto-sourced from `preferences`
    (randyPreferences.personalInformation) via invocation_state — the agent
    only tailors Experience/Projects/Skills bullets to the job description.
    Mirrors generate_cover_letter_for_job but carries preferences for the
    resume pipeline (see tools/custom_resume.py:generate_resume).
    """
    prompt = description
    lines = []
    if isinstance(company, str) and company.strip():
        lines.append(f'Company: "{company.strip()}"')
    if isinstance(title, str) and title.strip():
        lines.append(f'Title: "{title.strip()}"')
    if lines:
        prompt = (
            "[Known job metadata — USE VERBATIM for resume identifier. "
            "Tailor bullets to this role; keep header from chrome.storage.]\n"
            + "\n".join(lines)
            + "\n\n"
            + description
        )
    invocation_state = {"session_id": sanitize_session_id(session_id)}
    if isinstance(preferences, dict):
        invocation_state["preferences"] = preferences
    if isinstance(company, str) and company.strip():
        invocation_state["company"] = company.strip()
    if isinstance(title, str) and title.strip():
        invocation_state["title"] = title.strip()
    return str(_resume_agent(prompt, invocation_state=invocation_state))


def generate_match_score_for_job(session_id, description: str, preferences=None) -> dict:
    """Run the match specialist with the user's request-scoped preferences.

    Preferences are passed via invocation_state so the get_user_preferences tool
    can return the 4-bucket JSON slice (no personalInformation) without inlining
    raw JSON in the prompt.

    Returns a dict matching MatchScoreResult (answer, avg_score, preferences_score,
    qualifications_score, works, misses). Always returns a dict — never raises on
    parse failure (falls back to a safe 0% result).
    """
    import json as _json

    prompt = f"JOB DESCRIPTION:\n{description}"
    invocation_state: dict = {"session_id": sanitize_session_id(session_id)}
    if isinstance(preferences, dict):
        invocation_state["preferences"] = preferences

    fallback = {
        "answer": "0% match — no description to judge",
        "avg_score": 0,
        "preferences_score": 0,
        "qualifications_score": 0,
        "works": ["no signal to evaluate"],
        "misses": ["no description provided"],
    }

    # Fast path for empty description without LLM call — keeps prompt contract consistent
    if not (description or "").strip():
        return dict(fallback)

    try:
        result = _match_score_agent(prompt, invocation_state=invocation_state)
        # Strands with structured_output_model populates result.structured_output
        structured = getattr(result, "structured_output", None)
        if isinstance(structured, MatchScoreResult):
            return structured.model_dump()
        if isinstance(structured, dict):
            # validate via model
            try:
                return MatchScoreResult.model_validate(structured).model_dump()
            except Exception:
                return structured
        # Fallback: try to parse string as JSON
        raw = str(result).strip()
        if raw:
            # strip markdown fences if model wrapped JSON
            if raw.startswith("```"):
                # ```json\n{...}\n```
                raw = raw.strip("`")
                # after stripping `, may have 'json' prefix
                if raw.lstrip().lower().startswith("json"):
                    raw = raw.lstrip()[4:].strip()
            try:
                parsed = _json.loads(raw)
                return MatchScoreResult.model_validate(parsed).model_dump()
            except Exception:
                # last resort: if raw is not JSON, synthesize from raw text
                # keep raw as answer, estimate scores as 50/50
                return {
                    "answer": raw[:280],
                    "avg_score": 50,
                    "preferences_score": 50,
                    "qualifications_score": 50,
                    "works": ["check description"],
                    "misses": ["see details in bubble"],
                }
    except Exception:
        import logging as _logging

        _logging.getLogger(__name__).exception("generate_match_score_for_job failed, returning fallback")
    return dict(fallback)


@tool
def roast_task(description: str) -> str:
    """Roast a job posting. Call this when the user wants a roast.

    Args:
        description: the job description plain text to roast
    """
    return str(_roast_agent(description))


@tool
def match_score_task(description: str) -> str:
    """Score how well a job matches the user's profile.

    Args:
        description: the job description plain text to score
    """
    return str(_match_score_agent(description))


ORCHESTRATOR_SYSTEM_PROMPT = """
You are Randy, a Gen Z job-search copilot and orchestrator.

Your input is an intent-tagged message:
  [action: roast] <description>        -> delegate to roast_task
  [action: match-score] <description>  -> delegate to match_score_task
  (no tag) <description>               -> react directly, don't call a tool

Note: cover letters are handled by a dedicated endpoint and never routed
through the orchestrator.


RULES:
- When a tag is present, you MUST call the corresponding tool with the
  description and return its output faithfully (no extra commentary).
- Without a tag: react to the job description in ONE short, punchy, lowercase
  sentence. Be witty and lightly edgy but still professional, not corporate. Light slang
  (dang, solid, kinda, ngl, lowkey) is ok sparingly — no "bro". No bullet points or
  paragraphs. Don't say "as an AI". Don't restate the description.

When given a job description with no tag, react to the MOST notable thing:
 - Good opportunity -> "dang, this one looks pretty solid"
 - Strong match -> "yeahhh this is kinda your lane"
 - Interesting tech -> "wait this stack is actually kinda sick"
 - Great role -> "okayyy this one has some sauce"
 - Weird requirement -> "they really want one person to do everything"
 - Unclear fit -> "hmm, honestly could be worth a shot"

Prioritize being natural, concise, and encouraging.
"""


def get_randy_agent(session_id):
    """Build Randy bound to the given extension session.

    Each session_id gets its own FileSessionManager, so conversation
    history is scoped per browser session and restored on later requests.
    The orchestrator delegates to stateless specialists via tools.
    """
    session_manager = FileSessionManager(
        session_id=sanitize_session_id(session_id),
        storage_dir=SESSION_STORAGE_DIR,
    )
    return Agent(
        model=model,
        system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        tools=[roast_task, match_score_task],
        session_manager=session_manager,
    )


if __name__ == "__main__":
    response = get_randy_agent("cli")("Hello! What can you do?")
    print(response)
