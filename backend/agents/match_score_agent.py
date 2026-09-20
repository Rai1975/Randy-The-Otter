"""Job match-score specialist — how closely the job aligns with the user.

Uses get_profile_summary to ground the verdict. One-liner, bubble-sized.
No session memory.
"""

from pydantic import BaseModel, Field
from strands import Agent

from agents.common import model
from tools.get_user_preferences import get_user_preferences
from tools.get_user_profile import get_profile_summary


class MatchScoreResult(BaseModel):
    """Structured match-score output for backend + frontend pixel box."""

    answer: str = Field(
        description="One short sentence, lowercase naturally, Gen Z punchy, honest. Must include avg% and summarize verdict. e.g. '72% match — 80% quals but 65% prefs, kinda your lane bro'"
    )
    avg_score: int = Field(ge=0, le=100, description="FINAL = round((preferences_score + qualifications_score)/2)")
    preferences_score: int = Field(ge=0, le=100, description="How well job matches wants (pay/location/titles/type/sponsorship)")
    qualifications_score: int = Field(ge=0, le=100, description="How well portfolio fits required skills/stack (aka portfolio score)")
    works: list[str] = Field(
        min_length=1,
        max_length=3,
        description="Concise bullets for what works - 3-6 words each, lowercase, no trailing period. e.g. 'react + ts match'",
    )
    misses: list[str] = Field(
        min_length=1,
        max_length=3,
        description="Concise bullets for what misses - 3-6 words each, lowercase, no trailing period. e.g. 'wants go experience'",
    )


MATCH_SCORE_SYSTEM_PROMPT = """
You are Randy's job match-score specialist.

INPUT: a job description (preferences are available via tool, not inlined).

BEHAVIOR:
- FIRST call get_profile_summary to load the user's portfolio (experiences, projects, coursework).
- THEN call get_user_preferences to load job preferences as JSON
  (keys: sponsorship, opportunityTypes, titles, locations, pay).
  This JSON is the ONLY preference source — it contains no personalInformation.

SCORING (two sub-scores, each 0-100, equal weight within):
1) PREFERENCES SCORE (0-100) — how well the job matches what the user wants.
   Dimensions (equal weight, only count dimensions where user expressed a preference):
   - sponsorship (any = no preference)
   - opportunityTypes (empty = no preference; e.g. full_time vs internship)
   - titles (empty = no preference)
   - locations = presets + customSelected + remote (all empty/false = no preference)
   - pay = currency + min/max (no min/max = no preference)
   Score each active dimension 0-100, then average them equally for the pref score.
   If no active preference at all, pref score = 100 (nothing to mismatch).
   Treat MISSING evidence in the job description as unknown, not a mismatch —
   do not deduct for a dimension if the posting doesn't mention it.

2) QUALIFICATIONS SCORE (0-100) — how well the user's background fits the role.
   Compare the profile summary against the job description's required skills,
   stack, and responsibilities. Reward direct matches (same stack, shipped similar
   projects, relevant coursework) and transferable experience. Do not fabricate;
   if the profile has no signal for a key requirement, score lower rather than
   inventing.

FINAL SCORE = round((preferences_score + qualifications_score) / 2) — integer 0-100.

OUTPUT: You MUST output valid JSON matching the MatchScoreResult schema via structured output.
- answer: one Gen Z punchy lowercase sentence. Must convey avg + both sub-scores vibe. Keep short.
  Example: "80% match — 90% quals but 70% prefs bro, react lane is yours"
- avg_score / preferences_score / qualifications_score: integers 0-100, with avg = round((pref+qual)/2)
- works: 1-3 tiny bullets for strengths (3-6 words, lowercase, no periods)
- misses: 1-3 tiny bullets for gaps (3-6 words, lowercase, no periods)
- If description is empty/nonsense: avg 0, qual 0, pref 0, answer "0% match — bro there's no description on this one", works ["no signal to evaluate"], misses ["no description provided"]
"""


def build_match_score_agent():
    """Build a stateless match-score specialist with profile + preferences tools."""
    return Agent(
        model=model,
        system_prompt=MATCH_SCORE_SYSTEM_PROMPT,
        tools=[get_profile_summary, get_user_preferences],
        structured_output_model=MatchScoreResult,
    )
