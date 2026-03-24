BIAS_REDUCTION_LIBRARY = [
    "Have you noticed any changes to your weight recently — either up or down?",
    "Have you had any fevers or night sweats?",
    "Is there anyone in your family with similar symptoms or related conditions?",
    "Have you travelled abroad in the last 6 months?",
    "Are you taking any medications, supplements, or herbal remedies?",
    "Have you had any major stress or significant life changes around when this started?",
    "Did you have any infections or illnesses just before the symptoms began?",
    "Have you noticed any changes in your appetite or energy levels?",
    "Any rashes, skin changes, or unusual marks on your body?",
    "Any changes to your sleep patterns?",
    "Any dizziness, fainting, or balance problems?",
    "Any numbness or tingling anywhere?",
    "Any vision changes or headaches?",
    "Any digestive issues — nausea, vomiting, diarrhoea, or constipation?",
    "Any breathing difficulties or persistent cough?",
    "Have you experienced any changes to your hormonal or reproductive health?",
    "Any recent dental work or other medical procedures?",
    "Any exposure to chemicals, animals, or new environments at work or home?",
    "Have you been more thirsty than usual or urinating more often?",
    "Any joint swelling or morning stiffness lasting more than 30 minutes?",
]

_GROUNDING_RULES = """
STRICT GROUNDING RULES — THESE ARE MANDATORY:
1. You may ONLY ask about symptoms, body parts, or experiences the patient has EXPLICITLY mentioned in their complaint or previous answers.
2. If the patient mentions "knee pain", ask about the knee pain's onset, character, severity, etc. Do NOT ask about exhaustion, headaches, nausea, or any other symptom the patient has not mentioned.
3. You MAY ask about directly related physical observations of the mentioned area (e.g. "Have you noticed any swelling around the knee?" is acceptable because it concerns the stated symptom site).
4. You MAY ask about context and preceding events (e.g. "Did anything happen just before the pain started?" explores the history of the stated symptom without introducing a new one).
5. NEVER introduce a new symptom category the patient has not already described.
6. Before writing each question, ask yourself: "Has the patient explicitly mentioned this symptom or body area?" If the answer is no, do not ask about it.
7. If the patient has already answered a dimension (e.g. they gave a severity score in their complaint), do not ask about it again.
"""

_HPC_DIMENSIONS = [
    "Onset (when it started, sudden vs gradual)",
    "Character (quality: dull, sharp, burning, pressure, aching)",
    "Location and radiation (where exactly, does it spread)",
    "Severity (1–10 scale, at worst and at best)",
    "Timing (constant vs episodic, duration of episodes, time of day)",
    "Modifying factors (what makes it better or worse)",
    "Associated symptoms (only those the patient mentions or directly reports)",
    "Context (preceding events, activities, illnesses, life changes)",
]


def build_adaptive_batch_prompt(
    chief_complaint: str,
    previous_qa: list,  # list of (question, answer) tuples
    batch_number: int,
) -> str:
    prev_qa_text = ""
    if previous_qa:
        pairs = "\n".join(f"Q: {q}\nA: {a}" for q, a in previous_qa)
        prev_qa_text = f"\nPrevious questions and answers:\n{pairs}\n"

    dimensions_text = "\n".join(f"- {d}" for d in _HPC_DIMENSIONS)

    if batch_number == 1:
        focus = (
            "This is the FIRST batch of questions. Focus on the most fundamental HPC dimensions: "
            "onset (when it started, sudden or gradual), character (what the symptom feels like), "
            "and location/severity. Generate exactly 3 questions."
        )
    elif batch_number == 2:
        focus = (
            "This is the SECOND batch. Review the answers above and identify which HPC dimensions "
            "have NOT yet been addressed. Focus on: timing pattern (constant vs episodic), "
            "modifying factors (what makes it better or worse), and context (any preceding events or triggers). "
            "Generate exactly 3 questions targeting the gaps. Do NOT repeat anything already answered."
        )
    else:
        focus = (
            "This is the FINAL batch. Review ALL answers above carefully. Ask 2–3 targeted follow-up questions "
            "about anything that was vague, incomplete, or clinically important based on what the patient has said. "
            "If all key dimensions are well-covered, you may set 'done' to true and return fewer questions. "
            "Do NOT repeat anything already answered."
        )

    return f"""You are a medical history interviewer. Your role is ONLY to gather information — never diagnose, never recommend treatment, never interpret symptoms.

The patient's chief complaint: "{chief_complaint}"
{prev_qa_text}
The HPC (History of Presenting Complaint) dimensions to cover across all batches:
{dimensions_text}

Your task for this batch:
{focus}

{_GROUNDING_RULES}

Additional rules:
- Use plain language at a 12-year-old reading level — no medical jargon
- Detect the language the patient used and respond in that language
- Questions should be conversational and empathetic
- Each question should be a single, clear question — not a compound question

Return ONLY valid JSON in this exact format, no other text:
{{"questions": ["question 1", "question 2", "question 3"], "done": false}}

If all key HPC dimensions are already well-covered and no more questions are needed, return:
{{"questions": [], "done": true}}"""


def build_call2_prompt(chief_complaint: str, hpc_qa: list, bias_library: list) -> str:
    qa_text = "\n".join(f"Q: {q}\nA: {a}" for q, a in hpc_qa)
    library_text = "\n".join(f"{i+1}. {q}" for i, q in enumerate(bias_library))
    return f"""You are a diagnostic completeness assistant.

The patient's chief complaint: "{chief_complaint}"

Their symptom history (questions and answers):
{qa_text}

Below is a library of 20 bias-reduction questions. Select 3–5 questions that are most likely to surface diagnostically critical information not yet mentioned by this patient. Respond in the same language as the patient's input.

Prioritise questions that:
- Reveal systemic red flags or conditions commonly missed
- Uncover contextual factors (medications, family history, travel, infections, stress) not yet addressed
- Surface connections between systemic factors and the presenting complaint

IMPORTANT: Select only questions about SYSTEMIC or CONTEXTUAL factors. Do NOT select questions that assume specific symptoms the patient has not reported. For example, if the patient has not mentioned fatigue or energy problems, do not select the question about appetite/energy changes. Stick to questions that ask about background factors, not new symptom categories.

Bias-reduction library:
{library_text}

Return ONLY valid JSON in this exact format, no other text:
{{"bias_questions": ["selected question 1", "selected question 2", ...]}}"""


def build_call3_prompt(chief_complaint: str, hpc_qa: list) -> str:
    qa_text = "\n".join(f"Q: {q}\nA: {a}" for q, a in hpc_qa)
    return f"""You are an acute symptom safety classifier. Your ONLY task is to determine if any symptoms described are currently active and clinically acute.

Chief complaint: "{chief_complaint}"
Symptom history:
{qa_text}

CRITICAL DISTINCTION:
- "I have chest pain right now" → ACUTE (current and active)
- "I had chest pain last month that resolved" → NOT ACUTE (historical)

Only output acute_symptoms_detected: true if a symptom is BOTH currently active AND falls into an emergency category (chest pain, breathing difficulty, severe head trauma, sudden confusion, heavy active bleeding, symptoms of stroke or heart attack).

Return ONLY valid JSON, no other text:
{{"acute_symptoms_detected": false, "red_flag_category": null}}

Or if acute:
{{"acute_symptoms_detected": true, "red_flag_category": "chest_pain_999 | breathing_999 | head_trauma_999 | confusion_999 | bleeding_999"}}"""


def build_call4_prompt(
    chief_complaint: str,
    hpc_qa: list,
    bias_answers: list,
    today_date: str,
) -> str:
    hpc_text = "\n".join(f"Q: {q}\nA: {a}" for q, a in hpc_qa)
    bias_text = "\n".join(f"- {a}" for a in bias_answers)
    return f"""You are a clinical documentation assistant. Your role is to organise a patient's symptom history into a structured timeline and summary. Never diagnose, never recommend treatment.

Today's date: {today_date}

Patient's chief complaint: "{chief_complaint}"

Their symptom history (questions and answers):
{hpc_text}

Their answers to additional background questions:
{bias_text}

Tasks:
1. Build a chronological timeline of all events, symptoms, and relevant factors mentioned
2. Map ALL vague temporal language to integer weeks_ago values from today ({today_date}): e.g. "around Christmas" = approximately 13 weeks ago, "a few months ago" = approximately 12 weeks ago
3. For each timeline entry, assess your confidence in the timing:
   - "exact": patient gave a specific date or precise timeframe
   - "approximate": patient used vague language like "a few months" or "around summer"
   - "inferred": timing was calculated from indirect clues (e.g. "before my holiday")
4. Compile a structured clinical summary
5. Assess information completeness: score 1–10 and list any important HPC dimensions not well-covered

For event_type use exactly one of: symptom_onset, symptom_progression, new_symptom, medical_event, lifestyle_factor
For severity: integer 1–10 or null if not mentioned. Omit if null.
Respond in the same language as the patient's input.

Return ONLY valid JSON in this exact format, no other text:
{{
  "timeline_entries": [
    {{
      "weeks_ago": 20,
      "event_type": "symptom_onset",
      "description": "one sentence plain English description",
      "severity": 3,
      "confidence": "approximate"
    }}
  ],
  "chief_complaint_sentence": "one sentence summary of the chief complaint",
  "modifying_factors": ["factor 1", "factor 2"],
  "associated_symptoms": ["symptom 1", "symptom 2"],
  "background": {{
    "family_history": "string or null",
    "medications": "string or null",
    "travel": "string or null",
    "weight_changes": "string or null",
    "other": ["item 1"]
  }},
  "patient_quote": "verbatim chief complaint text",
  "completeness": {{
    "score": 7,
    "missing_dimensions": ["timing pattern not fully explored", "no information about family history"]
  }}
}}"""
