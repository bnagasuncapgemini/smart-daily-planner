/**
 * PlannerStore — State, scheduling engine, undo stack, and persistence
 * Works offline via localStorage and optionally syncs with local server.ps1 (/api/state).
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "aura_daily_planner_state_v1";
  const SECRET_KEY = "aura_daily_planner_api_key_v1";

  const DEFAULT_PREFERENCES = {
    provider: "offline", // "offline" | "gemini" | "openai"
    baseUrl: "https://api.openai.com/v1",
    model: "gemini-2.5-flash",
    workStart: "09:00",
    workEnd: "18:00",
    breakBuffer: 10,
    peakEnergy: "morning", // "morning" | "afternoon" | "evening"
    customInstructions: "",
    theme: "auto" // "auto" | "light" | "dark"
  };

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function getTodayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function addDaysISO(dateISO, deltaDays) {
    const [y, m, d] = dateISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d + deltaDays);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function formatDateHeading(dateISO) {
    const today = getTodayISO();
    const tomorrow = addDaysISO(today, 1);
    const yesterday = addDaysISO(today, -1);
    if (dateISO === today) return "Today";
    if (dateISO === tomorrow) return "Tomorrow";
    if (dateISO === yesterday) return "Yesterday";
    const [y, m, d] = dateISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  function formatDateFull(dateISO) {
    const [y, m, d] = dateISO.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  }

  function timeToMinutes(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return null;
    const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  function minutesToTime(totalMin) {
    const clamped = Math.max(0, Math.min(23 * 60 + 55, Math.round(totalMin)));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${pad2(h)}:${pad2(m)}`;
  }

  function formatTimeRange(startTime, duration) {
    const start = timeToMinutes(startTime);
    if (start === null) return "Unscheduled";
    const end = start + (Number(duration) || 30);
    return `${minutesToTime(start)} – ${minutesToTime(end)}`;
  }

  function formatDuration(minutes) {
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  }

  function uid(prefix = "t") {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return `${prefix}_${global.crypto.randomUUID().slice(0, 8)}`;
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  function priorityRank(p) {
    if (p === "high") return 3;
    if (p === "medium") return 2;
    return 1;
  }

  function createSampleTasks(dateISO) {
    return [
      {
        id: uid("task"),
        title: "Review top 3 priorities & clear inbox",
        date: dateISO,
        startTime: "09:00",
        duration: 30,
        priority: "medium",
        category: "Admin",
        status: "pending",
        notes: "Triage urgent messages before deep work.",
        createdAt: new Date().toISOString()
      },
      {
        id: uid("task"),
        title: "Deep work: Draft project plan",
        date: dateISO,
        startTime: "09:45",
        duration: 90,
        priority: "high",
        category: "Deep Work",
        status: "pending",
        notes: "Focus block — silence notifications.",
        createdAt: new Date().toISOString()
      },
      {
        id: uid("task"),
        title: "Team sync & status check-in",
        date: dateISO,
        startTime: "14:00",
        duration: 30,
        priority: "medium",
        category: "Meetings",
        status: "pending",
        notes: "",
        createdAt: new Date().toISOString()
      },
      {
        id: uid("task"),
        title: "Prepare tomorrow's agenda & wrap-up notes",
        date: dateISO,
        startTime: "",
        duration: 25,
        priority: "low",
        category: "Admin",
        status: "pending",
        notes: "Ask Aura to auto-schedule this!",
        createdAt: new Date().toISOString()
      }
    ];
  }

  function createWelcomeMessages() {
    return [
      {
        id: uid("msg"),
        role: "assistant",
        text:
          "Hi! I'm Aura, your Daily Planner AI Agent.\n\n" +
          "Tell me what you need to get done in plain English — I can add tasks, reprioritize your list, find free slots, reschedule conflicts, or auto-plan your entire day.\n\n" +
          "Try saying:\n" +
          "• \"Add finish budget report for 60m high priority at 11am\"\n" +
          "• \"Plan my day\"\n" +
          "• \"Move team sync to 3:30pm\"\n" +
          "• \"What's left today?\"",
        actions: [],
        timestamp: new Date().toISOString()
      }
    ];
  }

  class PlannerStore {
    constructor() {
      this.state = {
        tasks: [],
        messages: [],
        preferences: { ...DEFAULT_PREFERENCES }
      };
      this.undoStack = [];
      this.listeners = new Set();
      this.serverSyncAvailable = false;
      this.syncStatus = "Saved locally";
      this._loadLocal();
    }

    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    _emit() {
      for (const fn of this.listeners) {
        try {
          fn(this.state);
        } catch (err) {
          console.error("Store listener error:", err);
        }
      }
    }

    _loadLocal() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
          this.state.messages =
            Array.isArray(parsed.messages) && parsed.messages.length
              ? parsed.messages
              : createWelcomeMessages();
          this.state.preferences = {
            ...DEFAULT_PREFERENCES,
            ...(parsed.preferences || {})
          };
          return;
        }
      } catch (err) {
        console.warn("Could not read localStorage state:", err);
      }
      // First-time initialization
      this.state.tasks = createSampleTasks(getTodayISO());
      this.state.messages = createWelcomeMessages();
      this.state.preferences = { ...DEFAULT_PREFERENCES };
      this._saveLocal();
    }

    _saveLocal() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (err) {
        console.warn("Could not persist state to localStorage:", err);
      }
    }

    getApiKey() {
      try {
        return localStorage.getItem(SECRET_KEY) || "";
      } catch {
        return "";
      }
    }

    setApiKey(key) {
      try {
        if (key && key.trim()) {
          localStorage.setItem(SECRET_KEY, key.trim());
        } else {
          localStorage.removeItem(SECRET_KEY);
        }
      } catch (err) {
        console.warn("Could not save API key:", err);
      }
    }

    async initServerSync() {
      if (location.protocol !== "http:" && location.protocol !== "https:") {
        this.syncStatus = "Saved in browser";
        this._emit();
        return;
      }
      try {
        const res = await fetch("/api/state", { method: "GET" });
        if (!res.ok) return;
        this.serverSyncAvailable = true;
        const remote = await res.json();
        if (remote && Array.isArray(remote.tasks) && remote.tasks.length > 0) {
          // Prefer disk state if it exists and has tasks
          this.state.tasks = remote.tasks;
          if (Array.isArray(remote.messages) && remote.messages.length > 0) {
            this.state.messages = remote.messages;
          }
          if (remote.preferences) {
            this.state.preferences = { ...DEFAULT_PREFERENCES, ...remote.preferences };
          }
          this._saveLocal();
        } else {
          await this._pushServerState();
        }
        this.syncStatus = "Synced to disk";
        this._emit();
      } catch {
        this.serverSyncAvailable = false;
        this.syncStatus = "Saved in browser";
      }
    }

    async _pushServerState() {
      if (!this.serverSyncAvailable) return;
      try {
        await fetch("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.state)
        });
        this.syncStatus = "Synced to disk";
      } catch {
        this.syncStatus = "Saved locally";
      }
    }

    commit() {
      this._saveLocal();
      this._pushServerState();
      this._emit();
    }

    pushUndoSnapshot(label) {
      const snapshot = {
        label: label || "Agent change",
        tasks: JSON.parse(JSON.stringify(this.state.tasks))
      };
      this.undoStack.push(snapshot);
      if (this.undoStack.length > 20) this.undoStack.shift();
    }

    canUndo() {
      return this.undoStack.length > 0;
    }

    undo() {
      const snap = this.undoStack.pop();
      if (!snap) return null;
      this.state.tasks = snap.tasks;
      this.commit();
      return snap.label;
    }

    getPreferences() {
      return { ...this.state.preferences };
    }

    updatePreferences(patch) {
      this.state.preferences = { ...this.state.preferences, ...patch };
      this.commit();
    }

    loadSampleDay(dateISO) {
      this.pushUndoSnapshot("Load sample day");
      const target = dateISO || getTodayISO();
      // Remove existing tasks for target date and replace with fresh sample tasks
      this.state.tasks = this.state.tasks.filter((t) => t.date !== target);
      this.state.tasks.push(...createSampleTasks(target));
      this.commit();
    }

    getTasksForDate(dateISO) {
      return this.state.tasks
        .filter((t) => t.date === dateISO)
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "done" ? 1 : -1;
          const ta = timeToMinutes(a.startTime);
          const tb = timeToMinutes(b.startTime);
          if (ta !== null && tb !== null && ta !== tb) return ta - tb;
          if (ta !== null && tb === null) return -1;
          if (ta === null && tb !== null) return 1;
          const pr = priorityRank(b.priority) - priorityRank(a.priority);
          if (pr !== 0) return pr;
          return (a.title || "").localeCompare(b.title || "");
        });
    }

    getAllTasks() {
      return [...this.state.tasks];
    }

    findTaskByIdOrTitle(idOrTitle, preferredDate) {
      if (!idOrTitle) return null;
      const byId = this.state.tasks.find((t) => t.id === idOrTitle);
      if (byId) return byId;

      const needle = String(idOrTitle).trim().toLowerCase();
      if (!needle) return null;

      // Exact title match on preferredDate first
      let candidates = preferredDate
        ? this.state.tasks.filter((t) => t.date === preferredDate)
        : this.state.tasks;

      let match = candidates.find((t) => t.title.toLowerCase() === needle);
      if (match) return match;

      // Partial substring match on preferredDate
      match = candidates.find((t) => t.title.toLowerCase().includes(needle));
      if (match) return match;

      // Token overlap fuzzy match on preferredDate
      const tokens = needle.split(/\s+/).filter((w) => w.length > 2);
      if (tokens.length > 0) {
        let best = null;
        let bestScore = 0;
        for (const t of candidates) {
          const lower = t.title.toLowerCase();
          const score = tokens.reduce((acc, tok) => acc + (lower.includes(tok) ? 1 : 0), 0);
          if (score > bestScore) {
            bestScore = score;
            best = t;
          }
        }
        if (best && bestScore >= Math.ceil(tokens.length * 0.5)) return best;
      }

      // Fallback search across all dates
      return this.state.tasks.find((t) => t.title.toLowerCase().includes(needle)) || null;
    }

    addTask(data, { skipCommit = false } = {}) {
      const task = {
        id: uid("task"),
        title: String(data.title || "Untitled task").trim(),
        date: data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? data.date : getTodayISO(),
        startTime: timeToMinutes(data.startTime) !== null ? minutesToTime(timeToMinutes(data.startTime)) : "",
        duration: Math.max(5, Math.min(480, Math.round(Number(data.duration) || 30))),
        priority: ["high", "medium", "low"].includes(data.priority) ? data.priority : "medium",
        category: data.category || "Deep Work",
        status: data.status === "done" ? "done" : "pending",
        notes: String(data.notes || "").trim(),
        createdAt: new Date().toISOString()
      };
      this.state.tasks.push(task);
      if (!skipCommit) this.commit();
      return task;
    }

    updateTask(id, patch, { skipCommit = false } = {}) {
      const idx = this.state.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const cur = this.state.tasks[idx];
      const next = { ...cur };
      if (patch.title !== undefined && String(patch.title).trim()) next.title = String(patch.title).trim();
      if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) next.date = patch.date;
      if (patch.startTime !== undefined) {
        next.startTime =
          patch.startTime === "" || patch.startTime === null
            ? ""
            : timeToMinutes(patch.startTime) !== null
            ? minutesToTime(timeToMinutes(patch.startTime))
            : cur.startTime;
      }
      if (patch.duration !== undefined) {
        const d = Number(patch.duration);
        if (!Number.isNaN(d) && d >= 5) next.duration = Math.min(480, Math.round(d));
      }
      if (patch.priority !== undefined && ["high", "medium", "low"].includes(patch.priority)) {
        next.priority = patch.priority;
      }
      if (patch.category !== undefined && patch.category) {
        next.category = patch.category;
      }
      if (patch.status !== undefined && ["pending", "done"].includes(patch.status)) {
        next.status = patch.status;
      }
      if (patch.notes !== undefined) {
        next.notes = String(patch.notes).trim();
      }
      this.state.tasks[idx] = next;
      if (!skipCommit) this.commit();
      return next;
    }

    deleteTask(id, { skipCommit = false } = {}) {
      const idx = this.state.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return null;
      const [removed] = this.state.tasks.splice(idx, 1);
      if (!skipCommit) this.commit();
      return removed;
    }

    toggleTaskDone(id) {
      const t = this.state.tasks.find((item) => item.id === id);
      if (!t) return null;
      t.status = t.status === "done" ? "pending" : "done";
      this.commit();
      return t;
    }

    /**
     * Detect overlapping scheduled pending tasks for a given date.
     * Returns Set of conflicting task IDs and array of overlap pairs.
     */
    detectConflicts(dateISO) {
      const scheduled = this.getTasksForDate(dateISO)
        .filter((t) => t.status !== "done" && timeToMinutes(t.startTime) !== null)
        .map((t) => {
          const start = timeToMinutes(t.startTime);
          return { task: t, start, end: start + (t.duration || 30) };
        })
        .sort((a, b) => a.start - b.start);

      const conflictIds = new Set();
      const pairs = [];
      for (let i = 0; i < scheduled.length; i++) {
        for (let j = i + 1; j < scheduled.length; j++) {
          if (scheduled[j].start < scheduled[i].end) {
            conflictIds.add(scheduled[i].task.id);
            conflictIds.add(scheduled[j].task.id);
            pairs.push([scheduled[i].task, scheduled[j].task]);
          }
        }
      }
      return { conflictIds, pairs };
    }

    /**
     * Find all free intervals inside workday hours for a given date.
     */
    getFreeSlots(dateISO, minDuration = 15) {
      const prefs = this.state.preferences;
      const workStart = timeToMinutes(prefs.workStart) ?? 540;
      const workEnd = timeToMinutes(prefs.workEnd) ?? 1080;
      const buffer = Math.max(0, Number(prefs.breakBuffer) || 0);

      const busy = this.getTasksForDate(dateISO)
        .filter((t) => t.status !== "done" && timeToMinutes(t.startTime) !== null)
        .map((t) => {
          const s = timeToMinutes(t.startTime);
          return { start: s, end: s + (t.duration || 30) };
        })
        .sort((a, b) => a.start - b.start);

      // Merge overlapping busy intervals
      const merged = [];
      for (const b of busy) {
        if (!merged.length || b.start > merged[merged.length - 1].end) {
          merged.push({ ...b });
        } else {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
        }
      }

      const free = [];
      let cursor = workStart;
      for (const block of merged) {
        const gapStart = cursor;
        const gapEnd = Math.min(block.start, workEnd);
        if (gapEnd - gapStart >= minDuration) {
          free.push({ start: gapStart, end: gapEnd, duration: gapEnd - gapStart });
        }
        cursor = Math.max(cursor, block.end + buffer);
      }
      if (workEnd - cursor >= minDuration) {
        free.push({ start: cursor, end: workEnd, duration: workEnd - cursor });
      }
      return free;
    }

    /**
     * Auto-schedule unscheduled pending tasks (or all pending if includeScheduled=true).
     */
    autoSchedule(dateISO, { includeScheduled = false, strategy = "energy_match", skipCommit = false } = {}) {
      const prefs = this.state.preferences;
      const workStart = timeToMinutes(prefs.workStart) ?? 540;
      const workEnd = timeToMinutes(prefs.workEnd) ?? 1080;
      const buffer = Math.max(0, Number(prefs.breakBuffer) || 0);

      const dayTasks = this.state.tasks.filter((t) => t.date === dateISO && t.status !== "done");
      const toSchedule = dayTasks.filter((t) => includeScheduled || timeToMinutes(t.startTime) === null);
      if (toSchedule.length === 0) return { scheduled: [], unplaced: [] };

      // Build busy blocks from tasks that keep their existing slot
      const busy = dayTasks
        .filter((t) => !toSchedule.includes(t) && timeToMinutes(t.startTime) !== null)
        .map((t) => {
          const s = timeToMinutes(t.startTime);
          return { start: s, end: s + (t.duration || 30) };
        });

      // Determine sort order
      const sorted = [...toSchedule].sort((a, b) => {
        if (strategy === "quick_wins") {
          if (a.duration !== b.duration) return a.duration - b.duration;
          return priorityRank(b.priority) - priorityRank(a.priority);
        }
        const pr = priorityRank(b.priority) - priorityRank(a.priority);
        if (pr !== 0) return pr;
        if (a.category === "Deep Work" && b.category !== "Deep Work") return -1;
        if (b.category === "Deep Work" && a.category !== "Deep Work") return 1;
        return (b.duration || 30) - (a.duration || 30);
      });

      const peakWindow =
        prefs.peakEnergy === "afternoon"
          ? { start: 13 * 60, end: 16 * 60 + 30 }
          : prefs.peakEnergy === "evening"
          ? { start: 16 * 60 + 30, end: 20 * 60 }
          : { start: workStart, end: 12 * 60 + 30 };

      const scheduled = [];
      const unplaced = [];

      const findSlot = (duration, preferPeak) => {
        const intervals = [...busy].sort((a, b) => a.start - b.start);
        const searchWindows = preferPeak
          ? [
              { start: Math.max(workStart, peakWindow.start), end: Math.min(workEnd, peakWindow.end) },
              { start: workStart, end: workEnd }
            ]
          : [{ start: workStart, end: workEnd }];

        for (const win of searchWindows) {
          if (win.end - win.start < duration) continue;
          let candidate = win.start;
          // Round candidate up to nearest 5 minutes
          candidate = Math.ceil(candidate / 5) * 5;

          let placed = false;
          while (candidate + duration <= win.end) {
            const clash = intervals.find(
              (b) => candidate < b.end + buffer && candidate + duration + buffer > b.start
            );
            if (!clash) {
              placed = true;
              break;
            }
            candidate = Math.ceil((clash.end + buffer) / 5) * 5;
          }
          if (placed) return candidate;
        }
        return null;
      };

      for (const task of sorted) {
        const dur = task.duration || 30;
        const preferPeak =
          strategy === "energy_match" && (task.priority === "high" || task.category === "Deep Work");
        const slot = findSlot(dur, preferPeak);
        if (slot !== null) {
          task.startTime = minutesToTime(slot);
          busy.push({ start: slot, end: slot + dur });
          scheduled.push(task);
        } else {
          unplaced.push(task);
        }
      }

      if (!skipCommit && scheduled.length > 0) this.commit();
      return { scheduled, unplaced };
    }

    addMessage(role, text, { actions = [], isError = false } = {}) {
      const msg = {
        id: uid("msg"),
        role,
        text: String(text || ""),
        actions: Array.isArray(actions) ? actions : [],
        isError: Boolean(isError),
        timestamp: new Date().toISOString()
      };
      this.state.messages.push(msg);
      if (this.state.messages.length > 80) {
        this.state.messages = this.state.messages.slice(-80);
      }
      this.commit();
      return msg;
    }

    clearMessages() {
      this.state.messages = createWelcomeMessages();
      this.commit();
    }

    exportJSON() {
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          version: 1,
          tasks: this.state.tasks,
          preferences: this.state.preferences
        },
        null,
        2
      );
    }

    importJSON(rawString) {
      const parsed = JSON.parse(rawString);
      if (!parsed || !Array.isArray(parsed.tasks)) {
        throw new Error("Invalid backup file: missing tasks array.");
      }
      this.pushUndoSnapshot("Import JSON backup");
      this.state.tasks = parsed.tasks;
      if (parsed.preferences) {
        this.state.preferences = { ...DEFAULT_PREFERENCES, ...parsed.preferences };
      }
      this.commit();
      return this.state.tasks.length;
    }

    exportICS(dateISO) {
      const tasks = this.getTasksForDate(dateISO).filter((t) => timeToMinutes(t.startTime) !== null);
      const escapeICS = (s) =>
        String(s || "")
          .replace(/\\/g, "\\\\")
          .replace(/;/g, "\\;")
          .replace(/,/g, "\\,")
          .replace(/\r?\n/g, "\\n");

      const toICSDateTime = (dISO, mins) => {
        const cleanDate = dISO.replace(/-/g, "");
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return `${cleanDate}T${pad2(h)}${pad2(m)}00`;
      };

      const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Aura Daily Planner AI Agent//EN",
        "CALSCALE:GREGORIAN"
      ];

      const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      for (const t of tasks) {
        const start = timeToMinutes(t.startTime);
        const end = start + (t.duration || 30);
        lines.push(
          "BEGIN:VEVENT",
          `UID:${t.id}@aura-daily-planner`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${toICSDateTime(t.date, start)}`,
          `DTEND:${toICSDateTime(t.date, end)}`,
          `SUMMARY:${escapeICS(t.title)}`,
          `DESCRIPTION:${escapeICS(`[${t.priority.toUpperCase()} | ${t.category}] ${t.notes || ""}`.trim())}`,
          `STATUS:${t.status === "done" ? "COMPLETED" : "CONFIRMED"}`,
          "END:VEVENT"
        );
      }
      lines.push("END:VCALENDAR");
      return { content: lines.join("\r\n"), count: tasks.length };
    }
  }

  global.PlannerUtils = {
    getTodayISO,
    addDaysISO,
    formatDateHeading,
    formatDateFull,
    timeToMinutes,
    minutesToTime,
    formatTimeRange,
    formatDuration,
    priorityRank
  };
  global.PlannerStore = PlannerStore;
})(window);
