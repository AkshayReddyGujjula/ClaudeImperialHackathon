# Medi-Scribe — AI-Powered Symptom History Intake

**Track:** Biology & Physical Health

MedHist is a web application that helps patients document their symptom history through an adaptive AI interview, producing a structured clinical timeline for handover to a healthcare professional. The tool uses a multi-layered safety pipeline to detect acute symptoms and ensure appropriate escalation.

---

## How It Works

The intake flow runs entirely in-browser and consists of four stages.

### 1. Chief Complaint

The patient enters their main symptom or health concern.

### 2. Adaptive History-Taking Interview (3 batches)

Claude conducts a structured interview following the HPC (History of Presenting Complaint) framework, covering:

- Onset, character, location, severity
- Timing patterns, modifying factors, context
- Follow-up questions adapt based on previous answers

### 3. Bias-Reduction & Safety Triage

Two parallel checks run on the accumulated symptom data:

- **Bias-reduction questions** — selects 3–5 from a library of 20 to surface commonly missed systemic factors (medications, family history, travel, infections, etc.)
- **Acute symptom classifier** — detects active emergency-category symptoms (chest pain, breathing difficulty, etc.) and escalates immediately

### 4. Clinical Timeline Generation

The full history is compiled into a structured JSON document containing:

- Chronological timeline of events with confidence ratings
- Chief complaint summary
- Modifying factors and associated symptoms
- Background context (family history, medications, travel, etc.)
- Information completeness score

Results can be exported as a formatted HTML summary.

---

## Safety Layers

| Layer | Mechanism | Triggered By |
| ----- | --------- | ------------ |
| 1 | Keyword pre-check on all user input | Any input containing acute keywords (e.g. "chest pain right now") |
| 2 | Claude safety classifier (Call 3) | After HPC interview completion |
| 3 | Fail-safe defaults | Any parse error → escalates |

When acute symptoms are detected at any point, the patient is shown a crisis banner and advised to call 999 / NHS 111 / visit A&E immediately.

---

## Project Structure

```
.
├── app.py                  # Flask server, session management, API routes
├── prompt_templates.py     # All Claude prompt builders
├── safety_checks.py        # Keyword pre-check and safety response parser
├── timeline_parser.py      # Validation and sorting for timeline JSON
├── export_formatter.py     # HTML export context builder
├── requirements.txt        # Python dependencies
├── demo_fixture.json       # Pre-recorded demo responses
├── templates/
│   ├── intake.html         # Chief complaint entry page
│   ├── interview.html      # Multi-batch interview page
│   ├── results.html        # Timeline results page
│   └── export_template.html # Printable/exportable summary
└── static/
    ├── main.js             # Frontend interview logic and API calls
    ├── style.css           # Styles
    └── print.css           # Print-specific styles
```

---

## Tech Stack

- **Backend:** Flask (Python)
- **AI:** Anthropic Claude API (Claude Haiku)
- **Frontend:** Vanilla JS, HTML/CSS
- **Session TTL:** 90 minutes (in-memory)

---

## Setup

1. **Clone and install dependencies:**

```bash
pip install -r requirements.txt
```

2. **Set your API key:**

```bash
# .env
ANTHROPIC_API_KEY=your_key_here
```

3. **Run the server:**

```bash
python app.py
```

4. **Open in browser:**

```
http://localhost:5000
```

---

## Demo Mode

Append `?demo=true` to the intake URL to run through the full flow with pre-recorded responses — no API key required:

```
http://localhost:5000/?demo=true
```

---

## Ethical Considerations

This tool is designed to **assist** the healthcare process — not replace it:

- No diagnosis or treatment recommendations are ever made
- Acute symptoms always trigger escalation guidance
- Patient data stays in-memory only (no persistent storage)
- The tool is explicitly transparent about what it can and cannot do

The bias-reduction library intentionally avoids introducing new symptom categories the patient hasn't mentioned, to prevent leading questions.

---

## Hackathon Context

Built for the **Claude Builder Club Spring 2026 Hackathon** at Imperial College London — theme: social impact through AI.

**Track:** Biology & Physical Health — improving access to healthcare through better history-taking.
