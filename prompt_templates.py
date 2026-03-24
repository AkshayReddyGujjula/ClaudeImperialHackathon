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


def build_call1_prompt(chief_complaint: str) -> str:
    return f"""You are a medical history interviewer. Your role is ONLY to gather information — never diagnose, never recommend treatment, never interpret symptoms.

The patient's chief complaint is: "{chief_complaint}"

Generate 8–12 follow-up questions to help the patient describe their symptoms fully. Use the HPC (History of Presenting Complaint) framework:
- Onset: when it started, sudden vs gradual
- Character: quality of the symptom (dull, sharp, burning, pressure)
- Location and radiation
- Severity: 1–10 scale, at worst and at best
- Timing: constant vs episodic, duration of episodes
- Modifying factors: what makes it better or worse
- Associated symptoms
- Context: preceding events, illnesses, life changes

Rules:
- Use plain language at a 12-year-old reading level — no medical jargon
- Detect the language the patient used and respond in that language
- Questions should be conversational and empathetic
- Do not ask for information the patient already provided in their complaint

Return ONLY valid JSON in this exact format, no other text:
{{"questions": ["question 1", "question 2", ...]}}"""


def build_call2_prompt(chief_complaint: str, hpc_answers: list, bias_library: list) -> str:
    answers_text = "\n".join(f"- {a}" for a in hpc_answers)
    library_text = "\n".join(f"{i+1}. {q}" for i, q in enumerate(bias_library))
    return f"""You are a diagnostic completeness assistant.

The patient's chief complaint: "{chief_complaint}"

Their answers so far:
{answers_text}

Below is a library of 20 bias-reduction questions. Select 3–5 questions that are most likely to surface diagnostically critical information not yet mentioned by this patient. Do not select questions the patient has already answered. Respond in the same language as the patient's input.

Prioritise questions that:
- Reveal conditions commonly missed due to patient self-censorship
- Surface systemic red flags
- Uncover conditions with non-obvious connections to the presenting complaint

Bias-reduction library:
{library_text}

Return ONLY valid JSON in this exact format, no other text:
{{"bias_questions": ["selected question 1", "selected question 2", ...]}}"""


def build_call3_prompt(chief_complaint: str, hpc_answers: list) -> str:
    answers_text = "\n".join(f"- {a}" for a in hpc_answers)
    return f"""You are an acute symptom safety classifier. Your ONLY task is to determine if any symptoms described are currently active and clinically acute.

Chief complaint: "{chief_complaint}"
Answers:
{answers_text}

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
    hpc_answers: list,
    bias_answers: list,
    today_date: str = "24 March 2026",
) -> str:
    hpc_text = "\n".join(f"- {a}" for a in hpc_answers)
    bias_text = "\n".join(f"- {a}" for a in bias_answers)
    return f"""You are a clinical documentation assistant. Your role is to organise a patient's symptom history into a structured timeline and summary. Never diagnose, never recommend treatment.

Today's date: {today_date}

Patient's chief complaint: "{chief_complaint}"

Their answers to history questions:
{hpc_text}

Their answers to additional questions:
{bias_text}

Tasks:
1. Build a chronological timeline of all events, symptoms, and relevant factors mentioned
2. Map ALL vague temporal language to integer weeks_ago values from today ({today_date}): e.g. "around Christmas" = approximately 13 weeks ago, "a few months ago" = approximately 12 weeks ago
3. Compile a structured clinical summary

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
      "severity": 3
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
  "patient_quote": "verbatim chief complaint text"
}}"""
