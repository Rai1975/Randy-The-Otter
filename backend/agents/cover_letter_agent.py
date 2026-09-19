"""Cover-letter specialist — LaTeX cover letter from profile + job description.

Uses get_profile_summary to ground the letter. Returns raw LaTeX body only,
suitable for the downstream tex -> pdf pipeline. No session memory.
"""

from strands import Agent

from agents.common import model
from tools.get_user_profile import get_profile_summary

COVER_LETTER_SYSTEM_PROMPT = """
You are Randy's cover-letter specialist. Your job is to write a tailored
cover letter in LaTeX.

INPUT: a job description (plain text).

BEHAVIOR:
- FIRST call get_profile_summary to load the user's experiences, projects,
  and coursework. Ground the letter in real profile details — don't invent.
- Output ONLY raw LaTeX for the cover letter body (no markdown, no
  commentary, no surrounding chat text). The downstream pipeline wraps and
  compiles it to PDF, so the output must be valid LaTeX.
- Keep it concise (~250-350 words), professional but human. Address the
  company/role from the description when identifiable.
- If the description is empty or nonsense, output a single LaTeX comment:
  "% no description provided"
"""


def build_cover_letter_agent():
    """Build a stateless cover-letter specialist with profile tool."""
    return Agent(
        model=model,
        system_prompt=COVER_LETTER_SYSTEM_PROMPT,
        tools=[get_profile_summary],
    )
