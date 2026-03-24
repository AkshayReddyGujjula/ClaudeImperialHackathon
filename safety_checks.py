import json

ACUTE_KEYWORDS = [
    "chest pain",
    "can't breathe",
    "cannot breathe",
    "difficulty breathing",
    "crushing",
    "right now",
    "currently having",
    "passing out",
    "fainted",
    "stroke",
    "seizure",
    "unconscious",
    "bleeding heavily",
    "sudden severe headache",
    "can't speak",
    "cannot speak",
    "face drooping",
    "arm weakness",
    "heart attack",
]

CRISIS_BANNER_TEXT = (
    "\u26a0\ufe0f This may need urgent attention.\n\n"
    "If you are experiencing any of the following RIGHT NOW, stop and seek help immediately:\n"
    "Chest pain or difficulty breathing \u00b7 Sudden severe headache\n"
    "Sudden confusion or slurred speech \u00b7 Heavy bleeding or trauma\n\n"
    "Call 999 \u00b7 Call NHS 111 \u00b7 Go to your nearest A&E"
)


def keyword_acute_check(text: str) -> bool:
    """Layer 1: deterministic keyword pre-check. Returns True if any acute keyword found."""
    lowered = text.lower()
    return any(keyword in lowered for keyword in ACUTE_KEYWORDS)


def parse_safety_response(raw: str) -> bool:
    """
    Layer 3: Parse Call 3 JSON output and extract acute_symptoms_detected.
    Fail-safe: missing field or parse failure → returns True.
    """
    try:
        # Strip markdown code fences if present
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("```")[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:]
            cleaned = cleaned.strip()
        data = json.loads(cleaned)
        if "acute_symptoms_detected" not in data:
            return True  # fail-safe
        return bool(data["acute_symptoms_detected"])
    except Exception:
        return True  # fail-safe
