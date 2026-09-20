import json
import logging
import os
from pathlib import Path

import requests

TEX_FILE = "cover_letter_template.tex"
# Resolve pdf_out relative to backend/ so it works regardless of CWD (mirrors custom_resume.py)
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pdf_out")
TEMPLATE_PATH = Path(__file__).with_name(TEX_FILE)

logger = logging.getLogger(__name__)

DEFAULT_LATEX_SERVICE_URL = "https://randy-the-otter-production.up.railway.app/compile"

def escape_latex(text):
    """Escape LaTeX special characters in a string so it compiles safely."""
    replacements = {
        "&": "\\&",
        "%": "\\%",
        "$": "\\$",
        "#": "\\#",
        "_": "\\_",
        "{": r"\\{",
        "}": r"\\}",
        "~": r"\\textasciitilde{}",
        "^": r"\\textasciicircum{}",
    }
    for char, escaped in replacements.items():
        text = text.replace(char, escaped)
    return text

def normalize_unicode(text):
    """Replace common 'smart' typography with LaTeX-safe equivalents."""
    replacements = {
        "\u2014": "---",  # em dash
        "\u2013": "--",   # en dash
        "\u2018": "`",    # left single quote
        "\u2019": "'",    # right single quote
        "\u201c": "``",   # left double quote
        "\u201d": "''",   # right double quote
    }
    for char, replacement in replacements.items():
        text = text.replace(char, replacement)
    return text

def _require_personal_field(preferences, key: str) -> str:
    """Extract a required personal field from chrome.storage preferences.

    Raises ValueError if preferences is missing or the field is blank — the
    cover-letter agent REQUIREs chrome.storage (no env fallback).
    """
    if not isinstance(preferences, dict):
        raise ValueError(
            f"cover letter requires chrome.storage preferences — missing preferences dict (need personalInformation.{key})"
        )
    personal = preferences.get("personalInformation")
    if not isinstance(personal, dict):
        raise ValueError(
            f"cover letter requires chrome.storage preferences — missing personalInformation (need {key})"
        )
    value = personal.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"cover letter requires chrome.storage preferences — personalInformation.{key} is required and cannot be empty"
        )
    return value.strip()


def generate_cover_letter(
        company_name,
        title,
        body,
        preferences=None,
        address=None,
        phone_number=None,
        email=None,
        first_name=None,
        last_name=None,
    ):
    # Preferences are REQUIRED — chrome.storage only, no env fallback.
    # Explicit args (address/phone/etc.) are only for direct unit tests;
    # when preferences is supplied they are ignored in favour of the stored values.
    if preferences is not None:
        first_name = _require_personal_field(preferences, "firstName")
        last_name = _require_personal_field(preferences, "lastName")
        email = _require_personal_field(preferences, "email")
        phone_number = _require_personal_field(preferences, "phoneNumber")
        address = _require_personal_field(preferences, "homeAddress")
    else:
        # No preferences dict — still validate explicit args (no os.getenv fallback)
        for field_name, val in [
            ("firstName", first_name),
            ("lastName", last_name),
            ("email", email),
            ("phoneNumber", phone_number),
            ("homeAddress", address),
        ]:
            if not isinstance(val, str) or not val.strip():
                raise ValueError(
                    f"cover letter requires chrome.storage preferences — {field_name} missing (pass preferences with personalInformation.{field_name})"
                )
        first_name = first_name.strip()
        last_name = last_name.strip()
        email = email.strip()
        phone_number = phone_number.strip()
        address = address.strip()

    # Unified job metadata may arrive as None/empty (uncached or null cache
    # fields) — coerce so str.replace never crashes; agent prompt already
    # falls back to inference, this is just a safety net.
    company_name = company_name if isinstance(company_name, str) and company_name.strip() else "Hiring Team"
    title = title if isinstance(title, str) and title.strip() else "this position"

    # Sanitize header/company fields for LaTeX (mirrors custom_resume.py)
    first_name = escape_latex(normalize_unicode(first_name))
    last_name = escape_latex(normalize_unicode(last_name))
    address = escape_latex(normalize_unicode(address))
    phone_number = escape_latex(normalize_unicode(phone_number))
    email = escape_latex(normalize_unicode(email))
    company_name = escape_latex(normalize_unicode(company_name))
    title = escape_latex(normalize_unicode(title))

    # Resolve template relative to this file first, then CWD fallback (mirrors custom_resume.py)
    tpl = TEMPLATE_PATH
    if not tpl.exists():
        alt = Path(os.getcwd()) / "tools" / TEX_FILE
        if alt.exists():
            tpl = alt
    with open(tpl, "r", encoding="utf-8") as f:
        filestring = f.read()

    filestring = filestring.replace("FIRSTNAME", first_name)
    filestring = filestring.replace("LASTNAME", last_name)
    filestring = filestring.replace("ADDRESS", address)
    filestring = filestring.replace("PHONENUMBER", phone_number)
    filestring = filestring.replace("EMAIL", email)
    filestring = filestring.replace("TITLE", title)
    filestring = filestring.replace("COMPANYNAME", company_name)

    body = normalize_unicode(body)
    body = escape_latex(body)
    body = body.replace("\n", "\\\\")
    filestring = filestring.replace("CONTENTBODY", body)

    return filestring

def compile_tex(filestring, company_name):
    """Compile tex via remote LaTeX service and save the returned PDF.

    Strictly remote — no local pdflatex fallback. Endpoint expects
    POST {\"tex\": \"...\"} with Authorization: Bearer <LATEX_SERVICE_TOKEN>.
    """
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    safe_company = "".join(c for c in str(company_name) if c not in '/\\"').strip() or "Hiring Team"
    base_name = f"{safe_company}_cover_letter"
    pdf_path = os.path.join(OUTPUT_DIR, f"{base_name}.pdf")

    token = os.getenv("LATEX_SERVICE_TOKEN")
    if not token or not token.strip():
        logger.error("LATEX_SERVICE_TOKEN not set — cannot compile cover letter")
        print("Compilation failed: LATEX_SERVICE_TOKEN not set")
        return None

    url = os.getenv("LATEX_SERVICE_URL", DEFAULT_LATEX_SERVICE_URL).strip() or DEFAULT_LATEX_SERVICE_URL

    # Body must be JSON with key "tex" containing the full tex string
    payload = json.dumps({"tex": filestring})

    try:
        resp = requests.post(
            url,
            data=payload,
            headers={
                "Authorization": f"Bearer {token.strip()}",
                "Content-Type": "application/json",
            },
            timeout=300,  # 5 minutes — covers cold start
        )
    except requests.RequestException as e:
        logger.exception("LaTeX service request failed for %s: %s", base_name, e)
        print(f"Compilation failed: LaTeX service request error: {e}")
        return None

    if resp.status_code != 200:
        detail = resp.text[:5000] if resp.text else f"HTTP {resp.status_code}"
        logger.error("LaTeX service error %s for %s: %s", resp.status_code, base_name, detail[:500])
        print(f"Compilation failed. Service returned {resp.status_code}:")
        print(detail[-2000:])
        return None

    if not resp.content or not resp.content.startswith(b"%PDF"):
        # Service returned 200 but not a PDF — treat as failure
        logger.error("LaTeX service returned non-PDF for %s (len=%s, prefix=%r)", base_name, len(resp.content), resp.content[:20])
        print("Compilation failed: service did not return a PDF")
        return None

    try:
        with open(pdf_path, "wb") as f:
            f.write(resp.content)
    except Exception as e:
        logger.exception("Failed to write PDF %s: %s", pdf_path, e)
        print(f"Compilation failed: could not write PDF: {e}")
        return None

    print(f"Compiled via remote: {pdf_path}")
    return pdf_path


def cv_pipeline(company_name, title, body, preferences=None):
    filled = generate_cover_letter(
        company_name=company_name,
        title=title,
        body=body,
        preferences=preferences,
    )
    return compile_tex(filled, company_name)