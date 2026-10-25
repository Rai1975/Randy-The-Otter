"""Resume specialist — portfolio-structured, job-tailored resume.

Uses get_profile_summary (portfolio sent from chrome.storage.local via
invocation_state) to ground tailoring, then returns a TailoredResume as
structured output: selected experiences/projects with rewritten bullets and
job-relevant Technical Skills rows. The agent never writes LaTeX or compiles;
randy_main.generate_resume_for_job renders each template slot from the
structured output (tools/custom_resume.py SECTION_RENDERERS) and compiles.
Header fields (name, email, URLs) come from chrome.storage preferences.

No session memory (like cover_letter_agent).
"""

from strands import Agent

from agents.common import model
from tools.custom_resume import (
    MAX_EXPERIENCE_ENTRIES,
    MAX_PROJECT_ENTRIES,
    MAX_SKILL_GROUPS,
    TailoredResume,
)
from tools.get_user_profile import get_profile_summary

RESUME_SYSTEM_PROMPT = f"""
You are Randy's resume specialist. You produce the STRUCTURED CONTENT of a
job-tailored resume. The backend turns your structured output into the resume
template — you never write LaTeX and never compile anything.

## Available Tools
1. `get_profile_summary` - Returns my experiences, projects, and coursework as
   plain text, numbered from 1 within each section. This is your ground truth.

## Steps for Execution
1. Call `get_profile_summary` to retrieve experiences, projects, coursework.
2. EXPERIENCES and PROJECTS: pick the entries that best match the role and its
   stack. Do NOT just take the first entries; skip earlier ones whenever a later
   one is a stronger fit. Order them most relevant first.
   - At most {MAX_EXPERIENCE_ENTRIES} experiences and at most {MAX_PROJECT_ENTRIES} projects.
   - `entry` is the number get_profile_summary shows for that entry within its
     own section (Experiences or Projects), starting at 1.
   - Never add, rename, or fabricate entries. Fewer than the max is fine.
3. BULLETS: rewrite each selected entry's description into 3-4 concise,
   one-line, job-relevant bullets.
   - Mirror key language/priorities from the posting where genuinely applicable.
   - Use only concrete facts from that entry; preserve metrics.
   - Plain text only (no LaTeX, no backslashes, no braces). You may wrap one or
     two key phrases per bullet in **double asterisks** to bold them.
4. SKILLS: build 2-{MAX_SKILL_GROUPS} Technical Skills rows (e.g. "Languages",
   "Frameworks & Libraries", "Databases", "Cloud & Tools", "AI & ML").
   - Only list skills that are literally named somewhere in the profile summary
     (stacks, descriptions, coursework). Use the profile's spelling. Skills not
     found in the profile are dropped by the backend, so don't invent any.
   - Put skills the posting asks for first, and the most relevant row first.
   - Leave out skills that are irrelevant to this role when the rows get long.

## Constraints
- Never fabricate experience, projects, skills, qualifications, or metrics not
  in the profile summary.
- Header/personal info is handled automatically — don't ask the user for it.
- Never pause for confirmation; always return the structured output.
"""


def build_resume_agent():
    """Build a stateless resume specialist that returns a TailoredResume."""
    return Agent(
        model=model,
        system_prompt=RESUME_SYSTEM_PROMPT,
        tools=[get_profile_summary],
        structured_output_model=TailoredResume,
    )
