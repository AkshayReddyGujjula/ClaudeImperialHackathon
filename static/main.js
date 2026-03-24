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

function isDemo() {
  return new URLSearchParams(window.location.search).get("demo") === "true"
    || (getSession() || {}).demo === true;
}

function demoSuffix() {
  return isDemo() ? "?demo=true" : "";
}

function showErrorBanner(msg, retryFn) {
  const banner = document.getElementById("error-banner");
  if (!banner) return;
  const textEl = banner.querySelector("#error-text") || banner;
  if (textEl !== banner) textEl.textContent = msg;
  else banner.textContent = msg;
  banner.style.display = "block";

  const retryBtn = document.getElementById("retry-btn");
  if (retryBtn && retryFn) {
    retryBtn.style.display = "inline-block";
    retryBtn.onclick = () => {
      banner.style.display = "none";
      retryFn();
    };
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

function showCrisisBanner() {
  const container = document.getElementById("interview-container") || document.getElementById("results-container");
  if (container) container.style.display = "none";
  const banner = document.getElementById("crisis-banner");
  if (banner) {
    banner.style.display = "block";
    banner.scrollIntoView({ behavior: "smooth" });
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

  function doStart() {
    const complaint = complaintEl.value.trim();
    if (complaint.length < 3) {
      showErrorBanner("Please describe your symptoms before continuing.");
      return;
    }

    hideErrorBanner();
    startBtn.disabled = true;
    showSpinner("Getting your first questions ready…");

    const body = { chief_complaint: complaint };

    fetch("/start" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((data) => {
        hideSpinner();
        startBtn.disabled = false;

        if (data.acute) {
          showCrisisBanner();
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
          demo: isDemo(),
        });

        window.location.href = "/interview" + demoSuffix();
      })
      .catch(() => {
        hideSpinner();
        startBtn.disabled = false;
        showErrorBanner("Something went wrong. Please refresh and try again.", doStart);
      });
  }

  startBtn.addEventListener("click", doStart);
  complaintEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.ctrlKey) doStart();
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

  // ---- State ----
  let currentBatchQuestions = session.currentBatchQuestions;  // questions in this batch
  let currentBatchAnswers = [];                               // answers for this batch
  let allQaPairs = session.allQaPairs || [];                  // all completed Q&A across batches
  let batchNumber = session.batchNumber || 1;
  let hpcDone = session.hpcDone || false;

  let phase = "hpc"; // "hpc" or "bias"
  let biasQuestions = [];
  let biasAnswers = [];
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
  const answerErrorEl = document.getElementById("answer-error");

  function currentQuestions() {
    return phase === "hpc" ? currentBatchQuestions : biasQuestions;
  }

  function currentAnswers() {
    return phase === "hpc" ? currentBatchAnswers : biasAnswers;
  }

  function renderQuestion(idx) {
    const qs = currentQuestions();
    questionEl.textContent = qs[idx];
    answerEl.value = currentAnswers()[idx] || "";
    answerEl.focus();

    if (phase === "hpc") {
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
      progressEl.textContent = `Additional question ${idx + 1} of ${total}`;
      const pct = Math.round(((idx + 1) / total) * 100);
      progressBar.style.width = pct + "%";
    }

    // Back button: only within current batch/phase
    backBtn.style.display = (idx > 0 || phase === "bias") ? "inline-block" : "none";

    // Next button label
    const isLastInPhase = idx === currentQuestions().length - 1;
    if (phase === "hpc") {
      nextBtn.textContent = isLastInPhase ? "Submit answers →" : "Next →";
    } else {
      nextBtn.textContent = isLastInPhase ? "Build my timeline →" : "Next →";
    }
    answerErrorEl.style.display = "none";

    // Render previous Q&A accordion — all completed pairs + current batch prior answers
    prevQaEl.innerHTML = "";

    // All completed batches
    if (allQaPairs.length > 0) {
      allQaPairs.forEach(([q, a]) => {
        if (!a) return;
        const item = document.createElement("details");
        item.className = "prev-qa-item";
        item.innerHTML = `<summary>${q}</summary><p>${a}</p>`;
        prevQaEl.appendChild(item);
      });
    }

    // Current batch answers so far
    if (phase === "hpc") {
      currentBatchAnswers.slice(0, idx).forEach((ans, i) => {
        if (!ans) return;
        const item = document.createElement("details");
        item.className = "prev-qa-item";
        item.innerHTML = `<summary>${currentBatchQuestions[i]}</summary><p>${ans}</p>`;
        prevQaEl.appendChild(item);
      });
    } else {
      biasAnswers.slice(0, idx).forEach((ans, i) => {
        if (!ans) return;
        const item = document.createElement("details");
        item.className = "prev-qa-item";
        item.innerHTML = `<summary>${biasQuestions[i]}</summary><p>${ans}</p>`;
        prevQaEl.appendChild(item);
      });
    }
  }

  function saveSessionState() {
    setSession({
      session_id: session.session_id,
      currentBatchQuestions,
      allQaPairs,
      batchNumber,
      hpcDone,
      demo: session.demo,
    });
  }

  function fetchNextBatch() {
    hideErrorBanner();
    showSpinner("Thinking about what to ask next…");
    nextBtn.disabled = true;

    const payload = {
      session_id: session.session_id,
      answers: [...currentBatchAnswers],
    };

    fetch("/next-batch" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((data) => {
        hideSpinner();
        nextBtn.disabled = false;

        if (data.acute) {
          showCrisisBanner();
          return;
        }

        if (data.error) {
          showErrorBanner("Something went wrong. Please try again.", fetchNextBatch);
          return;
        }

        if (data.done) {
          // HPC complete — move to submit-hpc
          hpcDone = true;
          saveSessionState();
          submitHpc();
        } else {
          // Load next batch
          allQaPairs = allQaPairs.concat(
            currentBatchQuestions.map((q, i) => [q, currentBatchAnswers[i] || ""])
          );
          batchNumber++;
          currentBatchQuestions = data.questions;
          currentBatchAnswers = [];
          currentIndex = 0;
          saveSessionState();
          renderQuestion(0);
        }
      })
      .catch(() => {
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", fetchNextBatch);
      });
  }

  function submitHpc() {
    hideErrorBanner();
    showSpinner("Analysing your responses…");
    nextBtn.disabled = true;

    fetch("/submit-hpc" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: session.session_id }),
    })
      .then((r) => r.json())
      .then((data) => {
        hideSpinner();
        nextBtn.disabled = false;

        if (data.acute) {
          showCrisisBanner();
          return;
        }

        if (data.error) {
          showErrorBanner("Something went wrong processing your answers. Please try again.", submitHpc);
          return;
        }

        // Transition to bias phase
        biasQuestions = data.bias_questions || [];
        phase = "bias";
        currentIndex = 0;
        biasAnswers.length = 0;

        if (phaseLabelEl) {
          phaseLabelEl.textContent = "A few more questions to make sure we haven't missed anything:";
        }

        progressBar.style.width = "100%";
        renderQuestion(0);
      })
      .catch(() => {
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", submitHpc);
      });
  }

  function submitBias() {
    hideErrorBanner();
    showSpinner("Building your timeline…");
    nextBtn.disabled = true;

    const payload = { session_id: session.session_id, bias_answers: [...biasAnswers] };

    fetch("/submit-bias" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((data) => {
        hideSpinner();
        nextBtn.disabled = false;

        if (data.error && data.error === "session_expired") {
          showErrorBanner("Your session has expired. " + (data.message || "Please start again."));
          return;
        }

        // Store results and redirect
        const updated = { ...getSession(), results: data };
        setSession(updated);
        window.location.href = "/results" + demoSuffix();
      })
      .catch(() => {
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", submitBias);
      });
  }

  function handleNext() {
    const answer = answerEl.value.trim();
    if (answer.length < 3) {
      answerErrorEl.style.display = "block";
      return;
    }
    answerErrorEl.style.display = "none";

    const ans = currentAnswers();
    ans[currentIndex] = answer;

    const total = currentQuestions().length;

    if (currentIndex < total - 1) {
      currentIndex++;
      renderQuestion(currentIndex);
    } else {
      // Last question in current batch/phase
      if (phase === "hpc") {
        // Save this batch's answers into allQaPairs temporarily for display,
        // then decide: fetch next batch or go straight to submit-hpc
        if (hpcDone || batchNumber >= TOTAL_BATCHES) {
          // Final batch complete — flush to server
          allQaPairs = allQaPairs.concat(
            currentBatchQuestions.map((q, i) => [q, currentBatchAnswers[i] || ""])
          );
          saveSessionState();
          submitHpc();
        } else {
          fetchNextBatch();
        }
      } else {
        submitBias();
      }
    }
  }

  function handleBack() {
    if (currentIndex > 0) {
      currentIndex--;
      renderQuestion(currentIndex);
    } else if (phase === "bias" && currentIndex === 0) {
      // Go back to last HPC question in the last batch
      phase = "hpc";
      currentIndex = currentBatchQuestions.length - 1;
      if (phaseLabelEl) phaseLabelEl.textContent = "Your symptom history";
      renderQuestion(currentIndex);
    }
    // At the start of a non-first HPC batch, back is disabled — we don't re-fetch previous batches
  }

  nextBtn.addEventListener("click", handleNext);
  backBtn.addEventListener("click", handleBack);
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

  // Completeness score
  const completeness = results.completeness;
  const completenessSection = document.getElementById("completeness-section");
  if (completeness && completenessSection) {
    completenessSection.style.display = "block";
    const scoreEl = document.getElementById("completeness-score-fill");
    const scoreText = document.getElementById("completeness-score-text");
    const missingList = document.getElementById("completeness-missing-list");

    if (scoreEl) scoreEl.style.width = (completeness.score * 10) + "%";
    if (scoreText) scoreText.textContent = `${completeness.score}/10`;

    if (missingList && completeness.missing_dimensions && completeness.missing_dimensions.length > 0) {
      completeness.missing_dimensions.forEach((dim) => {
        const li = document.createElement("li");
        li.textContent = dim;
        missingList.appendChild(li);
      });
    } else if (missingList) {
      const li = document.createElement("li");
      li.textContent = "All key areas appear well-covered.";
      missingList.appendChild(li);
    }
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
