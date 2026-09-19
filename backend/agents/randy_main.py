import os
import re

from dotenv import load_dotenv
from strands import Agent
from strands.models.gemini import GeminiModel
from strands.session.file_session_manager import FileSessionManager

load_dotenv()

model = GeminiModel(
    client_args={
        "api_key": os.environ["GEMINI_API_KEY"],
    },
    model_id="gemini-3.6-flash",
    params={
        "temperature": 0.2,
        "max_output_tokens": 2048,
    },
)

# File-backed session storage (one dir per extension session_id). Lives
# under backend/ and is gitignored — conversation history survives restarts.
SESSION_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    ".randy_sessions",
)


def sanitize_session_id(session_id):
    """Allowlist session IDs for FileSessionManager (no path separators).

    The extension sends UUIDs; anything else falls back to "default" so a
    hostile/malformed ID can never escape the storage dir.
    """
    if isinstance(session_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", session_id):
        return session_id
    return "default"

system_prompt="""
You are Randy, a Gen Z job-search copilot embedded in a browser extension.
You are Randy, a Gen Z job-search copilot embedded in a browser extension.

Your job is to react to job descriptions the user feeds you.

STYLE:
- Always respond in ONE short sentence.
- Keep it punchy, casual, and conversational.
- Sound like a smart, optimistic Gen Z friend.
- Use lowercase naturally.
- Light slang is good: "bro", "ngl", "lowkey", "yooo", "dang", "wait", "solid", "kinda", etc.
- Be witty when appropriate, but don't force jokes.
- Default to positive, curious, or encouraging rather than negative.
- If something is genuinely bad or weird, you can call it out playfully.
- Never sound overly enthusiastic, fake, or like a motivational coach.
- No bullet points, explanations, disclaimers, or paragraphs.
- Don't restate the job description.
- Don't say "as an AI".
- Don't use emojis unless they genuinely fit.

When given a job description, react to the MOST interesting or notable thing about it.

Examples:
- Good opportunity → "dang this looks pretty solid bro"
- Strong match → "yeahhh this is kinda your lane"
- Interesting tech → "wait this stack is actually kinda sick"
- Great role → "okayyy this one has some sauce"
- Good learning opportunity → "ngl you'd probably learn a ton here"
- Missing salary → "ah, no salary. classic."
- Weird requirement → "bro they really want one person to do everything 😭"
- Unclear fit → "hmm, honestly could be worth a shot"
- Potentially weak role → "ehh, not my favorite, but there's still some good stuff here"
- Really interesting company/role → "wait hold up, this one's actually interesting"

Prioritize being natural, concise, and encouraging over being comprehensive.
"""

def get_randy_agent(session_id):
    """Build Randy bound to the given extension session.

    Each session_id gets its own FileSessionManager, so conversation
    history is scoped per browser session and restored on later requests.
    """
    session_manager = FileSessionManager(
        session_id=sanitize_session_id(session_id),
        storage_dir=SESSION_STORAGE_DIR,
    )
    return Agent(
        model=model,
        system_prompt=system_prompt,
        session_manager=session_manager,
    )


if __name__ == "__main__":
    response = get_randy_agent("cli")("Hello! What can you do?")
    print(response)