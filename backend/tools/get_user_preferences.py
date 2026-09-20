"""User preferences tool for match scoring — non-demographic, job-relevant slice.

Exposes the four match-relevant buckets from chrome.storage (randyPreferences):
  - sponsorship
  - opportunityTypes + titles  (job type)
  - locations                 (work style: presets, custom, customSelected, remote)
  - pay                       (compensation: currency, min, max)

Deliberately omits personalInformation entirely — no demographic or contact PII
surfaces to the scoring agent. Preferences are sourced from invocation_state
(populated by randy_main.generate_match_score_for_job / jobs_controller envelope),
mirroring generate_cover_letter and generate_resume.

Output is JSON string (compact) so the agent can parse it deterministically.
No scoring logic here — just data retrieval.
"""

import json

try:
    from strands import tool
except ImportError:  # fallback for tests without strands
    def tool(*_a, **_kw):
        def deco(f):
            return f
        return deco


def _get_preferences_from_context(tool_context):
    """Extract preferences dict from Strands ToolContext invocation_state."""
    try:
        if tool_context is not None:
            inv = getattr(tool_context, "invocation_state", None)
            if isinstance(inv, dict):
                prefs = inv.get("preferences")
                if isinstance(prefs, dict):
                    return prefs
    except Exception:
        pass
    return None


def _filtered_preferences_json(preferences) -> str:
    """Build the 4-bucket JSON slice; no personalInformation, no version."""
    if not isinstance(preferences, dict):
        # No preferences yet — return explicit defaults shape
        return json.dumps(
            {
                "sponsorship": "any",
                "opportunityTypes": [],
                "titles": [],
                "locations": {"presets": [], "custom": [], "customSelected": [], "remote": False},
                "pay": {"currency": "USD"},
            },
            separators=(",", ":"),
        )

    # Sponsorship — allowlist
    sponsorship = preferences.get("sponsorship")
    if sponsorship not in {"any", "preferred", "required"}:
        sponsorship = "any"

    # opportunityTypes — already normalized to ["internship","full_time"] subset
    opp = preferences.get("opportunityTypes")
    if not isinstance(opp, list):
        opp = []
    else:
        opp = [x for x in opp if x in {"internship", "full_time"}]

    # titles — list of strings (trimmed, like jobs_controller clean_list)
    titles = preferences.get("titles")
    if not isinstance(titles, list):
        titles = []
    else:
        titles = [t.strip() for t in titles if isinstance(t, str) and t.strip()]

    # locations — {presets, custom, customSelected, remote}
    raw_locs = preferences.get("locations") if isinstance(preferences.get("locations"), dict) else {}
    if not isinstance(raw_locs, dict):
        raw_locs = {}

    def _str_list(v):
        if not isinstance(v, list):
            return []
        return [s.strip() for s in v if isinstance(s, str) and s.strip()]

    presets = _str_list(raw_locs.get("presets"))
    custom = _str_list(raw_locs.get("custom"))
    custom_selected = _str_list(raw_locs.get("customSelected"))
    # only keep customSelected entries that are in custom (mirrors jobs_controller)
    if custom:
        custom_selected = [c for c in custom_selected if c in custom]
    else:
        custom_selected = []

    remote = raw_locs.get("remote") is True

    locations = {
        "presets": presets,
        "custom": custom,
        "customSelected": custom_selected,
        "remote": remote,
    }

    # pay — {currency, min?, max?}
    raw_pay = preferences.get("pay") if isinstance(preferences.get("pay"), dict) else {}
    if not isinstance(raw_pay, dict):
        raw_pay = {}
    currency = raw_pay.get("currency")
    if currency not in {"USD", "CAD", "EUR", "GBP"}:
        currency = "USD"
    pay = {"currency": currency}
    for k in ("min", "max"):
        v = raw_pay.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            # finite + non-negative (mirrors jobs_controller)
            import math

            if math.isfinite(v) and v >= 0:
                # keep as number; strip .0 if integer
                pay[k] = v

    result = {
        "sponsorship": sponsorship,
        "opportunityTypes": opp,
        "titles": titles,
        "locations": locations,
        "pay": pay,
    }
    return json.dumps(result, separators=(",", ":"))


@tool(context=True)
def get_user_preferences(tool_context=None) -> str:
    """Fetch non-demographic job preferences as JSON.

    Returns a JSON string with keys: sponsorship, opportunityTypes, titles,
    locations, pay. No personalInformation is ever included.

    Preferences are read from invocation_state["preferences"] (set by
    randy_main.generate_match_score_for_job). If absent, returns defaults.
    """
    prefs = _get_preferences_from_context(tool_context)
    return _filtered_preferences_json(prefs)


# Exposed helper for direct invocation / tests without ToolContext
def get_user_preferences_json(preferences: dict | None = None) -> str:
    """Direct helper: preferences dict -> filtered JSON string (no context)."""
    return _filtered_preferences_json(preferences)
