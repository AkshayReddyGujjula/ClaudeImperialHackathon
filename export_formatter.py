from datetime import date


def build_export_context(session: dict) -> dict:
    """Build template context for export_template.html from session data."""
    results = session.get("final_results", {})
    timeline = results.get("timeline_entries", [])
    background = results.get("background", {}) or {}

    # Filter out null background fields for cleaner rendering
    background_items = {}
    if background.get("family_history"):
        background_items["Family history"] = background["family_history"]
    if background.get("medications"):
        background_items["Medications / supplements"] = background["medications"]
    if background.get("travel"):
        background_items["Recent travel"] = background["travel"]
    if background.get("weight_changes"):
        background_items["Weight changes"] = background["weight_changes"]
    other = background.get("other") or []

    return {
        "generated_date": "24 March 2026",
        "chief_complaint_sentence": results.get("chief_complaint_sentence", session.get("complaint", "")),
        "timeline_entries": timeline,
        "modifying_factors": results.get("modifying_factors", []),
        "associated_symptoms": results.get("associated_symptoms", []),
        "background_items": background_items,
        "background_other": other,
        "patient_quote": results.get("patient_quote", session.get("complaint", "")),
        "partial": results.get("partial", False),
    }
