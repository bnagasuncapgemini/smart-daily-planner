/**
 * App Controller — UI rendering, modal workflows, chat interaction, and shortcuts
 */
(function () {
  "use strict";

  const {
    getTodayISO,
    addDaysISO,
    formatDateHeading,
    formatDateFull,
    timeToMinutes,
    minutesToTime,
    formatTimeRange,
    formatDuration
  } = window.PlannerUtils;

  const store = new window.PlannerStore();
  const agent = new window.DailyPlannerAgent(store);

  let selectedDate = getTodayISO();
  let currentFilter = "all"; // all | pending | high | done
  let currentView = "list"; // list | timeline
  let isAgentThinking = false;
  let toastTimer = null;

  // DOM References
  const el = {
    datePicker: document.getElementById("datePicker"),
    prevDayBtn: document.getElementById("prevDayBtn"),
    nextDayBtn: document.getElementById("nextDayBtn"),
    todayBtn: document.getElementById("todayBtn"),
    selectedDateHeading: document.getElementById("selectedDateHeading"),
    selectedDateSub: document.getElementById("selectedDateSub"),
    viewListBtn: document.getElementById("viewListBtn"),
    viewTimelineBtn: document.getElementById("viewTimelineBtn"),
    autoScheduleBtn: document.getElementById("autoScheduleBtn"),
    statCompleted: document.getElementById("statCompleted"),
    statProgressBar: document.getElementById("statProgressBar"),
    statHours: document.getElementById("statHours"),
    statRemaining: document.getElementById("statRemaining"),
    statHighPriority: document.getElementById("statHighPriority"),
    statConflicts: document.getElementById("statConflicts"),
    quickAddForm: document.getElementById("quickAddForm"),
    quickAddInput: document.getElementById("quickAddInput"),
    openNewTaskModalBtn: document.getElementById("openNewTaskModalBtn"),
    filterPills: document.querySelectorAll(".filter-pill"),
    syncIndicator: document.getElementById("syncIndicator"),
    taskListContainer: document.getElementById("taskListContainer"),
    timelineContainer: document.getElementById("timelineContainer"),

    // Agent pane
    agentModePill: document.getElementById("agentModePill"),
    agentModeLabel: document.getElementById("agentModeLabel"),
    agentStatusSub: document.getElementById("agentStatusSub"),
    undoAgentBtn: document.getElementById("undoAgentBtn"),
    clearChatBtn: document.getElementById("clearChatBtn"),
    promptChips: document.querySelectorAll(".chip"),
    chatMessages: document.getElementById("chatMessages"),
    chatForm: document.getElementById("chatForm"),
    chatInput: document.getElementById("chatInput"),
    chatSendBtn: document.getElementById("chatSendBtn"),

    // Theme & topbar
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    themeIconSun: document.getElementById("themeIconSun"),
    themeIconMoon: document.getElementById("themeIconMoon"),
    settingsBtn: document.getElementById("settingsBtn"),
    exportBtn: document.getElementById("exportBtn"),

    // Mobile tabs
    mobileTabPlan: document.getElementById("mobileTabPlan"),
    mobileTabAgent: document.getElementById("mobileTabAgent"),
    planPane: document.getElementById("planPane"),
    agentPane: document.getElementById("agentPane"),

    // Task dialog
    taskDialog: document.getElementById("taskDialog"),
    taskDialogTitle: document.getElementById("taskDialogTitle"),
    taskForm: document.getElementById("taskForm"),
    taskIdInput: document.getElementById("taskIdInput"),
    taskTitleInput: document.getElementById("taskTitleInput"),
    taskDateInput: document.getElementById("taskDateInput"),
    taskTimeInput: document.getElementById("taskTimeInput"),
    taskDurationInput: document.getElementById("taskDurationInput"),
    taskPriorityInput: document.getElementById("taskPriorityInput"),
    taskCategoryInput: document.getElementById("taskCategoryInput"),
    taskStatusInput: document.getElementById("taskStatusInput"),
    taskNotesInput: document.getElementById("taskNotesInput"),
    deleteTaskModalBtn: document.getElementById("deleteTaskModalBtn"),

    // Settings dialog
    settingsDialog: document.getElementById("settingsDialog"),
    settingsForm: document.getElementById("settingsForm"),
    providerSelect: document.getElementById("providerSelect"),
    byokFields: document.getElementById("byokFields"),
    baseUrlField: document.getElementById("baseUrlField"),
    baseUrlInput: document.getElementById("baseUrlInput"),
    modelInput: document.getElementById("modelInput"),
    apiKeyInput: document.getElementById("apiKeyInput"),
    workStartInput: document.getElementById("workStartInput"),
    workEndInput: document.getElementById("workEndInput"),
    breakBufferInput: document.getElementById("breakBufferInput"),
    peakEnergySelect: document.getElementById("peakEnergySelect"),
    customInstructionsInput: document.getElementById("customInstructionsInput"),
    resetDemoBtn: document.getElementById("resetDemoBtn"),

    // Export dialog
    exportDialog: document.getElementById("exportDialog"),
    downloadIcsBtn: document.getElementById("downloadIcsBtn"),
    downloadJsonBtn: document.getElementById("downloadJsonBtn"),
    importJsonInput: document.getElementById("importJsonInput"),

    toast: document.getElementById("toast")
  };

  // ---------- Helpers ----------

  function showToast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function applyTheme(themePref) {
    let resolved = themePref;
    if (resolved === "auto" || !resolved) {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
    el.themeIconSun.hidden = resolved !== "dark";
    el.themeIconMoon.hidden = resolved === "dark";
  }

  function formatShortTime(isoStr) {
    try {
      return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- Rendering ----------

  function renderAgentHeader() {
    const prefs = store.getPreferences();
    if (prefs.provider === "gemini") {
      el.agentModeLabel.textContent = `Gemini (${prefs.model || "gemini-2.5-flash"})`;
      el.agentModePill.classList.add("is-byok");
      el.agentStatusSub.textContent = `Live BYOK • Google Gemini API`;
    } else if (prefs.provider === "openai") {
      el.agentModeLabel.textContent = `BYOK (${prefs.model || "gpt-4o-mini"})`;
      el.agentModePill.classList.add("is-byok");
      el.agentStatusSub.textContent = `Live BYOK • OpenAI-Compatible`;
    } else {
      el.agentModeLabel.textContent = "Offline Agent";
      el.agentModePill.classList.remove("is-byok");
      el.agentStatusSub.textContent = "Ready • Built-in Offline Intelligence";
    }
    el.undoAgentBtn.disabled = !store.canUndo();
  }

  function renderStats(dayTasks, conflicts) {
    const total = dayTasks.length;
    const done = dayTasks.filter((t) => t.status === "done").length;
    const pending = dayTasks.filter((t) => t.status !== "done");
    const totalMinutes = dayTasks.reduce((sum, t) => sum + (t.duration || 30), 0);
    const remainingMinutes = pending.reduce((sum, t) => sum + (t.duration || 30), 0);
    const highPending = pending.filter((t) => t.priority === "high").length;

    el.statCompleted.textContent = `${done} / ${total}`;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    el.statProgressBar.style.width = `${pct}%`;

    el.statHours.textContent = formatDuration(totalMinutes);
    el.statRemaining.textContent = `${formatDuration(remainingMinutes)} remaining`;
    el.statHighPriority.textContent = String(highPending);

    if (conflicts.pairs.length > 0) {
      el.statConflicts.textContent = `${conflicts.pairs.length} time conflict${conflicts.pairs.length > 1 ? "s" : ""}`;
      el.statConflicts.classList.add("has-warning");
    } else {
      el.statConflicts.textContent = "No conflicts";
      el.statConflicts.classList.remove("has-warning");
    }
  }

  function buildTaskCard(task, conflictIds) {
    const card = document.createElement("article");
    card.className = "task-card";
    if (task.status === "done") card.classList.add("is-done");
    if (conflictIds.has(task.id)) card.classList.add("has-conflict");

    // Checkbox button
    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "task-check";
    checkBtn.setAttribute("aria-label", task.status === "done" ? `Mark "${task.title}" pending` : `Complete "${task.title}"`);
    checkBtn.textContent = task.status === "done" ? "✓" : "";
    checkBtn.addEventListener("click", () => {
      store.toggleTaskDone(task.id);
    });

    // Main content
    const main = document.createElement("div");
    main.className = "task-main";

    const titleRow = document.createElement("div");
    titleRow.className = "task-title-row";
    const titleSpan = document.createElement("span");
    titleSpan.className = "task-title";
    titleSpan.textContent = task.title;
    titleRow.appendChild(titleSpan);

    const meta = document.createElement("div");
    meta.className = "task-meta";

    const timeBadge = document.createElement("span");
    timeBadge.className = "badge badge-time";
    timeBadge.textContent = task.startTime
      ? `${formatTimeRange(task.startTime, task.duration)} (${formatDuration(task.duration)})`
      : `Unscheduled • ${formatDuration(task.duration)}`;
    meta.appendChild(timeBadge);

    const prioBadge = document.createElement("span");
    prioBadge.className = `badge badge-${task.priority}`;
    prioBadge.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
    meta.appendChild(prioBadge);

    const catBadge = document.createElement("span");
    catBadge.className = "badge badge-cat";
    catBadge.textContent = task.category;
    meta.appendChild(catBadge);

    if (conflictIds.has(task.id)) {
      const confBadge = document.createElement("span");
      confBadge.className = "badge badge-conflict";
      confBadge.textContent = "Overlap";
      meta.appendChild(confBadge);
    }

    main.append(titleRow, meta);

    if (task.notes) {
      const notes = document.createElement("p");
      notes.className = "task-notes";
      notes.textContent = task.notes;
      main.appendChild(notes);
    }

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "task-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "task-action-btn";
    editBtn.title = "Edit task";
    editBtn.setAttribute("aria-label", `Edit "${task.title}"`);
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => openTaskDialog(task));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "task-action-btn";
    delBtn.title = "Delete task";
    delBtn.setAttribute("aria-label", `Delete "${task.title}"`);
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => {
      store.pushUndoSnapshot(`Delete "${task.title}"`);
      store.deleteTask(task.id);
      showToast(`Deleted "${task.title}"`);
    });

    actions.append(editBtn, delBtn);
    card.append(checkBtn, main, actions);
    return card;
  }

  function renderTaskList(dayTasks, conflicts) {
    el.taskListContainer.replaceChildren();

    const filtered = dayTasks.filter((t) => {
      if (currentFilter === "pending") return t.status !== "done";
      if (currentFilter === "high") return t.priority === "high" && t.status !== "done";
      if (currentFilter === "done") return t.status === "done";
      return true;
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const h3 = document.createElement("h3");
      h3.textContent = dayTasks.length === 0 ? "Your schedule is clear" : "No tasks match this filter";
      const p = document.createElement("p");
      p.textContent =
        dayTasks.length === 0
          ? "Add tasks above or chat with Aura on the right to plan your day."
          : "Try switching filters or asking Aura to add a task.";
      empty.append(h3, p);
      el.taskListContainer.appendChild(empty);
      return;
    }

    const scheduled = filtered.filter((t) => t.status !== "done" && timeToMinutes(t.startTime) !== null);
    const unscheduled = filtered.filter((t) => t.status !== "done" && timeToMinutes(t.startTime) === null);
    const completed = filtered.filter((t) => t.status === "done");

    const appendGroup = (label, items) => {
      if (items.length === 0) return;
      const heading = document.createElement("div");
      heading.className = "task-section-label";
      heading.textContent = `${label} (${items.length})`;
      el.taskListContainer.appendChild(heading);
      for (const t of items) {
        el.taskListContainer.appendChild(buildTaskCard(t, conflicts.conflictIds));
      }
    };

    if (currentFilter === "done") {
      appendGroup("Completed", completed);
    } else {
      appendGroup("Scheduled", scheduled);
      appendGroup("Unscheduled / Flexible", unscheduled);
      appendGroup("Completed", completed);
    }
  }

  function renderTimeline(dayTasks) {
    el.timelineContainer.replaceChildren();
    const prefs = store.getPreferences();
    const startHour = Math.min(8, Math.floor((timeToMinutes(prefs.workStart) ?? 540) / 60));
    const endHour = Math.max(19, Math.ceil((timeToMinutes(prefs.workEnd) ?? 1080) / 60));

    const scheduled = dayTasks.filter((t) => timeToMinutes(t.startTime) !== null);
    const unscheduled = dayTasks.filter((t) => timeToMinutes(t.startTime) === null && t.status !== "done");

    // Expand hour range if any task falls outside
    let minH = startHour;
    let maxH = endHour;
    for (const t of scheduled) {
      const m = timeToMinutes(t.startTime);
      minH = Math.min(minH, Math.floor(m / 60));
      maxH = Math.max(maxH, Math.min(23, Math.ceil((m + (t.duration || 30)) / 60)));
    }

    const grid = document.createElement("div");
    grid.className = "timeline-grid";

    for (let h = minH; h <= maxH; h++) {
      const row = document.createElement("div");
      row.className = "timeline-hour";

      const label = document.createElement("div");
      label.className = "timeline-hour-label";
      label.textContent = `${String(h).padStart(2, "0")}:00`;

      const body = document.createElement("div");
      body.className = "timeline-slot-body";

      const hourTasks = scheduled.filter((t) => Math.floor(timeToMinutes(t.startTime) / 60) === h);
      for (const t of hourTasks) {
        const block = document.createElement("div");
        block.className = `timeline-block priority-${t.priority}${t.status === "done" ? " is-done" : ""}`;
        block.tabIndex = 0;
        block.setAttribute("role", "button");
        block.addEventListener("click", () => openTaskDialog(t));
        block.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openTaskDialog(t);
          }
        });

        const left = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = t.title;
        left.appendChild(title);

        const right = document.createElement("span");
        right.className = "badge badge-time";
        right.textContent = formatTimeRange(t.startTime, t.duration);

        block.append(left, right);
        body.appendChild(block);
      }

      row.append(label, body);
      grid.appendChild(row);
    }

    el.timelineContainer.appendChild(grid);

    if (unscheduled.length > 0) {
      const box = document.createElement("div");
      box.className = "timeline-unscheduled";
      const h4 = document.createElement("h4");
      h4.textContent = `Unscheduled Tasks (${unscheduled.length}) — click Auto-Schedule or ask Aura to slot them`;
      box.appendChild(h4);

      const list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "6px";
      for (const t of unscheduled) {
        const block = document.createElement("div");
        block.className = `timeline-block priority-${t.priority}`;
        block.addEventListener("click", () => openTaskDialog(t));
        const title = document.createElement("strong");
        title.textContent = t.title;
        const dur = document.createElement("span");
        dur.className = "badge badge-cat";
        dur.textContent = `${formatDuration(t.duration)} • ${t.priority}`;
        block.append(title, dur);
        list.appendChild(block);
      }
      box.appendChild(list);
      el.timelineContainer.appendChild(box);
    }
  }

  function renderChat() {
    el.chatMessages.replaceChildren();
    for (const msg of store.state.messages) {
      const wrap = document.createElement("div");
      wrap.className = `chat-msg ${msg.role}${msg.isError ? " is-error" : ""}`;

      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = msg.text;
      wrap.appendChild(bubble);

      if (Array.isArray(msg.actions) && msg.actions.length > 0) {
        const log = document.createElement("div");
        log.className = "action-log";
        for (const act of msg.actions) {
          const pill = document.createElement("span");
          pill.className = "action-pill";
          pill.textContent = act;
          log.appendChild(pill);
        }
        wrap.appendChild(log);
      }

      const time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = formatShortTime(msg.timestamp);
      wrap.appendChild(time);

      el.chatMessages.appendChild(wrap);
    }

    if (isAgentThinking) {
      const wrap = document.createElement("div");
      wrap.className = "chat-msg assistant";
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      const dots = document.createElement("div");
      dots.className = "typing-dots";
      dots.setAttribute("aria-label", "Aura is thinking");
      dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
      bubble.appendChild(dots);
      wrap.appendChild(bubble);
      el.chatMessages.appendChild(wrap);
    }

    el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
  }

  function renderAll() {
    el.datePicker.value = selectedDate;
    el.selectedDateHeading.textContent = formatDateHeading(selectedDate);
    el.selectedDateSub.textContent = formatDateFull(selectedDate);
    el.syncIndicator.textContent = store.syncStatus;

    const dayTasks = store.getTasksForDate(selectedDate);
    const conflicts = store.detectConflicts(selectedDate);

    renderStats(dayTasks, conflicts);
    renderAgentHeader();

    if (currentView === "timeline") {
      el.taskListContainer.hidden = true;
      el.timelineContainer.hidden = false;
      renderTimeline(dayTasks);
    } else {
      el.taskListContainer.hidden = false;
      el.timelineContainer.hidden = true;
      renderTaskList(dayTasks, conflicts);
    }

    renderChat();
  }

  // ---------- Modals ----------

  function setupDialogDismiss(dialog) {
    dialog.querySelectorAll("[data-close-dialog]").forEach((btn) => {
      btn.addEventListener("click", () => dialog.close());
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  function openTaskDialog(task = null) {
    if (task) {
      el.taskDialogTitle.textContent = "Edit Task";
      el.taskIdInput.value = task.id;
      el.taskTitleInput.value = task.title;
      el.taskDateInput.value = task.date;
      el.taskTimeInput.value = task.startTime || "";
      el.taskDurationInput.value = task.duration || 30;
      el.taskPriorityInput.value = task.priority || "medium";
      el.taskCategoryInput.value = task.category || "Deep Work";
      el.taskStatusInput.value = task.status || "pending";
      el.taskNotesInput.value = task.notes || "";
      el.deleteTaskModalBtn.hidden = false;
    } else {
      el.taskDialogTitle.textContent = "New Task";
      el.taskIdInput.value = "";
      el.taskTitleInput.value = el.quickAddInput.value.trim();
      el.taskDateInput.value = selectedDate;
      el.taskTimeInput.value = "";
      el.taskDurationInput.value = 30;
      el.taskPriorityInput.value = "medium";
      el.taskCategoryInput.value = "Deep Work";
      el.taskStatusInput.value = "pending";
      el.taskNotesInput.value = "";
      el.deleteTaskModalBtn.hidden = true;
    }
    el.taskDialog.showModal();
    el.taskTitleInput.focus();
  }

  function syncSettingsVisibility() {
    const provider = el.providerSelect.value;
    el.byokFields.hidden = provider === "offline";
    el.baseUrlField.hidden = provider !== "openai";

    if (provider === "gemini" && (!el.modelInput.value || el.modelInput.value.startsWith("gpt-"))) {
      el.modelInput.value = "gemini-2.5-flash";
    } else if (provider === "openai" && (!el.modelInput.value || el.modelInput.value.startsWith("gemini-"))) {
      el.modelInput.value = "gpt-4o-mini";
    }
  }

  function openSettingsDialog() {
    const prefs = store.getPreferences();
    el.providerSelect.value = prefs.provider || "offline";
    el.baseUrlInput.value = prefs.baseUrl || "https://api.openai.com/v1";
    el.modelInput.value = prefs.model || (prefs.provider === "openai" ? "gpt-4o-mini" : "gemini-2.5-flash");
    el.apiKeyInput.value = store.getApiKey();
    el.workStartInput.value = prefs.workStart || "09:00";
    el.workEndInput.value = prefs.workEnd || "18:00";
    el.breakBufferInput.value = prefs.breakBuffer ?? 10;
    el.peakEnergySelect.value = prefs.peakEnergy || "morning";
    el.customInstructionsInput.value = prefs.customInstructions || "";
    syncSettingsVisibility();
    el.settingsDialog.showModal();
  }

  // ---------- Chat Send Flow ----------

  async function sendToAgent(text) {
    const clean = String(text || "").trim();
    if (!clean || isAgentThinking) return;

    store.addMessage("user", clean);
    el.chatInput.value = "";
    el.chatInput.style.height = "auto";
    isAgentThinking = true;
    el.chatSendBtn.disabled = true;
    renderChat();

    try {
      const result = await agent.handleUserMessage(clean, selectedDate);
      isAgentThinking = false;
      store.addMessage("assistant", result.reply, { actions: result.actions || [] });
    } catch (err) {
      isAgentThinking = false;
      store.addMessage("assistant", err.message || "Something went wrong calling the AI provider.", {
        isError: true
      });
    } finally {
      el.chatSendBtn.disabled = false;
      renderAll();
    }
  }

  // ---------- Event Wiring ----------

  setupDialogDismiss(el.taskDialog);
  setupDialogDismiss(el.settingsDialog);
  setupDialogDismiss(el.exportDialog);

  // Date navigation
  el.datePicker.addEventListener("change", (e) => {
    if (e.target.value) {
      selectedDate = e.target.value;
      renderAll();
    }
  });
  el.prevDayBtn.addEventListener("click", () => {
    selectedDate = addDaysISO(selectedDate, -1);
    renderAll();
  });
  el.nextDayBtn.addEventListener("click", () => {
    selectedDate = addDaysISO(selectedDate, 1);
    renderAll();
  });
  el.todayBtn.addEventListener("click", () => {
    selectedDate = getTodayISO();
    renderAll();
  });

  // View toggle
  el.viewListBtn.addEventListener("click", () => {
    currentView = "list";
    el.viewListBtn.classList.add("active");
    el.viewTimelineBtn.classList.remove("active");
    renderAll();
  });
  el.viewTimelineBtn.addEventListener("click", () => {
    currentView = "timeline";
    el.viewTimelineBtn.classList.add("active");
    el.viewListBtn.classList.remove("active");
    renderAll();
  });

  // Filter pills
  el.filterPills.forEach((pill) => {
    pill.addEventListener("click", () => {
      currentFilter = pill.dataset.filter;
      el.filterPills.forEach((p) => p.classList.toggle("active", p === pill));
      renderAll();
    });
  });

  // Auto-schedule button
  el.autoScheduleBtn.addEventListener("click", () => {
    sendToAgent("Plan my day and auto-schedule unscheduled tasks");
  });

  // Quick Add form
  el.quickAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = el.quickAddInput.value.trim();
    if (!raw) return;
    const parsed = agent.parseQuickAdd(raw, selectedDate);
    if (!parsed) return;
    store.pushUndoSnapshot(`Quick add "${parsed.title}"`);
    store.addTask(parsed);
    el.quickAddInput.value = "";
    if (parsed.date !== selectedDate) {
      selectedDate = parsed.date;
    }
    showToast(`Added "${parsed.title}"${parsed.startTime ? ` @ ${parsed.startTime}` : ""}`);
    renderAll();
  });

  el.openNewTaskModalBtn.addEventListener("click", () => openTaskDialog(null));

  // Task Modal submit & delete
  el.taskForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = el.taskIdInput.value;
    const payload = {
      title: el.taskTitleInput.value.trim(),
      date: el.taskDateInput.value || selectedDate,
      startTime: el.taskTimeInput.value,
      duration: Number(el.taskDurationInput.value) || 30,
      priority: el.taskPriorityInput.value,
      category: el.taskCategoryInput.value,
      status: el.taskStatusInput.value,
      notes: el.taskNotesInput.value
    };
    if (!payload.title) return;

    if (id) {
      store.pushUndoSnapshot(`Edit "${payload.title}"`);
      store.updateTask(id, payload);
      showToast("Task updated");
    } else {
      store.pushUndoSnapshot(`Add "${payload.title}"`);
      store.addTask(payload);
      el.quickAddInput.value = "";
      showToast("Task added");
    }
    el.taskDialog.close();
  });

  el.deleteTaskModalBtn.addEventListener("click", () => {
    const id = el.taskIdInput.value;
    if (!id) return;
    store.pushUndoSnapshot("Delete task");
    store.deleteTask(id);
    el.taskDialog.close();
    showToast("Task deleted");
  });

  // Agent chat
  el.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendToAgent(el.chatInput.value);
  });

  el.chatInput.addEventListener("input", () => {
    el.chatInput.style.height = "auto";
    el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight, 130)}px`;
  });

  el.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendToAgent(el.chatInput.value);
    }
  });

  el.promptChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      sendToAgent(chip.dataset.prompt);
    });
  });

  el.undoAgentBtn.addEventListener("click", () => {
    const label = store.undo();
    if (label) showToast(`Undid: ${label}`);
  });

  el.clearChatBtn.addEventListener("click", () => {
    store.clearMessages();
    showToast("Conversation cleared");
  });

  // Settings Modal
  el.settingsBtn.addEventListener("click", openSettingsDialog);
  el.agentModePill.addEventListener("click", openSettingsDialog);
  el.providerSelect.addEventListener("change", syncSettingsVisibility);

  el.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    store.updatePreferences({
      provider: el.providerSelect.value,
      baseUrl: el.baseUrlInput.value.trim() || "https://api.openai.com/v1",
      model: el.modelInput.value.trim() || "gemini-2.5-flash",
      workStart: el.workStartInput.value || "09:00",
      workEnd: el.workEndInput.value || "18:00",
      breakBuffer: Math.max(0, Number(el.breakBufferInput.value) || 0),
      peakEnergy: el.peakEnergySelect.value,
      customInstructions: el.customInstructionsInput.value.trim()
    });
    store.setApiKey(el.apiKeyInput.value);
    el.settingsDialog.close();
    showToast("Settings saved");
  });

  el.resetDemoBtn.addEventListener("click", () => {
    store.loadSampleDay(selectedDate);
    el.settingsDialog.close();
    showToast("Loaded sample tasks for this day");
  });

  // Export / Import Modal
  el.exportBtn.addEventListener("click", () => el.exportDialog.showModal());

  el.downloadIcsBtn.addEventListener("click", () => {
    const { content, count } = store.exportICS(selectedDate);
    if (count === 0) {
      showToast("No scheduled tasks on this day to export");
      return;
    }
    downloadFile(`aura-plan-${selectedDate}.ics`, content, "text/calendar;charset=utf-8");
    showToast(`Exported ${count} scheduled event${count > 1 ? "s" : ""} (.ics)`);
  });

  el.downloadJsonBtn.addEventListener("click", () => {
    downloadFile(`aura-planner-backup-${getTodayISO()}.json`, store.exportJSON(), "application/json");
    showToast("Backup JSON downloaded");
  });

  el.importJsonInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const count = store.importJSON(String(reader.result || ""));
        el.exportDialog.close();
        showToast(`Restored ${count} tasks from backup`);
      } catch (err) {
        showToast(err.message || "Could not import JSON");
      }
      el.importJsonInput.value = "";
    };
    reader.readAsText(file);
  });

  // Theme Toggle
  el.themeToggleBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    store.updatePreferences({ theme: next });
    applyTheme(next);
  });

  // Mobile pane switcher
  function setMobilePane(pane) {
    const isPlan = pane === "plan";
    el.mobileTabPlan.classList.toggle("active", isPlan);
    el.mobileTabAgent.classList.toggle("active", !isPlan);
    el.mobileTabPlan.setAttribute("aria-selected", String(isPlan));
    el.mobileTabAgent.setAttribute("aria-selected", String(!isPlan));
    el.planPane.classList.toggle("mobile-hidden", !isPlan);
    el.agentPane.classList.toggle("mobile-hidden", isPlan);
  }
  el.mobileTabPlan.addEventListener("click", () => setMobilePane("plan"));
  el.mobileTabAgent.addEventListener("click", () => setMobilePane("agent"));
  if (window.innerWidth <= 960) setMobilePane("plan");

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (isTyping) return;
    if (e.key === "/") {
      e.preventDefault();
      el.chatInput.focus();
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      openTaskDialog(null);
    }
  });

  // Subscribe & Bootstrap
  store.subscribe(() => renderAll());
  applyTheme(store.getPreferences().theme);
  renderAll();
  store.initServerSync();
})();
