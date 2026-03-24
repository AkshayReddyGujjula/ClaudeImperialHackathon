import json


def _strip_code_fences(raw: str) -> str:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        # parts[1] is the content between first pair of fences
        content = parts[1] if len(parts) > 1 else cleaned
        if content.startswith("json"):
            content = content[4:]
        return content.strip()
    return cleaned


_VALID_CONFIDENCE = {"exact", "approximate", "inferred"}


def validate_and_sort_timeline(raw_json: str) -> dict:
    """
    Parse Claude Call 4 JSON output, validate timeline entries, sort by weeks_ago descending.
    Returns cleaned result dict or fallback on failure.
    """
    try:
        cleaned = _strip_code_fences(raw_json)
        data = json.loads(cleaned)

        entries = data.get("timeline_entries", [])
        valid_entries = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if "weeks_ago" not in entry or "description" not in entry:
                continue
            # Ensure weeks_ago is an integer
            try:
                entry["weeks_ago"] = int(entry["weeks_ago"])
            except (ValueError, TypeError):
                continue
            entry.setdefault("event_type", "symptom_onset")
            entry.setdefault("severity", None)
            # Validate and default confidence field
            confidence = entry.get("confidence", "approximate")
            if confidence not in _VALID_CONFIDENCE:
                confidence = "approximate"
            entry["confidence"] = confidence
            valid_entries.append(entry)

        # Sort descending by weeks_ago (oldest first)
        valid_entries.sort(key=lambda e: e["weeks_ago"], reverse=True)
        data["timeline_entries"] = valid_entries

        # Validate completeness object
        completeness = data.get("completeness")
        if completeness and isinstance(completeness, dict):
            try:
                completeness["score"] = int(completeness.get("score", 5))
                completeness["score"] = max(1, min(10, completeness["score"]))
                if not isinstance(completeness.get("missing_dimensions"), list):
                    completeness["missing_dimensions"] = []
            except (ValueError, TypeError):
                data["completeness"] = None
        else:
            data["completeness"] = None

        return data

    except Exception:
        return {
            "timeline_entries": [],
            "chief_complaint_sentence": "",
            "modifying_factors": [],
            "associated_symptoms": [],
            "background": {
                "family_history": None,
                "medications": None,
                "travel": None,
                "weight_changes": None,
                "other": [],
            },
            "patient_quote": "",
            "completeness": None,
            "_parse_error": True,
        }
