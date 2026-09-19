"""Randy orchestrator — session-scoped coordinator over three specialist skills.

Pattern: agents-as-tools (Strands recommended). The orchestrator owns the
session memory (FileSessionManager) and delegates via @tool wrappers around
stateless specialists. Only the orchestrator is session-scoped; specialists
are stateless and receive only the description string.

Skills:
  1. Roast            — placeholder prompt, description -> one-liner roast
  2. Cover letter     — LaTeX body (pipeline-ready), grounded via profile tool
  3. Job match score  — "X/10 — verdict", grounded via profile tool
"""

from strands import Agent, tool
from strands.session.file_session_manager import FileSessionManager

from agents.common import SESSION_STORAGE_DIR, model, sanitize_session_id
from agents.cover_letter_agent import build_cover_letter_agent
from agents.match_score_agent import build_match_score_agent
from agents.roast_agent import build_roast_agent

# Stateless specialists — shared across sessions (the orchestrator is the
# session-scoped one).
_roast_agent = build_roast_agent()
_cover_letter_agent = build_cover_letter_agent()
_match_score_agent = build_match_score_agent()


@tool
def roast_task(description: str) -> str:
    """Roast a job posting. Call this when the user wants a roast.

    Args:
        description: the job description plain text to roast
    """
    return str(_roast_agent(description))


@tool
def cover_letter_task(description: str) -> str:
    """Generate a LaTeX cover letter for a job. Call this when the user
    wants a custom cover letter.

    Args:
        description: the job description plain text to tailor the letter to
    """
    return str(_cover_letter_agent(description))


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
  [action: cover-letter] <description> -> delegate to cover_letter_task
  [action: match-score] <description>  -> delegate to match_score_task
  (no tag) <description>               -> react directly, don't call a tool

RULES:
- When a tag is present, you MUST call the corresponding tool with the
  description and return its output faithfully (no extra commentary).
- Without a tag: react to the job description in ONE short, punchy, lowercase
  Gen Z sentence. Be witty and encouraging, not corporate. Use light slang
  (bro, ngl, lowkey, yooo, dang, solid) naturally. No bullet points or
  paragraphs. Don't say "as an AI". Don't restate the description.

When given a job description with no tag, react to the MOST notable thing:
 - Good opportunity -> "dang this looks pretty solid bro"
 - Strong match -> "yeahhh this is kinda your lane"
 - Interesting tech -> "wait this stack is actually kinda sick"
 - Great role -> "okayyy this one has some sauce"
 - Weird requirement -> "bro they really want one person to do everything"
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
        tools=[roast_task, cover_letter_task, match_score_task],
        session_manager=session_manager,
    )


if __name__ == "__main__":
    response = get_randy_agent("cli")("Hello! What can you do?")
    print(response)
