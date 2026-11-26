import json
import os
import uuid
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from hashlib import sha256
from threading import Lock

from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv
import anthropic
from anthropic.types import OutputConfigParam
from itsdangerous import BadData, URLSafeTimedSerializer

from history_coverage import (
    COVERAGE_RESPONSE_SCHEMA,
    COVERAGE_TARGET,
    MAX_CLARIFICATION_BATCHES,
    assess_coverage,
)
from safety_checks import keyword_acute_check, parse_safety_response
from prompt_templates import (
    BIAS_REDUCTION_LIBRARY,
    build_adaptive_batch_prompt,
    build_call2_prompt,
    build_call3_prompt,
    build_call4_prompt,
)
from timeline_parser import validate_and_sort_timeline
from export_formatter import build_export_context, build_interview_transcript

load_dotenv()

app = Flask(__name__)
app.config['JSON_AS_ASCII'] = False  # preserve Unicode characters in JSON responses
client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

SESSION_TTL_MINUTES = 90
sessions: dict = {}
urgent_tokens = URLSafeTimedSerializer(os.urandom(32), salt="medi-scribe-urgent-warning")
batch_commit_lock = Lock()

BIAS_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {"bias_questions": {"type": "array", "items": {"type": "string"}}},
    "required": ["bias_questions"],
    "additionalProperties": False,
}

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


def require_urgent_acknowledgement(data: dict, *scope):
    """Pause only this step and bind its acknowledgement to the submitted input."""
    fingerprint = sha256(json.dumps(scope, sort_keys=True).encode()).hexdigest()
    token = data.get("urgent_token")
    if isinstance(token, str):
        try:
            if urgent_tokens.loads(token, max_age=SESSION_TTL_MINUTES * 60) == fingerprint:
                return None
        except BadData:
            pass
    return jsonify({"acute": True, "continuation_token": urgent_tokens.dumps(fingerprint)})


def current_question_batch_number(session: dict) -> int:
    previous = session.get("last_batch_submission")
    if previous and previous["response"]["done"]:
        return previous["batch"]
    return session["batch_number"]


def answer_batch_number(session: dict, phase: str) -> int:
    if phase == "coverage":
        return session.get("coverage_round", 0)
    return current_question_batch_number(session)


def has_unacknowledged_acute_answers(session: dict, phase: str, answers: list) -> bool:
    acknowledged = session.get("acknowledged_urgent_answers", {})
    batch_number = answer_batch_number(session, phase)
    return any(
        keyword_acute_check(str(answer)) and acknowledged.get((phase, batch_number, index)) != answer
        for index, answer in enumerate(answers)
    )


def repeat_or_reject_batch(session: dict, batch_number: int, answers: list):
    previous = session.get("last_batch_submission")
    if previous and previous["batch"] == batch_number and previous["answers"] == answers:
        return jsonify(previous["response"])
    return jsonify({"error": "batch_changed"}), 409


# ---------------------------------------------------------------------------
# Claude helper
# ---------------------------------------------------------------------------

def call_claude(prompt: str, max_tokens: int, *, schema: dict | None = None) -> str | None:
    output_config: OutputConfigParam = {"effort": "medium"}
    if schema is not None:
        output_config["format"] = {"type": "json_schema", "schema": schema}

    try:
        response = client.messages.create(
            model="claude-haiku-5-5",
            max_tokens=max_tokens,
            output_config=output_config,
            thinking={"type": "adaptive"},
            messages=[{"role": "user", "content": prompt}],
        )
        if schema is not None and response.stop_reason in {"max_tokens", "refusal"}:
            app.logger.warning("Claude question generation stopped: %s", response.stop_reason)
            return None
        return "".join(
            block.text
            for block in response.content
            if block.type == "text"
        ) or None
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


def parse_question_response(raw: str | None, field: str) -> dict | None:
    if raw:
        try:
            result = json.loads(_strip_fences(raw))
        except ValueError:
            result = None
        if isinstance(result, dict):
            questions = result.get(field)
            if isinstance(questions, list) and all(isinstance(q, str) and q.strip() for q in questions):
                return result

    app.logger.warning("Claude did not return a usable %s response", field)
    return None


def generate_question_batch(chief_complaint: str, history: list, batch_number: int | None, planned_checks=None) -> dict | None:
    raw = call_claude(
        build_adaptive_batch_prompt(chief_complaint, history, batch_number, planned_checks),
        max_tokens=6144,
        schema=COVERAGE_RESPONSE_SCHEMA,
    )
    batch = parse_question_response(raw, "questions")
    if batch is None or not isinstance(batch.get("acute_symptoms_detected"), bool):
        return None
    coverage = assess_coverage(batch, chief_complaint, history, planned_checks)
    if coverage is None:
        return None
    questions = coverage["questions"][:4 if batch_number is None else 3]
    return {**coverage, "questions": questions, "done": not questions, "acute_symptoms_detected": batch["acute_symptoms_detected"]}


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

    demo = is_demo_request()
    urgent_scope = ("start", demo, chief_complaint)

    if keyword_acute_check(chief_complaint):
        warning = require_urgent_acknowledgement(data, *urgent_scope)
        if warning is not None:
            return warning

    cleanup_sessions()

    if demo:
        batch = _load_demo_fixture()["batch1_response"]
    else:
        batch = generate_question_batch(chief_complaint, [], 1)
    if batch and batch.get("acute_symptoms_detected"):
        warning = require_urgent_acknowledgement(data, *urgent_scope)
        if warning is not None:
            return warning
    if not batch or not batch["questions"]:
        return jsonify({"error": "interview_failed"}), 502

    questions = batch["questions"]
    batch_done = batch.get("done", False)
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "complaint": chief_complaint,
        "planned_checks": batch.get("planned_checks", {}),
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


# Check individual answers before showing another question from the current batch.
@app.route("/check-answer", methods=["POST"])
def check_answer():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    session = sessions.get(session_id)
    if not session:
        return session_expired_response()

    phase, index, answer = data.get("phase"), data.get("index"), data.get("answer")
    question_fields = {"hpc": "current_batch_questions", "bias": "bias_questions", "coverage": "coverage_questions"}
    if not isinstance(phase, str) or phase not in question_fields or type(index) is not int or not isinstance(answer, str):
        return jsonify({"error": "invalid_answer"}), 400
    batch_number = answer_batch_number(session, phase)
    if phase != "bias" and data.get("batch_number") != batch_number:
        return jsonify({"error": "batch_changed"}), 409
    questions = session.get(question_fields[phase], [])
    if not 0 <= index < len(questions):
        return jsonify({"error": "invalid_answer"}), 400

    if keyword_acute_check(answer):
        acknowledged = session.setdefault("acknowledged_urgent_answers", {})
        key = (phase, batch_number, index)
        if acknowledged.get(key) != answer:
            warning = require_urgent_acknowledgement(data, "answer", session_id, *key, answer)
            if warning is not None:
                return warning
            acknowledged[key] = answer
    return jsonify({"acute": False})


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

    current_batch = session["batch_number"]
    submitted_batch = data.get("batch_number", current_batch)
    if submitted_batch != current_batch:
        return repeat_or_reject_batch(session, submitted_batch, answers)

    urgent_scope = ("next-batch", session_id, current_batch, answers)
    if has_unacknowledged_acute_answers(session, "hpc", answers):
        warning = require_urgent_acknowledgement(data, *urgent_scope)
        if warning is not None:
            return warning

    pairs = list(zip(session["current_batch_questions"], answers))
    hpc_qa = session["all_qa"] + pairs
    next_batch_number = current_batch + 1
    questions = []
    batch_done = True
    batch_data = None

    if next_batch_number <= 3:
        if session_is_demo(session):
            batch_data = _load_demo_fixture().get(f"batch{next_batch_number}_response")
        else:
            batch_data = generate_question_batch(session["complaint"], hpc_qa, next_batch_number, session.get("planned_checks"))
            if batch_data and batch_data.get("acute_symptoms_detected"):
                warning = require_urgent_acknowledgement(data, *urgent_scope)
                if warning is not None:
                    return warning
            if batch_data is None or (not batch_data["questions"] and not batch_data["done"]):
                return jsonify({"error": "batch_failed"}), 502
        if batch_data:
            questions = batch_data["questions"]
            batch_done = batch_data.get("done", False)

    done = not questions
    result = {"done": True} if done else {"questions": questions, "done": False}
    if questions and batch_done:
        result["final_batch"] = True
    batch_submission = {"batch": current_batch, "answers": answers, "response": result}
    updates = {"batch_number": next_batch_number, "last_batch_submission": batch_submission}
    if batch_data and "planned_checks" in batch_data:
        updates["planned_checks"] = batch_data["planned_checks"]
    if done:
        updates.update(hpc_complete=True, final_hpc_qa=pairs)
    else:
        updates.update(all_qa=hpc_qa, current_batch_questions=questions)

    with batch_commit_lock:
        if session["batch_number"] != current_batch:
            return repeat_or_reject_batch(session, current_batch, answers)
        session.update(updates)
    return jsonify(result)


# ---------------------------------------------------------------------------
# API: POST /submit-hpc
# ---------------------------------------------------------------------------

@app.route("/submit-hpc", methods=["POST"])
def submit_hpc():
    data = request.get_json(force=True)
    session_id = data.get("session_id")
    final_answers = data.get("answers", [])

    session = sessions.get(session_id)
    if not session:
        return session_expired_response()
    if session.get("completion_submission"):
        return jsonify({"error": "batch_changed"}), 409

    saved_final_qa = session.get("final_hpc_qa", [])
    final_qa = saved_final_qa
    if final_answers:
        final_qa = list(zip(session["current_batch_questions"], final_answers))
    hpc_qa = session["all_qa"] + final_qa
    urgent_scope = ("submit-hpc", session_id, hpc_qa)

    if final_qa != saved_final_qa and has_unacknowledged_acute_answers(session, "hpc", final_answers):
        warning = require_urgent_acknowledgement(data, *urgent_scope)
        if warning is not None:
            return warning

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
                4096,
                schema=BIAS_RESPONSE_SCHEMA,
            )
            future_safety = executor.submit(
                call_claude,
                build_call3_prompt(session["complaint"], hpc_qa),
                4096,
            )
            raw_bias = future_bias.result(timeout=30)
            safety_raw = future_safety.result(timeout=30)

        bias_result = parse_question_response(raw_bias, "bias_questions")
        bias_questions = bias_result["bias_questions"] if bias_result else None

    safety_result = parse_safety_response(safety_raw)
    if safety_result is None:
        return jsonify({"acute": True, "retry_safety_check": True})
    if safety_result["acute_symptoms_detected"]:
        warning = require_urgent_acknowledgement(data, *urgent_scope)
        if warning is not None:
            return warning

    if not isinstance(bias_questions, list) or not bias_questions:
        return jsonify({"error": "processing_failed"}), 502

    with session.setdefault("completion_lock", Lock()):
        if session.get("completion_submission"):
            return jsonify({"error": "batch_changed"}), 409
        session.update(
            final_hpc_qa=final_qa,
            call3_safety_cache=safety_result,
            bias_questions=bias_questions,
            hpc_complete=True,
        )

    return jsonify({"bias_questions": bias_questions, "acute": False})


# ---------------------------------------------------------------------------
# API: POST /submit-bias
# ---------------------------------------------------------------------------

@app.route("/submit-bias", methods=["POST"])
def submit_bias():
    data = request.get_json(force=True)
    session_id = data.get("session_id")

    session = sessions.get(session_id)
    if not session:
        return session_expired_response()

    round_number = data.get("coverage_round", 0)
    if type(round_number) is not int or not 0 <= round_number <= MAX_CLARIFICATION_BATCHES:
        return jsonify({"error": "invalid_answer"}), 400
    phase = "coverage" if round_number else "bias"
    answers = data.get("coverage_answers" if round_number else "bias_answers", [])
    if not isinstance(answers, list) or not all(isinstance(answer, str) and answer.strip() for answer in answers):
        return jsonify({"error": "invalid_answer"}), 400

    with session.setdefault("completion_lock", Lock()):
        previous = session.get("completion_submission")
        if previous and (previous["round"], previous["answers"]) == (round_number, answers):
            return jsonify(previous["response"])
        if round_number != session.get("coverage_round", 0) or session.get("final_results"):
            return jsonify({"error": "batch_changed"}), 409

        questions = session.get("coverage_questions" if round_number else "bias_questions", [])
        if not questions or len(answers) != len(questions):
            return jsonify({"error": "invalid_answer"}), 400

        urgent_scope = ("submit-bias", session_id, round_number, answers)
        if has_unacknowledged_acute_answers(session, phase, answers):
            warning = require_urgent_acknowledgement(data, *urgent_scope)
            if warning is not None:
                return warning

        bias_answers = session["bias_answers"] if round_number else answers
        coverage_qa = session.get("coverage_qa", [])
        if round_number:
            coverage_qa = coverage_qa + list(zip(questions, answers))
        hpc_qa = session["all_qa"] + session.get("final_hpc_qa", [])
        additional_qa = list(zip(session["bias_questions"], bias_answers)) + coverage_qa
        review = generate_question_batch(session["complaint"], hpc_qa + additional_qa, None, session.get("planned_checks"))
        if review is None:
            return jsonify({"error": "coverage_check_failed"}), 502
        if review["acute_symptoms_detected"]:
            warning = require_urgent_acknowledgement(data, *urgent_scope)
            if warning is not None:
                return warning

        completeness = review["completeness"]
        needs_follow_up = (
            review["has_required_questions"] or review["has_timing_questions"] or completeness["score"] < COVERAGE_TARGET
        )
        updates = {"bias_answers": bias_answers, "coverage_qa": coverage_qa, "planned_checks": review["planned_checks"]}
        if needs_follow_up and review["questions"] and round_number < MAX_CLARIFICATION_BATCHES:
            result = {"coverage_questions": review["questions"], "coverage_round": round_number + 1}
            updates.update(result)
        else:
            transcript = build_interview_transcript({**session, **updates})
            result = build_final_summary(session["complaint"], hpc_qa, additional_qa, completeness, transcript)
            updates.update(final_results=result, coverage_questions=[])
        session.update(updates, completion_submission={"round": round_number, "answers": answers, "response": result})
        return jsonify(result)


def build_final_summary(complaint: str, hpc_qa: list, additional_qa: list, completeness: dict, transcript: list) -> dict:
    raw = call_claude(
        build_call4_prompt(complaint, hpc_qa, additional_qa, today_date=date.today().strftime("%d %B %Y")),
        max_tokens=6144,
    )

    if raw:
        parsed = validate_and_sort_timeline(raw)
        if not parsed.get("_parse_error"):
            return {**parsed, "partial": False, "interview_transcript": transcript, "completeness": completeness}

    # Fallback: use cached intermediate data
    return {
        "timeline_entries": [],
        "chief_complaint_sentence": complaint,
        "modifying_factors": [],
        "associated_symptoms": [],
        "background": {"family_history": None, "medications": None, "travel": None, "weight_changes": None, "other": []},
        "patient_quote": complaint,
        "completeness": completeness,
        "partial": True,
        "interview_transcript": transcript,
        "message": "We couldn't process your additional answers fully. Here's what we have — you can still export this summary.",
    }


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
