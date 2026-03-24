import json
import os
import uuid
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date

from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv
import anthropic

from safety_checks import keyword_acute_check, parse_safety_response
from prompt_templates import (
    BIAS_REDUCTION_LIBRARY,
    build_adaptive_batch_prompt,
    build_call2_prompt,
    build_call3_prompt,
    build_call4_prompt,
)
from timeline_parser import validate_and_sort_timeline
from export_formatter import build_export_context

load_dotenv()

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False  # preserve Unicode characters in JSON responses
client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

SESSION_TTL_MINUTES = 90
sessions: dict = {}

# Load demo fixture once at startup
_demo_fixture = None

def _load_demo_fixture() -> dict:
    global _demo_fixture
    if _demo_fixture is None:
        fixture_path = os.path.join(os.path.dirname(__file__), "demo_fixture.json")
        with open(fixture_path, encoding='utf-8') as f:
            _demo_fixture = json.load(f)
    return _demo_fixture


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

def cleanup_sessions():
    cutoff = time.time() - SESSION_TTL_MINUTES * 60
    expired = [sid for sid, s in sessions.items() if s["created_at"] < cutoff]
    for sid in expired:
        del sessions[sid]


def session_expired_response():
    return jsonify({
        "error": "session_expired",
        "message": "Your session has expired. Please start again."
    }), 410


# ---------------------------------------------------------------------------
# Claude helper
# ---------------------------------------------------------------------------

def call_claude(prompt: str, max_tokens: int) -> str | None:
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=max_tokens,
            temperature=0.3,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.content[0].text
    except Exception as e:
        app.logger.error(f"Claude API error: {e}")
        return None


def _strip_fences(raw: str) -> str:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        content = parts[1] if len(parts) > 1 else cleaned
        if content.startswith("json"):
            content = content[4:]
        return content.strip()
    return cleaned


# ---------------------------------------------------------------------------
# Demo helper
# ---------------------------------------------------------------------------

def is_demo_request() -> bool:
    return request.args.get("demo") == "true"


def session_is_demo(session: dict) -> bool:
    return session.get("demo", False)


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("intake.html")


@app.route("/interview")
def interview():
    return render_template("interview.html")


@app.route("/results")
def results():
    return render_template("results.html")


# ---------------------------------------------------------------------------
# API: POST /start
# ---------------------------------------------------------------------------

@app.route("/start", methods=["POST"])
def start():
    data = request.get_json(force=True)
    chief_complaint = (data.get("chief_complaint") or "").strip()

    if not chief_complaint:
        return jsonify({"error": "missing_complaint"}), 400

    # Layer 1: keyword acute check
    if keyword_acute_check(chief_complaint):
        return jsonify({"acute": True})

    cleanup_sessions()

    demo = is_demo_request()

    if demo:
        fixture = _load_demo_fixture()
        questions = fixture["batch1_response"]["questions"]
        batch_done = fixture["batch1_response"].get("done", False)
    else:
        raw = call_claude(build_adaptive_batch_prompt(chief_complaint, [], 1), max_tokens=400)
        if not raw:
            return jsonify({"error": "interview_failed"}), 500
        try:
            parsed = json.loads(_strip_fences(raw))
            questions = parsed["questions"]
            batch_done = parsed.get("done", False)
        except Exception:
            return jsonify({"error": "interview_failed"}), 500

    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "complaint": chief_complaint,
        "current_batch_questions": questions,
        "all_qa": [],
        "batch_number": 1,
        "hpc_complete": batch_done,
        "bias_questions": [],
        "bias_answers": [],
        "call3_safety_cache": None,
        "final_results": None,
        "created_at": time.time(),
        "demo": demo,
    }

    return jsonify({"session_id": session_id, "questions": questions, "done": batch_done})


# ---------------------------------------------------------------------------
# API: POST /next-batch
# ---------------------------------------------------------------------------

@app.route("/next-batch", methods=["POST"])
def next_batch():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    answers = data.get("answers", [])

    session = sessions.get(session_id)
    if not session:
        return session_expired_response()

    # Zip current batch questions with answers and accumulate
    current_questions = session["current_batch_questions"]
    pairs = list(zip(current_questions, answers))
    session["all_qa"].extend(pairs)

    # Layer 1: keyword check on new answers
    joined_answers = " ".join(str(a) for a in answers)
    if keyword_acute_check(joined_answers):
        return jsonify({"acute": True})

    next_batch_number = session["batch_number"] + 1
    session["batch_number"] = next_batch_number

    demo = session_is_demo(session)

    # If we've reached the max batches, signal done
    if next_batch_number > 3:
        session["hpc_complete"] = True
        return jsonify({"done": True})

    if demo:
        fixture = _load_demo_fixture()
        batch_key = f"batch{next_batch_number}_response"
        if batch_key not in fixture:
            session["hpc_complete"] = True
            return jsonify({"done": True})
        batch_data = fixture[batch_key]
        questions = batch_data["questions"]
        batch_done = batch_data.get("done", False)
    else:
        raw = call_claude(
            build_adaptive_batch_prompt(session["complaint"], session["all_qa"], next_batch_number),
            max_tokens=400,
        )
        if not raw:
            return jsonify({"error": "batch_failed"}), 500
        try:
            parsed = json.loads(_strip_fences(raw))
            questions = parsed["questions"]
            batch_done = parsed.get("done", False)
        except Exception:
            return jsonify({"error": "batch_failed"}), 500

    if batch_done or not questions:
        session["hpc_complete"] = True
        return jsonify({"done": True})

    session["current_batch_questions"] = questions
    return jsonify({"questions": questions, "done": False})


# ---------------------------------------------------------------------------
# API: POST /submit-hpc
# ---------------------------------------------------------------------------

@app.route("/submit-hpc", methods=["POST"])
def submit_hpc():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    # Optional final batch answers (if the last batch wasn't submitted via /next-batch)
    final_answers = data.get("answers", [])

    session = sessions.get(session_id)
    if not session:
        return session_expired_response()

    # If there are final answers to flush, append them
    if final_answers and session.get("current_batch_questions"):
        current_questions = session["current_batch_questions"]
        pairs = list(zip(current_questions, final_answers))
        session["all_qa"].extend(pairs)

    hpc_qa = session["all_qa"]

    # Layer 1: keyword check on all answers
    joined_answers = " ".join(str(a) for q, a in hpc_qa)
    if keyword_acute_check(joined_answers):
        return jsonify({"acute": True})

    demo = session_is_demo(session)

    if demo:
        fixture = _load_demo_fixture()
        bias_questions = fixture["call2_response"]["bias_questions"]
        safety_raw = json.dumps(fixture["call3_response"])
    else:
        # Calls 2 + 3 in parallel
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_bias = executor.submit(
                call_claude,
                build_call2_prompt(session["complaint"], hpc_qa, BIAS_REDUCTION_LIBRARY),
                400,
            )
            future_safety = executor.submit(
                call_claude,
                build_call3_prompt(session["complaint"], hpc_qa),
                150,
            )
            raw_bias = future_bias.result(timeout=30)
            safety_raw = future_safety.result(timeout=30)

        if not raw_bias or not safety_raw:
            return jsonify({"error": "processing_failed"}), 500

        try:
            bias_parsed = json.loads(_strip_fences(raw_bias))
            bias_questions = bias_parsed["bias_questions"]
        except Exception:
            return jsonify({"error": "processing_failed"}), 500

    # Layer 2 + 3: safety classifier
    if not safety_raw:
        return jsonify({"acute": True})

    acute = parse_safety_response(safety_raw)

    # Cache safety result in session
    try:
        session["call3_safety_cache"] = json.loads(_strip_fences(safety_raw))
    except Exception:
        session["call3_safety_cache"] = {"acute_symptoms_detected": acute}

    if acute:
        return jsonify({"acute": True})

    session["bias_questions"] = bias_questions

    return jsonify({"bias_questions": bias_questions, "acute": False})


# ---------------------------------------------------------------------------
# API: POST /submit-bias
# ---------------------------------------------------------------------------

@app.route("/submit-bias", methods=["POST"])
def submit_bias():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    bias_answers = data.get("bias_answers", [])

    session = sessions.get(session_id)
    if not session:
        return session_expired_response()

    session["bias_answers"] = bias_answers

    today_date = date.today().strftime("%d %B %Y")

    # Call 4 is ALWAYS live — even in demo mode
    raw = call_claude(
        build_call4_prompt(
            session["complaint"],
            session["all_qa"],
            bias_answers,
            today_date=today_date,
        ),
        max_tokens=1600,
    )

    if raw:
        parsed = validate_and_sort_timeline(raw)
        if not parsed.get("_parse_error"):
            results = {**parsed, "partial": False}
            session["final_results"] = results
            return jsonify(results)

    # Fallback: use cached intermediate data
    fallback = {
        "timeline_entries": [],
        "chief_complaint_sentence": session.get("complaint", ""),
        "modifying_factors": [],
        "associated_symptoms": [],
        "background": {"family_history": None, "medications": None, "travel": None, "weight_changes": None, "other": []},
        "patient_quote": session.get("complaint", ""),
        "completeness": None,
        "partial": True,
        "message": "We couldn't process your additional answers fully. Here's what we have — you can still export this summary.",
    }
    session["final_results"] = fallback
    return jsonify(fallback)


# ---------------------------------------------------------------------------
# GET /export
# ---------------------------------------------------------------------------

@app.route("/export")
def export():
    session_id = request.args.get("session_id")
    session = sessions.get(session_id)

    if not session:
        return (
            "<html><body style='font-family:Arial;padding:2rem'>"
            "<h2>Export link expired</h2>"
            "<p>This export link has expired. Please return to the tool and export again.</p>"
            "<p><a href='/'>Return to Symptom Timeline Builder</a></p>"
            "</body></html>"
        )

    context = build_export_context(session)
    return render_template("export_template.html", **context)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, threaded=True, port=5000)
