// =============================================================================
// Symptom Timeline Builder — main.js
// =============================================================================

// ---------------------------------------------------------------------------
// A. Utility helpers
// ---------------------------------------------------------------------------

const STB_KEY = "stb_session";

function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(STB_KEY)) || null;
  } catch {
    return null;
  }
}

function setSession(data) {
  sessionStorage.setItem(STB_KEY, JSON.stringify(data));
}

function clearSession() {
  sessionStorage.removeItem(STB_KEY);
}

function demoInUrl() {
  return new URLSearchParams(window.location.search).get("demo") === "true";
}

function demoSuffix() {
  const demo = demoInUrl() || (getSession() || {}).demo === true;
  return demo ? "?demo=true" : "";
}

function showErrorBanner(msg, retryFn) {
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  const textEl = banner.querySelector("#error-text") || banner;
  if (textEl !== banner) textEl.textContent = msg;
  else banner.textContent = msg;
  banner.style.display = "block";

  const retryBtn = document.getElementById("retry-btn");
  if (retryBtn) {
    retryBtn.style.display = retryFn ? "inline-block" : "none";
    retryBtn.onclick = retryFn ? () => {
      hideErrorBanner();
      retryFn();
    } : null;
  }
}

function hideErrorBanner() {
  const banner = document.getElementById("error-banner");
  if (banner) banner.style.display = "none";
}

function showSpinner(text) {
  const spinner = document.getElementById("spinner");
  if (!spinner) return;
  const textEl = document.getElementById("spinner-text");
  if (textEl && text) textEl.textContent = text;
  spinner.style.display = "flex";
}

function hideSpinner() {
  const spinner = document.getElementById("spinner");
  if (spinner) spinner.style.display = "none";
}

function revealCrisisBanner() {
  const banner = document.getElementById("crisis-banner");
  if (banner) banner.style.display = "block";
  return banner;
}

function showCrisisBanner(resume, buttonLabel = "Continue anyway") {
  const banner = revealCrisisBanner();
  if (!banner) return;

  const container = document.querySelector("#intake-container, #interview-container, #results-container");
  if (container) container.style.display = "none";

  const button = document.getElementById("crisis-continue-btn");
  button.hidden = !resume;
  button.onclick = null;
  if (resume) {
    button.textContent = buttonLabel;
    button.onclick = () => {
      button.hidden = true;
      button.onclick = null;
      if (container) container.style.display = "";
      resume();
    };
  }

  banner.focus({ preventScroll: true });
  banner.scrollIntoView({ behavior: "smooth" });
}

function pauseForUrgentWarning(data, resume) {
  if (data.continuation_token) {
    showCrisisBanner(() => resume(data.continuation_token));
  } else if (data.retry_safety_check) {
    showCrisisBanner(() => resume(), "Retry safety check");
  } else {
    showCrisisBanner();
  }
}

// ---------------------------------------------------------------------------
// B. Speech recognition
// ---------------------------------------------------------------------------

function initSpeech(textareaId) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById("mic-btn");
  if (!SpeechRecognition || !micBtn) return;

  micBtn.style.display = "flex";
  let recognition = null;
  let isListening = false;

  micBtn.addEventListener("click", () => {
    if (isListening) {
      recognition && recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = "en-GB";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => {
      isListening = true;
      micBtn.classList.add("listening");
      micBtn.title = "Listening… click to stop";
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const ta = document.getElementById(textareaId);
      if (ta) {
        ta.value = (ta.value ? ta.value + " " : "") + transcript;
        ta.dispatchEvent(new Event("input"));
      }
    };

    recognition.onerror = () => {
      isListening = false;
      micBtn.classList.remove("listening");
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.classList.remove("listening");
      micBtn.title = "Speak your answer";
    };

    recognition.start();
  });
}

// ---------------------------------------------------------------------------
// C. Intake page
// ---------------------------------------------------------------------------

function initIntake() {
  if (!document.getElementById("complaint")) return;

  initSpeech("complaint");

  const startBtn = document.getElementById("start-btn");
  const complaintEl = document.getElementById("complaint");
  const demo = demoInUrl();
  const suffix = demo ? "?demo=true" : "";

  function doStart() {
    const complaint = complaintEl.value.trim();
    if (complaint.length < 3) {
      showErrorBanner("Please describe your symptoms before continuing.");
      return;
    }
    requestStart(complaint);
  }

  function requestStart(complaint, urgentToken) {
    if (startBtn.disabled) return;

    hideErrorBanner();
    startBtn.disabled = true;
    showSpinner("Getting your first questions ready…");

    const body = { chief_complaint: complaint, urgent_token: urgentToken };

    fetch("/start" + suffix, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data) => {
        hideSpinner();
        startBtn.disabled = false;

        if (data.acute) {
          pauseForUrgentWarning(data, (token) => requestStart(complaint, token));
          return;
        }

        if (data.error) {
          showErrorBanner("Something went wrong. Please refresh and try again.", doStart);
          return;
        }

        setSession({
          session_id: data.session_id,
          // First batch of questions
          currentBatchQuestions: data.questions,
          allQaPairs: [],
          batchNumber: 1,
          hpcDone: data.done || false,
          demo,
          urgentWarning: Boolean(urgentToken),
        });

        window.location.href = "/interview" + suffix;
      })
      .catch(() => {
        hideSpinner();
        startBtn.disabled = false;
        showErrorBanner("Something went wrong. Please refresh and try again.", doStart);
      });
  }

  startBtn.addEventListener("click", doStart);
  complaintEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (!e.repeat) doStart();
  });
}

// ---------------------------------------------------------------------------
// D. Interview page
// ---------------------------------------------------------------------------

function initInterview() {
  if (!document.getElementById("answer")) return;

  const session = getSession();
  if (!session || !session.session_id) {
    window.location.href = "/";
    return;
  }

  // Redirect if we somehow land here with no questions
  if (!session.currentBatchQuestions || session.currentBatchQuestions.length === 0) {
    window.location.href = "/";
    return;
  }

  initSpeech("answer");
  if (session.urgentWarning) revealCrisisBanner();

  // ---- State ----
  let currentBatchQuestions = session.currentBatchQuestions;  // questions in this batch
  let currentBatchAnswers = session.currentBatchAnswers || [];
  let allQaPairs = session.allQaPairs || [];                  // all completed Q&A across batches
  let batchNumber = session.batchNumber || 1;
  let hpcDone = session.hpcDone || false;

  let phase = session.phase || "hpc";
  let biasQuestions = session.biasQuestions || [];
  let biasAnswers = session.biasAnswers || [];
  let coverageQuestions = session.coverageQuestions || [];
  let coverageAnswers = [];
  let coveragePairs = session.coveragePairs || [];
  let coverageRound = session.coverageRound || 0;
  let currentIndex = 0;

  const TOTAL_BATCHES = 3;

  const questionEl = document.getElementById("question-text");
  const answerEl = document.getElementById("answer");
  const progressEl = document.getElementById("progress-indicator");
  const progressBar = document.getElementById("progress-bar");
  const phaseLabelEl = document.getElementById("phase-label");
  const prevQaEl = document.getElementById("previous-qa");
  const nextBtn = document.getElementById("next-btn");
  const backBtn = document.getElementById("back-btn");
  const restartBtn = document.getElementById("restart-btn");
  const answerErrorEl = document.getElementById("answer-error");
  const interviewRequests = new AbortController();

  function restartInterview() {
    interviewRequests.abort();
    clearSession();
    window.location.replace("/");
  }

  function currentQuestions() {
    if (phase === "coverage") return coverageQuestions;
    return phase === "hpc" ? currentBatchQuestions : biasQuestions;
  }

  function currentAnswers() {
    if (phase === "coverage") return coverageAnswers;
    return phase === "hpc" ? currentBatchAnswers : biasAnswers;
  }

  function renderQuestion(idx) {
    const qs = currentQuestions();
    questionEl.textContent = qs[idx];
    answerEl.value = currentAnswers()[idx] || "";
    answerEl.focus();

    if (phase === "hpc") {
      phaseLabelEl.textContent = "Your symptom history";
      // Show batch-aware progress: "Part 1 of 3 — Question 2 of 3"
      const batchTotal = qs.length;
      progressEl.textContent = `Part ${batchNumber} of ${TOTAL_BATCHES} — Question ${idx + 1} of ${batchTotal}`;

      // Overall progress across all batches
      const completedQs = allQaPairs.length + idx;
      const estimatedTotal = TOTAL_BATCHES * 3;
      const pct = Math.min(Math.round((completedQs / estimatedTotal) * 100), 95);
      progressBar.style.width = pct + "%";
    } else {
      const total = qs.length;
      const clarifying = phase === "coverage";
      phaseLabelEl.textContent = clarifying ? "A few details to clarify" : "A few more questions about your history";
      progressEl.textContent = `${clarifying ? "Clarifying" : "Additional"} question ${idx + 1} of ${total}`;
      const pct = Math.round(((idx + 1) / total) * 100);
      progressBar.style.width = pct + "%";
    }

    // Back button: only within current batch/phase
    backBtn.style.display = (idx > 0 || phase === "bias") ? "inline-block" : "none";

    // Next button label
    const isLastInPhase = idx === currentQuestions().length - 1;
    nextBtn.textContent = isLastInPhase ? "Submit answers →" : "Next →";
    answerErrorEl.style.display = "none";

    // Render previous Q&A accordion — all completed pairs + current batch prior answers
    prevQaEl.innerHTML = "";

    const previousPairs = [...allQaPairs];
    if (phase !== "hpc") {
      previousPairs.push(...currentBatchQuestions.map((q, i) => [q, currentBatchAnswers[i]]));
    }
    if (phase === "coverage") {
      previousPairs.push(...biasQuestions.map((q, i) => [q, biasAnswers[i]]), ...coveragePairs);
    }
    const answers = currentAnswers();
    previousPairs.push(...qs.slice(0, idx).map((question, i) => [question, answers[i]]));
    previousPairs.forEach(([q, a]) => {
      if (!a) return;
      const item = document.createElement("details");
      item.className = "prev-qa-item";
      const question = document.createElement("summary");
      const answer = document.createElement("p");
      question.textContent = q;
      answer.textContent = a;
      item.append(question, answer);
      prevQaEl.appendChild(item);
    });
  }

  function saveSessionState() {
    setSession({
      session_id: session.session_id,
      currentBatchQuestions,
      currentBatchAnswers,
      allQaPairs,
      batchNumber,
      hpcDone,
      phase,
      biasQuestions,
      biasAnswers,
      coverageQuestions,
      coveragePairs,
      coverageRound,
      demo: session.demo,
      urgentWarning: session.urgentWarning,
    });
  }

  function pauseInterview(data, resume) {
    pauseForUrgentWarning(data, (token) => {
      if (token) {
        session.urgentWarning = true;
        setSession({ ...getSession(), urgentWarning: true });
      }
      resume(token);
    });
  }

  function showSubmissionError(error, message, retry) {
    if (error === "session_expired") {
      nextBtn.disabled = true;
      showErrorBanner("This interview session has ended. Use Restart interview to begin again.");
    } else if (error === "batch_changed") {
      nextBtn.disabled = true;
      showErrorBanner("This page is out of sync with your interview. Use Restart interview to start over.");
    } else {
      showErrorBanner(message, retry);
    }
  }

  function fetchNextBatch(answers = [...currentBatchAnswers], urgentToken) {
    hideErrorBanner();
    showSpinner("Thinking about what to ask next…");
    nextBtn.disabled = true;

    const payload = {
      session_id: session.session_id,
      batch_number: batchNumber,
      answers,
      urgent_token: urgentToken,
    };
    const retry = () => fetchNextBatch(answers, urgentToken);

    fetch("/next-batch" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: interviewRequests.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;

        if (data.acute) {
          pauseInterview(data, (token) => fetchNextBatch(answers, token));
          return;
        }

        if (data.error) {
          showSubmissionError(data.error, "The next questions couldn’t be loaded. Your answers are still here. Try again.", retry);
          return;
        }

        if (data.done) {
          // HPC complete — move to submit-hpc
          hpcDone = true;
          saveSessionState();
          submitHpc(answers);
        } else {
          // Load next batch
          allQaPairs = allQaPairs.concat(
            currentBatchQuestions.map((q, i) => [q, answers[i] || ""])
          );
          batchNumber++;
          hpcDone = data.final_batch === true;
          currentBatchQuestions = data.questions;
          currentBatchAnswers = [];
          currentIndex = 0;
          saveSessionState();
          renderQuestion(0);
        }
      })
      .catch(() => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Couldn’t reach the server. Your answers are still here. Try again.", retry);
      });
  }

  function submitHpc(answers, urgentToken) {
    hideErrorBanner();
    showSpinner("Analysing your responses…");
    nextBtn.disabled = true;
    const retry = () => submitHpc(answers, urgentToken);

    fetch("/submit-hpc" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: session.session_id, answers, urgent_token: urgentToken }),
      signal: interviewRequests.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;

        if (data.acute) {
          pauseInterview(data, (token) => submitHpc(answers, token || urgentToken));
          return;
        }

        if (data.error) {
          showSubmissionError(data.error, "The follow-up questions couldn’t be loaded. Your answers are still here. Try again.", retry);
          return;
        }

        // Transition to bias phase
        biasQuestions = data.bias_questions || [];
        phase = "bias";
        currentIndex = 0;
        biasAnswers.length = 0;
        saveSessionState();
        progressBar.style.width = "100%";
        renderQuestion(0);
      })
      .catch(() => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Couldn’t reach the server. Your answers are still here. Try again.", retry);
      });
  }

  function submitBias(answers = [...currentAnswers()], urgentToken) {
    hideErrorBanner();
    showSpinner("Checking for any missing details…");
    nextBtn.disabled = true;

    const clarifying = phase === "coverage";
    const payload = { session_id: session.session_id, urgent_token: urgentToken };
    if (clarifying) {
      payload.coverage_round = coverageRound;
      payload.coverage_answers = answers;
    } else {
      payload.bias_answers = answers;
    }

    fetch("/submit-bias" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: interviewRequests.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;

        if (data.acute && data.continuation_token) {
          pauseInterview(data, (token) => submitBias(answers, token));
          return;
        }

        if (data.error) {
          showSubmissionError(data.error, "Couldn’t finish reviewing your answers. Your answers are still here. Try again.", () => submitBias(answers, urgentToken));
          return;
        }

        if (Array.isArray(data.coverage_questions) && data.coverage_questions.length && Number.isInteger(data.coverage_round)) {
          if (clarifying) coveragePairs.push(...coverageQuestions.map((question, i) => [question, answers[i]]));
          coverageRound = data.coverage_round;
          coverageQuestions = data.coverage_questions;
          coverageAnswers = [];
          phase = "coverage";
          currentIndex = 0;
          saveSessionState();
          renderQuestion(0);
          return;
        }

        // Store results and redirect
        const updated = { ...getSession(), results: data };
        setSession(updated);
        window.location.href = "/results" + demoSuffix();
      })
      .catch(() => {
        if (interviewRequests.signal.aborted) return;
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", () => submitBias(answers, urgentToken));
      });
  }

  function handleNext() {
    if (nextBtn.disabled) return;

    const answer = answerEl.value.trim();
    if (!answer) {
      answerErrorEl.style.display = "block";
      return;
    }
    answerErrorEl.style.display = "none";
    checkAnswer(answer);
  }

  async function checkAnswer(answer, urgentToken) {
    hideErrorBanner();
    nextBtn.disabled = true;
    answerEl.readOnly = true;

    let data;
    try {
      const response = await fetch("/check-answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: session.session_id,
          phase,
          batch_number: phase === "coverage" ? coverageRound : batchNumber,
          index: currentIndex,
          answer,
          urgent_token: urgentToken,
        }),
        signal: interviewRequests.signal,
      });
      data = await response.json();
    } catch {
      if (!interviewRequests.signal.aborted) {
        showErrorBanner("Couldn’t check this answer. Your answer is still here. Try again.", handleNext);
      }
      return;
    } finally {
      nextBtn.disabled = false;
      answerEl.readOnly = false;
    }

    if (interviewRequests.signal.aborted) return;
    if (typeof data?.acute !== "boolean") {
      showSubmissionError(data?.error, "Couldn’t check this answer. Your answer is still here. Try again.", handleNext);
      return;
    }
    if (data.acute) {
      pauseInterview(data, (token) => checkAnswer(answer, token));
      return;
    }
    advanceWithAnswer(answer);
  }

  function advanceWithAnswer(answer) {
    const ans = currentAnswers();
    ans[currentIndex] = answer;

    const total = currentQuestions().length;

    if (currentIndex < total - 1) {
      currentIndex++;
      renderQuestion(currentIndex);
    } else {
      // Last question in current batch/phase
      if (phase === "hpc") {
        if (hpcDone || batchNumber >= TOTAL_BATCHES) {
          submitHpc([...currentBatchAnswers]);
        } else {
          fetchNextBatch();
        }
      } else {
        submitBias();
      }
    }
  }

  function handleBack() {
    if (nextBtn.disabled) return;

    if (currentIndex > 0) {
      currentIndex--;
      renderQuestion(currentIndex);
    } else if (phase === "bias" && currentIndex === 0) {
      // Go back to last HPC question in the last batch
      phase = "hpc";
      currentIndex = currentBatchQuestions.length - 1;
      renderQuestion(currentIndex);
    }
    // At the start of a non-first HPC batch, back is disabled — we don't re-fetch previous batches
  }

  nextBtn.addEventListener("click", handleNext);
  backBtn.addEventListener("click", handleBack);
  restartBtn.addEventListener("click", restartInterview);
  answerEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) handleNext();
  });

  renderQuestion(0);
}

// ---------------------------------------------------------------------------
// E. Results page
// ---------------------------------------------------------------------------

const CONFIDENCE_LABELS = {
  exact: { label: "Exact timing", cls: "confidence-exact" },
  approximate: { label: "Approximate timing", cls: "confidence-approximate" },
  inferred: { label: "Estimated timing", cls: "confidence-inferred" },
};

function initResults() {
  if (!document.getElementById("timeline-container")) return;

  const session = getSession();
  if (!session || !session.results) {
    window.location.href = "/";
    return;
  }

  const results = session.results;

  // Show crisis banner if acute
  if (results.acute) {
    showCrisisBanner();
    return;
  }
  if (session.urgentWarning) revealCrisisBanner();

  // Partial notice
  if (results.partial) {
    const partialBanner = document.getElementById("partial-banner");
    if (partialBanner) partialBanner.style.display = "block";
  }

  // In-memory timeline (mutable for edits)
  let timeline = [...(results.timeline_entries || [])];

  // Export link
  const exportLink = document.getElementById("export-link");
  if (exportLink && session.session_id) {
    exportLink.href = `/export?session_id=${session.session_id}`;
  }

  // Chief complaint
  const ccEl = document.getElementById("chief-complaint-text");
  if (ccEl) ccEl.textContent = results.chief_complaint_sentence || "";

  const quoteEl = document.getElementById("patient-quote");
  if (quoteEl && results.patient_quote) quoteEl.textContent = `"${results.patient_quote}"`;

  // Modifying factors
  const modList = document.getElementById("modifying-list");
  const modSection = document.getElementById("modifying-section");
  if (modList && results.modifying_factors && results.modifying_factors.length > 0) {
    modSection.style.display = "block";
    results.modifying_factors.forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      modList.appendChild(li);
    });
  }

  // Associated symptoms
  const assocList = document.getElementById("associated-list");
  const assocSection = document.getElementById("associated-section");
  if (assocList && results.associated_symptoms && results.associated_symptoms.length > 0) {
    assocSection.style.display = "block";
    results.associated_symptoms.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = s;
      assocList.appendChild(li);
    });
  }

  // Background
  const bgList = document.getElementById("background-list");
  const bgSection = document.getElementById("background-section");
  const bg = results.background || {};
  const bgFields = [
    ["Family history", bg.family_history],
    ["Medications / supplements", bg.medications],
    ["Recent travel", bg.travel],
    ["Weight changes", bg.weight_changes],
  ];
  const bgOther = bg.other || [];

  let hasBg = false;
  if (bgList) {
    bgFields.forEach(([label, value]) => {
      if (!value) return;
      hasBg = true;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      bgList.appendChild(dt);
      bgList.appendChild(dd);
    });
    bgOther.forEach((item) => {
      hasBg = true;
      const li = document.createElement("li");
      li.textContent = item;
      bgList.appendChild(li);
    });
    if (hasBg) bgSection.style.display = "block";
  }

  // Timeline render
  function renderTimeline() {
    const container = document.getElementById("timeline-container");
    container.innerHTML = "";

    if (timeline.length === 0) {
      container.innerHTML = "<p class='no-entries'>No timeline entries available.</p>";
      return;
    }

    timeline.forEach((entry, idx) => {
      const div = document.createElement("div");
      const typeClass = "type-" + (entry.event_type || "symptom_onset").replace(/_/g, "-");
      div.className = `timeline-entry ${typeClass}`;
      div.dataset.idx = idx;

      const weeksLabel = entry.weeks_ago === 0 ? "Today" : `${entry.weeks_ago} week${entry.weeks_ago !== 1 ? "s" : ""} ago`;
      const severityText = entry.severity != null ? ` (Severity: ${entry.severity}/10)` : "";

      const conf = entry.confidence || "approximate";
      const confInfo = CONFIDENCE_LABELS[conf] || CONFIDENCE_LABELS.approximate;
      const confidenceBadge = `<span class="confidence-badge ${confInfo.cls}" title="${confInfo.label}">${confInfo.label}</span>`;

      div.innerHTML = `
        <div class="entry-badge">${weeksLabel}</div>
        <div class="entry-body">
          <span class="entry-desc">${entry.description}${severityText}</span>
          ${confidenceBadge}
          <button class="btn-edit no-print" data-idx="${idx}">Edit</button>
        </div>
        <div class="entry-edit-form" style="display:none">
          <input type="text" class="edit-desc" value="${entry.description.replace(/"/g, '&quot;')}" placeholder="Description">
          <input type="number" class="edit-weeks" value="${entry.weeks_ago}" min="0" max="520" placeholder="Weeks ago">
          <button class="btn-save-edit">Save</button>
          <button class="btn-cancel-edit">Cancel</button>
        </div>
      `;

      container.appendChild(div);
    });

    // Edit handlers
    container.querySelectorAll(".btn-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx);
        const entryDiv = container.querySelector(`[data-idx="${idx}"]`);
        entryDiv.querySelector(".entry-body").style.display = "none";
        entryDiv.querySelector(".entry-edit-form").style.display = "flex";
      });
    });

    container.querySelectorAll(".btn-cancel-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entryDiv = btn.closest(".timeline-entry");
        entryDiv.querySelector(".entry-body").style.display = "flex";
        entryDiv.querySelector(".entry-edit-form").style.display = "none";
      });
    });

    container.querySelectorAll(".btn-save-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entryDiv = btn.closest(".timeline-entry");
        const idx = parseInt(entryDiv.dataset.idx);
        const descInput = entryDiv.querySelector(".edit-desc");
        const weeksInput = entryDiv.querySelector(".edit-weeks");

        const newDesc = descInput.value.trim();
        const newWeeks = parseInt(weeksInput.value);

        if (!newDesc || isNaN(newWeeks) || newWeeks < 0) return;

        timeline[idx].description = newDesc;
        timeline[idx].weeks_ago = newWeeks;

        // Re-sort descending by weeks_ago
        timeline.sort((a, b) => b.weeks_ago - a.weeks_ago);
        renderTimeline();
      });
    });
  }

  renderTimeline();

  const transcript = results.interview_transcript || [];
  if (transcript.length) {
    const transcriptList = document.getElementById("transcript-list");
    for (const [question, answer] of transcript) {
      const item = document.createElement("li");
      const questionEl = document.createElement("p");
      questionEl.className = "transcript-question";
      questionEl.dir = "auto";
      questionEl.textContent = question;
      const answerEl = document.createElement("p");
      answerEl.className = "transcript-answer";
      answerEl.dir = "auto";
      answerEl.textContent = answer;
      item.append(questionEl, answerEl);
      transcriptList.appendChild(item);
    }
    document.getElementById("transcript-section").hidden = false;
  }

  // Copy to clipboard
  const copyBtn = document.getElementById("copy-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      const lines = [];
      lines.push("SYMPTOM SUMMARY");
      lines.push("===============");
      lines.push("");
      if (results.chief_complaint_sentence) {
        lines.push("Chief Complaint: " + results.chief_complaint_sentence);
        lines.push("");
      }
      lines.push("Timeline:");
      timeline.forEach((e) => {
        const weeksLabel = e.weeks_ago === 0 ? "Today" : `${e.weeks_ago} weeks ago`;
        const sev = e.severity != null ? ` (Severity: ${e.severity}/10)` : "";
        lines.push(`  [${weeksLabel}] ${e.description}${sev}`);
      });

      navigator.clipboard.writeText(lines.join("\n")).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 2000);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// F. Initialise correct page on DOMContentLoaded
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initIntake();
  initInterview();
  initResults();
});
