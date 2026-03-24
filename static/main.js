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
    showSpinner();

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
          questions: data.questions,
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
  if (!session || !session.questions || !session.session_id) {
    window.location.href = "/";
    return;
  }

  initSpeech("answer");

  const questions = session.questions;
  const answers = [];
  let currentIndex = 0;
  let phase = "hpc"; // "hpc" or "bias"
  let biasQuestions = [];
  let biasAnswers = [];
  let lastHpcPayload = null;

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
    return phase === "hpc" ? questions : biasQuestions;
  }

  function currentAnswers() {
    return phase === "hpc" ? answers : biasAnswers;
  }

  function totalQuestions() {
    return currentQuestions().length;
  }

  function renderQuestion(idx) {
    const qs = currentQuestions();
    questionEl.textContent = qs[idx];
    answerEl.value = currentAnswers()[idx] || "";
    answerEl.focus();

    const total = totalQuestions();
    progressEl.textContent = `Question ${idx + 1} of ${total}`;
    const pct = Math.round(((idx + 1) / total) * 100);
    progressBar.style.width = pct + "%";

    backBtn.style.display = idx > 0 || phase === "bias" ? "inline-block" : "none";
    nextBtn.textContent = idx === total - 1 ? (phase === "hpc" ? "Submit answers →" : "Build my timeline →") : "Next →";
    answerErrorEl.style.display = "none";

    // Render previous Q&A
    prevQaEl.innerHTML = "";
    const prevAnswers = currentAnswers().slice(0, idx);
    if (prevAnswers.length > 0) {
      prevAnswers.forEach((ans, i) => {
        if (!ans) return;
        const item = document.createElement("details");
        item.className = "prev-qa-item";
        item.innerHTML = `<summary>${qs[i]}</summary><p>${ans}</p>`;
        prevQaEl.appendChild(item);
      });
    }
  }

  function submitHpc() {
    hideErrorBanner();
    showSpinner("Analysing your responses…");
    nextBtn.disabled = true;

    lastHpcPayload = { session_id: session.session_id, answers: [...answers] };

    fetch("/submit-hpc" + demoSuffix(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastHpcPayload),
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
          showErrorBanner("Something went wrong processing your answers. Please try again.", () => submitHpc());
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

        renderQuestion(0);
      })
      .catch(() => {
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", () => submitHpc());
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
        const updated = { ...session, results: data };
        setSession(updated);
        window.location.href = "/results" + demoSuffix();
      })
      .catch(() => {
        hideSpinner();
        nextBtn.disabled = false;
        showErrorBanner("Something went wrong. Please try again.", () => submitBias());
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

    const total = totalQuestions();

    if (currentIndex < total - 1) {
      currentIndex++;
      renderQuestion(currentIndex);
    } else {
      // Last question in phase
      if (phase === "hpc") {
        submitHpc();
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
      // Go back to last HPC question
      phase = "hpc";
      currentIndex = questions.length - 1;
      if (phaseLabelEl) phaseLabelEl.textContent = "Your symptom history";
      renderQuestion(currentIndex);
    }
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

      div.innerHTML = `
        <div class="entry-badge">${weeksLabel}</div>
        <div class="entry-body">
          <span class="entry-desc">${entry.description}${severityText}</span>
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
