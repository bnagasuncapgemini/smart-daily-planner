/**
 * DailyPlannerAgent — Tool-using AI Agent supporting:
 *   1. Built-in Offline Natural-Language Planner Agent (zero API key required)
 *   2. Google Gemini API (BYOK)
 *   3. OpenAI-Compatible API (BYOK: OpenAI, Groq, Ollama, Local Mock)
 */
(function (global) {
  "use strict";

  const {
    getTodayISO,
    addDaysISO,
    formatDateHeading,
    timeToMinutes,
    minutesToTime,
    formatTimeRange,
    formatDuration,
    priorityRank
  } = global.PlannerUtils;

  const SYSTEM_SCHEMA_PROMPT = `You are Aura, a calm, proactive, expert Daily Planner AI Agent.
Your job is to help the user plan their day, add tasks, reprioritize work, resolve schedule conflicts, and reschedule tasks thoughtfully.

ALWAYS respond with a SINGLE valid JSON object matching this exact schema (no markdown fences, no commentary outside JSON):
{
  "reply": "Friendly, concise explanation of what you did or recommend (plain text, bullet points welcome).",
  "actions": [
    // Zero or more tool actions from the supported list below:
    // { "type": "add_task", "title": "...", "date": "YYYY-MM-DD", "startTime": "HH:MM or empty", "duration": 30, "priority": "high|medium|low", "category": "Deep Work|Meetings|Admin|Personal|Health", "notes": "" }
    // { "type": "update_task", "taskId": "id_or_empty", "matchTitle": "partial title", "title": "...", "date": "YYYY-MM-DD", "startTime": "HH:MM", "duration": 30, "priority": "high|medium|low", "category": "...", "status": "pending|done", "notes": "..." }
    // { "type": "reschedule_task", "taskId": "id_or_empty", "matchTitle": "partial title", "startTime": "HH:MM", "date": "YYYY-MM-DD", "shiftMinutes": 30 }
    // { "type": "complete_task", "taskId": "id_or_empty", "matchTitle": "partial title", "done": true }
    // { "type": "delete_task", "taskId": "id_or_empty", "matchTitle": "partial title" }
    // { "type": "auto_schedule", "date": "YYYY-MM-DD", "includeScheduled": false, "strategy": "energy_match|priority_first|quick_wins" }
    // { "type": "move_unfinished", "fromDate": "YYYY-MM-DD", "toDate": "YYYY-MM-DD" }
    // { "type": "clear_completed", "date": "YYYY-MM-DD" }
  ]
}

Rules:
- Prefer referencing existing tasks by their exact "taskId" from the provided context.
- Use 24-hour "HH:MM" format for startTime (e.g. "14:30") and "YYYY-MM-DD" for date.
- Avoid scheduling overlaps unless the user explicitly asks for an exact time.
- Respect the user's workday hours, buffer minutes, peak focus energy window, and custom instructions.
- If the user is only asking a question (e.g. summary, what's next, free slots), return "actions": [] and answer helpfully in "reply".`;

  // ---------- Natural Language Parsing Helpers (Offline Agent + Quick Add) ----------

  function parseClockTime(str) {
    // Matches "2pm", "2:30 pm", "14:30", "9am", "12:15pm"
    const m = str.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (m) {
      let h = Number(m[1]);
      const min = Number(m[2] || 0);
      const meridiem = m[3].toLowerCase();
      if (h < 1 || h > 12 || min > 59) return null;
      if (meridiem === "pm" && h !== 12) h += 12;
      if (meridiem === "am" && h === 12) h = 0;
      return { time: minutesToTime(h * 60 + min), raw: m[0] };
    }
    const m24 = str.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (m24) {
      return { time: minutesToTime(Number(m24[1]) * 60 + Number(m24[2])), raw: m24[0] };
    }
    return null;
  }

  function parseTimeRange(str) {
    // e.g. "from 2pm to 3:30pm" or "9:00-10:30" or "10am - 11am"
    const rangeRegex =
      /(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-|–)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i;
    const m = str.match(rangeRegex);
    if (!m) return null;

    let left = m[1].trim();
    let right = m[2].trim();
    // Propagate am/pm from right to left if omitted on left (e.g. "2 to 3pm")
    const rightMer = right.match(/(am|pm)$/i);
    if (rightMer && !/(am|pm)$/i.test(left) && !left.includes(":")) {
      left = `${left}${rightMer[1]}`;
    }
    const startParsed = parseClockTime(left);
    const endParsed = parseClockTime(right);
    if (!startParsed || !endParsed) return null;
    const sMin = timeToMinutes(startParsed.time);
    const eMin = timeToMinutes(endParsed.time);
    if (eMin <= sMin) return null;
    return { startTime: startParsed.time, duration: eMin - sMin, raw: m[0] };
  }

  function parseDuration(str) {
    // Matches "for 45m", "for 1.5 hours", "90 mins", "2h 30m", "1h"
    const hm = str.match(/\b(?:for\s+)?(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*m(?:in(?:ute)?s?)?\b/i);
    if (hm) {
      return { duration: Number(hm[1]) * 60 + Number(hm[2]), raw: hm[0] };
    }
    const hrs = str.match(/\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i);
    if (hrs) {
      return { duration: Math.round(Number(hrs[1]) * 60), raw: hrs[0] };
    }
    const mins = str.match(/\b(?:for\s+)?(\d+)\s*(?:minutes?|mins?|m)\b/i);
    if (mins) {
      return { duration: Number(mins[1]), raw: mins[0] };
    }
    return null;
  }

  function parseDateReference(str, defaultDate) {
    const iso = str.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) return { date: iso[1], raw: iso[0] };
    if (/\btomorrow\b/i.test(str)) {
      return { date: addDaysISO(getTodayISO(), 1), raw: str.match(/\btomorrow\b/i)[0] };
    }
    if (/\btoday\b/i.test(str)) {
      return { date: getTodayISO(), raw: str.match(/\btoday\b/i)[0] };
    }
    if (/\byesterday\b/i.test(str)) {
      return { date: addDaysISO(getTodayISO(), -1), raw: str.match(/\byesterday\b/i)[0] };
    }
    const weekdayMatch = str.match(
      /\b(?:next\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i
    );
    if (weekdayMatch) {
      const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const targetDow = days.indexOf(weekdayMatch[1].toLowerCase());
      const now = new Date();
      let delta = (targetDow - now.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return { date: addDaysISO(getTodayISO(), delta), raw: weekdayMatch[0] };
    }
    return { date: defaultDate, raw: "" };
  }

  function parsePriority(str) {
    if (/(?:!high|\bhigh\s*priority\b|\bp1\b|\burgent\b|\bcritical\b|\basap\b|\bimportant\b|\bmust\s*do\b)/i.test(str)) {
      return {
        priority: "high",
        raw: str.match(/(?:!high|\bhigh\s*priority\b|\bp1\b|\burgent\b|\bcritical\b|\basap\b|\bimportant\b|\bmust\s*do\b)/i)[0]
      };
    }
    if (/(?:!low|\blow\s*priority\b|\bp3\b|\boptional\b|\bwhenever\b|\bnice\s*to\s*have\b)/i.test(str)) {
      return {
        priority: "low",
        raw: str.match(/(?:!low|\blow\s*priority\b|\bp3\b|\boptional\b|\bwhenever\b|\bnice\s*to\s*have\b)/i)[0]
      };
    }
    if (/(?:!med(?:ium)?|\bmedium\s*priority\b|\bp2\b)/i.test(str)) {
      return {
        priority: "medium",
        raw: str.match(/(?:!med(?:ium)?|\bmedium\s*priority\b|\bp2\b)/i)[0]
      };
    }
    return { priority: null, raw: "" };
  }

  function inferCategory(title) {
    const t = title.toLowerCase();
    if (/\b(meet(?:ing)?|sync|standup|call|1:1|interview|demo|catch\s*up|zoom|huddle)\b/.test(t)) return "Meetings";
    if (/\b(gym|workout|run|walk|yoga|meditat|doctor|dentist|lunch|stretch|exercise|water|sleep)\b/.test(t)) return "Health";
    if (/\b(email|inbox|invoice|bill|pay|expense|report|admin|reply|slack|paperwork|book|schedule|file)\b/.test(t)) return "Admin";
    if (/\b(grocer|shop|mom|dad|family|dinner|clean|laundry|pick\s*up|errand|birthday|friend)\b/.test(t)) return "Personal";
    return "Deep Work";
  }

  function inferPriorityFromTitle(title) {
    const t = title.toLowerCase();
    if (/\b(deadline|submit|launch|client|urgent|bug|fix|production|presentation|exam|tax|proposal)\b/.test(t)) {
      return "high";
    }
    if (/\b(tidy|clean|read|optional|browse|organize|archive|someday)\b/.test(t)) {
      return "low";
    }
    return "medium";
  }

  function parseSingleTaskPhrase(phrase, defaultDate) {
    let working = phrase.trim();
    // Strip leading command words
    working = working.replace(
      /^(?:please\s+)?(?:add|create|schedule|put|set\s+up|book|remind\s+me\s+to|i\s+need\s+to|need\s+to|plan)\s+(?:a\s+|an\s+|task\s*:?\s*)?/i,
      ""
    );

    const dateInfo = parseDateReference(working, defaultDate);
    if (dateInfo.raw) working = working.replace(dateInfo.raw, " ");

    const prioInfo = parsePriority(working);
    if (prioInfo.raw) working = working.replace(prioInfo.raw, " ");

    let startTime = "";
    let duration = null;

    const range = parseTimeRange(working);
    if (range) {
      startTime = range.startTime;
      duration = range.duration;
      working = working.replace(range.raw, " ");
    } else {
      const atTime = working.match(/\b(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\b/i);
      if (atTime) {
        const parsed = parseClockTime(atTime[1]);
        if (parsed) {
          startTime = parsed.time;
          working = working.replace(atTime[0], " ");
        }
      } else {
        const bareTime = parseClockTime(working);
        if (bareTime) {
          startTime = bareTime.time;
          working = working.replace(bareTime.raw, " ");
        }
      }
    }

    // Time-of-day hints if no explicit time
    if (!startTime) {
      if (/\b(?:this\s+)?morning\b/i.test(working)) {
        startTime = "09:30";
        working = working.replace(/\b(?:in\s+the\s+|this\s+)?morning\b/i, " ");
      } else if (/\b(?:this\s+)?afternoon\b/i.test(working)) {
        startTime = "14:00";
        working = working.replace(/\b(?:in\s+the\s+|this\s+)?afternoon\b/i, " ");
      } else if (/\b(?:this\s+)?evening\b/i.test(working)) {
        startTime = "17:30";
        working = working.replace(/\b(?:in\s+the\s+|this\s+)?evening\b/i, " ");
      }
    }

    if (duration === null) {
      const durInfo = parseDuration(working);
      if (durInfo) {
        duration = durInfo.duration;
        working = working.replace(durInfo.raw, " ");
      }
    }

    // Clean stray prepositions/punctuation at edges
    working = working
      .replace(/\s+/g, " ")
      .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
      .replace(/\b(?:at|for|on|with)\s*$/i, "")
      .trim();

    if (!working) return null;

    // Capitalize first letter nicely
    const title = working.charAt(0).toUpperCase() + working.slice(1);
    const category = inferCategory(title);
    const priority = prioInfo.priority || inferPriorityFromTitle(title);

    return {
      title,
      date: dateInfo.date,
      startTime,
      duration: duration || (category === "Deep Work" ? 60 : 30),
      priority,
      category,
      notes: ""
    };
  }

  // ---------- Action Executor ----------

  class DailyPlannerAgent {
    constructor(store) {
      this.store = store;
    }

    parseQuickAdd(input, selectedDate) {
      return parseSingleTaskPhrase(input, selectedDate);
    }

    executeActions(actions, selectedDate) {
      if (!Array.isArray(actions) || actions.length === 0) return [];
      const logs = [];
      const mutatingTypes = new Set([
        "add_task",
        "update_task",
        "reschedule_task",
        "complete_task",
        "delete_task",
        "auto_schedule",
        "move_unfinished",
        "clear_completed"
      ]);

      const hasMutation = actions.some((a) => a && mutatingTypes.has(a.type));
      if (hasMutation) {
        this.store.pushUndoSnapshot(`Agent (${actions.length} action${actions.length > 1 ? "s" : ""})`);
      }

      for (const act of actions) {
        if (!act || !act.type) continue;

        if (act.type === "add_task") {
          const created = this.store.addTask(
            {
              title: act.title,
              date: act.date || selectedDate,
              startTime: act.startTime || "",
              duration: act.duration || 30,
              priority: act.priority || "medium",
              category: act.category || inferCategory(act.title || ""),
              notes: act.notes || ""
            },
            { skipCommit: true }
          );
          const timeTag = created.startTime ? ` @ ${created.startTime}` : "";
          logs.push(`+ Added "${created.title}"${timeTag} (${created.duration}m, ${created.priority})`);
        } else if (act.type === "update_task") {
          const target = this.store.findTaskByIdOrTitle(act.taskId || act.matchTitle, selectedDate);
          if (target) {
            const updated = this.store.updateTask(target.id, act, { skipCommit: true });
            logs.push(`✎ Updated "${updated.title}"`);
          }
        } else if (act.type === "reschedule_task") {
          const target = this.store.findTaskByIdOrTitle(act.taskId || act.matchTitle, selectedDate);
          if (target) {
            const patch = {};
            if (act.date) patch.date = act.date;
            if (act.startTime !== undefined && act.startTime !== null && act.startTime !== "") {
              patch.startTime = act.startTime;
            } else if (act.shiftMinutes) {
              const cur = timeToMinutes(target.startTime);
              if (cur !== null) {
                patch.startTime = minutesToTime(cur + Number(act.shiftMinutes));
              }
            }
            const updated = this.store.updateTask(target.id, patch, { skipCommit: true });
            logs.push(
              `↻ Rescheduled "${updated.title}" → ${formatDateHeading(updated.date)} ${
                updated.startTime || "unscheduled"
              }`
            );
          }
        } else if (act.type === "complete_task") {
          const target = this.store.findTaskByIdOrTitle(act.taskId || act.matchTitle, selectedDate);
          if (target) {
            const status = act.done === false ? "pending" : "done";
            const updated = this.store.updateTask(target.id, { status }, { skipCommit: true });
            logs.push(`${status === "done" ? "✓ Completed" : "↺ Reopened"} "${updated.title}"`);
          }
        } else if (act.type === "delete_task") {
          const target = this.store.findTaskByIdOrTitle(act.taskId || act.matchTitle, selectedDate);
          if (target) {
            this.store.deleteTask(target.id, { skipCommit: true });
            logs.push(`✕ Removed "${target.title}"`);
          }
        } else if (act.type === "auto_schedule") {
          const d = act.date || selectedDate;
          const res = this.store.autoSchedule(d, {
            includeScheduled: Boolean(act.includeScheduled),
            strategy: act.strategy || "energy_match",
            skipCommit: true
          });
          if (res.scheduled.length > 0) {
            logs.push(`✦ Auto-scheduled ${res.scheduled.length} task${res.scheduled.length > 1 ? "s" : ""}`);
          }
        } else if (act.type === "move_unfinished") {
          const fromDate = act.fromDate || selectedDate;
          const toDate = act.toDate || addDaysISO(fromDate, 1);
          const pending = this.store.getTasksForDate(fromDate).filter((t) => t.status !== "done");
          for (const t of pending) {
            this.store.updateTask(t.id, { date: toDate }, { skipCommit: true });
          }
          if (pending.length > 0) {
            logs.push(`→ Rolled over ${pending.length} task${pending.length > 1 ? "s" : ""} to ${formatDateHeading(toDate)}`);
          }
        } else if (act.type === "clear_completed") {
          const d = act.date || selectedDate;
          const done = this.store.getTasksForDate(d).filter((t) => t.status === "done");
          for (const t of done) {
            this.store.deleteTask(t.id, { skipCommit: true });
          }
          if (done.length > 0) {
            logs.push(`🧹 Cleared ${done.length} completed task${done.length > 1 ? "s" : ""}`);
          }
        }
      }

      if (hasMutation) {
        this.store.commit();
      }
      return logs;
    }

    // ---------- Main Entrypoint ----------

    async handleUserMessage(userText, selectedDate) {
      const prefs = this.store.getPreferences();
      const apiKey = this.store.getApiKey();

      if (prefs.provider === "gemini") {
        if (!apiKey) {
          throw new Error("Gemini API key is missing. Open Settings (⚙) to enter your key or switch to Offline Agent.");
        }
        return await this._runGemini(userText, selectedDate, prefs, apiKey);
      }

      if (prefs.provider === "openai") {
        const base = (prefs.baseUrl || "").trim();
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(base);
        if (!apiKey && !isLocal) {
          throw new Error("API key is missing. Open Settings (⚙) to enter your key or switch to Offline Agent.");
        }
        return await this._runOpenAICompatible(userText, selectedDate, prefs, apiKey || "local-dev-key");
      }

      return this._runOfflineAgent(userText, selectedDate);
    }

    // ---------- Context Builder for LLMs ----------

    _buildContextText(selectedDate) {
      const prefs = this.store.getPreferences();
      const now = new Date();
      const tasksToday = this.store.getTasksForDate(selectedDate);
      const tomorrow = addDaysISO(selectedDate, 1);
      const tasksTomorrow = this.store.getTasksForDate(tomorrow);
      const conflicts = this.store.detectConflicts(selectedDate);
      const freeSlots = this.store.getFreeSlots(selectedDate, 15).map((s) => ({
        start: minutesToTime(s.start),
        end: minutesToTime(s.end),
        durationMinutes: s.duration
      }));

      return JSON.stringify(
        {
          currentLocalTime: now.toTimeString().slice(0, 5),
          todayDate: getTodayISO(),
          currentlyViewingDate: selectedDate,
          preferences: {
            workStart: prefs.workStart,
            workEnd: prefs.workEnd,
            breakBufferMinutes: prefs.breakBuffer,
            peakEnergy: prefs.peakEnergy,
            customInstructions: prefs.customInstructions
          },
          viewingDateTasks: tasksToday.map((t) => ({
            taskId: t.id,
            title: t.title,
            date: t.date,
            startTime: t.startTime || null,
            duration: t.duration,
            priority: t.priority,
            category: t.category,
            status: t.status,
            notes: t.notes
          })),
          viewingDateConflicts: conflicts.pairs.map(([a, b]) => [a.title, b.title]),
          viewingDateFreeSlots: freeSlots,
          tomorrowTasksCount: tasksTomorrow.length
        },
        null,
        2
      );
    }

    _extractAgentJSON(rawContent) {
      const text = String(rawContent || "").trim();
      if (!text) return { reply: "I didn't receive a response from the model.", actions: [] };

      // Strip markdown code fences if present
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fenced ? fenced[1].trim() : text;

      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") {
          return {
            reply: typeof parsed.reply === "string" ? parsed.reply : text,
            actions: Array.isArray(parsed.actions) ? parsed.actions : []
          };
        }
      } catch {
        // Attempt to extract first top-level JSON object
        const firstBrace = candidate.indexOf("{");
        const lastBrace = candidate.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          try {
            const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
            return {
              reply: typeof parsed.reply === "string" ? parsed.reply : text,
              actions: Array.isArray(parsed.actions) ? parsed.actions : []
            };
          } catch {
            // Fall through to plain text reply
          }
        }
      }
      return { reply: text, actions: [] };
    }

    async _runGemini(userText, selectedDate, prefs, apiKey) {
      const model = (prefs.model || "gemini-2.5-flash").trim();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const recentHistory = this.store.state.messages.slice(-8).map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }]
      }));

      const contextBlock = `LIVE PLANNER CONTEXT:\n${this._buildContextText(selectedDate)}\n\nUSER REQUEST:\n${userText}`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_SCHEMA_PROMPT }]
          },
          contents: [...recentHistory, { role: "user", parts: [{ text: contextBlock }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: "application/json"
          }
        })
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Gemini API error (${res.status}): ${errBody.slice(0, 220) || res.statusText}`);
      }

      const data = await res.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      const parsed = this._extractAgentJSON(rawText);
      const applied = this.executeActions(parsed.actions, selectedDate);
      return { reply: parsed.reply, actions: applied };
    }

    async _runOpenAICompatible(userText, selectedDate, prefs, apiKey) {
      const baseUrl = (prefs.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const model = (prefs.model || "gpt-4o-mini").trim();

      const recentHistory = this.store.state.messages.slice(-8).map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.text
      }));

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          messages: [
            { role: "system", content: SYSTEM_SCHEMA_PROMPT },
            ...recentHistory,
            {
              role: "user",
              content: `LIVE PLANNER CONTEXT:\n${this._buildContextText(selectedDate)}\n\nUSER REQUEST:\n${userText}`
            }
          ]
        })
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`API error (${res.status}): ${errBody.slice(0, 220) || res.statusText}`);
      }

      const data = await res.json();
      const rawText = data?.choices?.[0]?.message?.content || "";
      const parsed = this._extractAgentJSON(rawText);
      const applied = this.executeActions(parsed.actions, selectedDate);
      return { reply: parsed.reply, actions: applied };
    }

    // ---------- Built-in Offline Natural-Language Agent ----------

    _runOfflineAgent(userText, selectedDate) {
      const input = userText.trim();
      const lower = input.toLowerCase();

      // 1. Help / Capabilities
      if (/^(?:help|\?|what can you do|commands)\b/i.test(lower)) {
        return {
          reply:
            "Here's what I can help you with right now (even completely offline):\n" +
            "• Add tasks: \"Add prepare slides for 45m at 2pm high priority\"\n" +
            "• Add multiple tasks: \"Add call Alex at 11am, write report for 1h high priority\"\n" +
            "• Auto-plan: \"Plan my day\" or \"Optimize my schedule\"\n" +
            "• Prioritize: \"Prioritize my tasks\" or \"Make team sync high priority\"\n" +
            "• Reschedule: \"Move team sync to 4pm\" or \"Push draft project plan back 30m\"\n" +
            "• Complete / Delete: \"Mark inbox done\" or \"Delete wrap-up notes\"\n" +
            "• Rollover: \"Move unfinished tasks to tomorrow\"\n" +
            "• Briefing: \"Summarize my day\", \"What's next?\", or \"Find a 1 hour free slot\"",
          actions: []
        };
      }

      // 2. Rollover unfinished tasks
      if (/\b(rollover|roll\s*over|move\s+(?:all\s+)?(?:unfinished|pending|incomplete|remaining)\s+tasks?)\b/i.test(lower)) {
        const destInfo = parseDateReference(input, addDaysISO(selectedDate, 1));
        const toDate = destInfo.date === selectedDate ? addDaysISO(selectedDate, 1) : destInfo.date;
        const pending = this.store.getTasksForDate(selectedDate).filter((t) => t.status !== "done");
        if (pending.length === 0) {
          return { reply: `You have no unfinished tasks on ${formatDateHeading(selectedDate)} to roll over!`, actions: [] };
        }
        const applied = this.executeActions(
          [{ type: "move_unfinished", fromDate: selectedDate, toDate }],
          selectedDate
        );
        return {
          reply: `Moved ${pending.length} unfinished task${pending.length > 1 ? "s" : ""} from ${formatDateHeading(
            selectedDate
          )} to ${formatDateHeading(toDate)}. You're all wrapped up here!`,
          actions: applied
        };
      }

      // 3. Clear completed tasks
      if (/\b(clear|remove|delete|clean\s*up)\s+(?:all\s+)?(?:completed|done|finished)\b/i.test(lower)) {
        const done = this.store.getTasksForDate(selectedDate).filter((t) => t.status === "done");
        if (done.length === 0) {
          return { reply: "There are no completed tasks to clear for this day.", actions: [] };
        }
        const applied = this.executeActions([{ type: "clear_completed", date: selectedDate }], selectedDate);
        return {
          reply: `Cleared ${done.length} completed task${done.length > 1 ? "s" : ""} to keep your board clean.`,
          actions: applied
        };
      }

      // 4. Plan / Auto-schedule / Optimize / Fix conflicts
      if (
        /\b(plan\s+my\s+day|auto[\s-]*schedule|schedule\s+(?:my|all|unscheduled)|optimize\s+(?:my\s+)?(?:day|schedule)|fix\s+conflicts?|reorganize\s+(?:my\s+)?day)\b/i.test(
          lower
        )
      ) {
        const includeScheduled = /\b(reorganize|re[\s-]*schedule\s+everything|fix\s+conflicts?|rebuild|from\s+scratch)\b/i.test(
          lower
        );
        const strategy = /\bquick\s*wins?\b/i.test(lower) ? "quick_wins" : "energy_match";
        const dayPending = this.store.getTasksForDate(selectedDate).filter((t) => t.status !== "done");

        if (dayPending.length === 0) {
          return {
            reply: `No pending tasks found for ${formatDateHeading(selectedDate)}. Tell me what you'd like to accomplish and I'll schedule it!`,
            actions: []
          };
        }

        const unscheduledCount = dayPending.filter((t) => timeToMinutes(t.startTime) === null).length;
        const conflictsBefore = this.store.detectConflicts(selectedDate).pairs.length;
        const shouldRescheduleAll = includeScheduled || (unscheduledCount === 0 && conflictsBefore > 0);

        const applied = this.executeActions(
          [{ type: "auto_schedule", date: selectedDate, includeScheduled: shouldRescheduleAll, strategy }],
          selectedDate
        );

        const updatedTasks = this.store.getTasksForDate(selectedDate).filter((t) => t.status !== "done");
        const prefs = this.store.getPreferences();
        const lines = updatedTasks.map(
          (t) =>
            `• ${t.startTime ? formatTimeRange(t.startTime, t.duration) : "Unscheduled"} — ${t.title} [${t.priority}]`
        );

        const header =
          applied.length > 0
            ? `Here is your optimized plan for ${formatDateHeading(selectedDate)} (aligned to your ${prefs.peakEnergy} peak focus window with ${prefs.breakBuffer}m buffers):`
            : `All ${updatedTasks.length} pending tasks for ${formatDateHeading(selectedDate)} are already scheduled without overlaps:`;

        return {
          reply: `${header}\n\n${lines.join("\n")}`,
          actions: applied
        };
      }

      // 5. Prioritize tasks (single task or whole day)
      const singlePrioMatch = input.match(
        /\b(?:make|set|mark|change)\s+["']?(.+?)["']?\s+(?:to\s+|as\s+)?(high|medium|low)(?:\s+priority)?\b/i
      );
      if (singlePrioMatch) {
        const targetTitle = singlePrioMatch[1].trim();
        const newPrio = singlePrioMatch[2].toLowerCase();
        const found = this.store.findTaskByIdOrTitle(targetTitle, selectedDate);
        if (!found) {
          return {
            reply: `I couldn't find a task matching "${targetTitle}". Try referencing a keyword from its title.`,
            actions: []
          };
        }
        const applied = this.executeActions(
          [{ type: "update_task", taskId: found.id, priority: newPrio }],
          selectedDate
        );
        return {
          reply: `Updated "${found.title}" to ${newPrio} priority.`,
          actions: applied
        };
      }

      if (/\b(prioritize|reprioritize|rank|what\s+should\s+i\s+(?:focus|do)\s+first|order\s+my\s+tasks)\b/i.test(lower)) {
        const pending = this.store.getTasksForDate(selectedDate).filter((t) => t.status !== "done");
        if (pending.length === 0) {
          return { reply: "All tasks for this day are already completed! 🎉", actions: [] };
        }
        // Smartly boost deep work / deadline tasks if everything is uniform
        const actions = [];
        for (const t of pending) {
          const inferred = inferPriorityFromTitle(t.title);
          if (t.category === "Deep Work" && t.priority === "medium" && pending.every((x) => x.priority !== "high")) {
            actions.push({ type: "update_task", taskId: t.id, priority: "high" });
          } else if (inferred === "high" && t.priority !== "high") {
            actions.push({ type: "update_task", taskId: t.id, priority: "high" });
          }
        }
        const applied = this.executeActions(actions, selectedDate);
        const ranked = this.store
          .getTasksForDate(selectedDate)
          .filter((t) => t.status !== "done")
          .sort((a, b) => {
            const pr = priorityRank(b.priority) - priorityRank(a.priority);
            if (pr !== 0) return pr;
            const ta = timeToMinutes(a.startTime) ?? 9999;
            const tb = timeToMinutes(b.startTime) ?? 9999;
            return ta - tb;
          });

        const list = ranked
          .map(
            (t, idx) =>
              `${idx + 1}. ${t.title} (${t.priority.toUpperCase()}, ${formatDuration(t.duration)}${
                t.startTime ? `, @ ${t.startTime}` : ""
              })`
          )
          .join("\n");

        return {
          reply:
            `Here's your recommended priority order for ${formatDateHeading(selectedDate)}:\n\n${list}\n\n` +
            `Start with #1 ("${ranked[0].title}") while your energy is highest.`,
          actions: applied
        };
      }

      // 6. Complete / Reopen a task
      const completeMatch = input.match(
        /^(?:please\s+)?(?:mark|set|check\s+off|complete|finish|done\s+with)\s+["']?(.+?)["']?(?:\s+as\s+(?:done|complete|completed|finished)|\s+done)?$/i
      );
      if (completeMatch && !/\b(clear|delete|remove)\b/i.test(lower)) {
        const needle = completeMatch[1].replace(/\s+(?:as\s+)?(?:done|completed?|finished)$/i, "").trim();
        const found = this.store.findTaskByIdOrTitle(needle, selectedDate);
        if (found) {
          const applied = this.executeActions([{ type: "complete_task", taskId: found.id, done: true }], selectedDate);
          return { reply: `Nice work! Marked "${found.title}" as completed.`, actions: applied };
        }
      }

      // 7. Delete / Remove a task
      const deleteMatch = input.match(/^(?:please\s+)?(?:delete|remove|cancel|drop)\s+(?:task\s+)?["']?(.+?)["']?$/i);
      if (deleteMatch) {
        const needle = deleteMatch[1].trim();
        const found = this.store.findTaskByIdOrTitle(needle, selectedDate);
        if (found) {
          const applied = this.executeActions([{ type: "delete_task", taskId: found.id }], selectedDate);
          return { reply: `Removed "${found.title}" from your schedule.`, actions: applied };
        }
        return { reply: `I couldn't find a task matching "${needle}" to delete.`, actions: [] };
      }

      // 8. Reschedule / Move / Push / Delay
      if (/^(?:please\s+)?(?:move|reschedule|shift|push|delay|bump|postpone)\b/i.test(lower)) {
        // Shift by duration: "push X back 30m" / "delay X by 1 hour"
        const shiftMatch = input.match(
          /^(?:please\s+)?(?:move|reschedule|shift|push|delay|bump|postpone)\s+["']?(.+?)["']?\s+(?:back|forward|later|earlier|by)\s+(.+)$/i
        );
        if (shiftMatch) {
          const rawTarget = shiftMatch[1].trim();
          const durInfo = parseDuration(shiftMatch[2]);
          const isEarlier = /\b(?:earlier|forward|up)\b/i.test(input) && !/\bback\b/i.test(input);
          if (durInfo) {
            const delta = isEarlier ? -durInfo.duration : durInfo.duration;
            // Bulk shift (e.g. "push all afternoon tasks back 30m")
            if (/\b(?:all|afternoon|morning|remaining)\s+tasks?\b/i.test(rawTarget)) {
              const pending = this.store.getTasksForDate(selectedDate).filter((t) => {
                if (t.status === "done" || timeToMinutes(t.startTime) === null) return false;
                const m = timeToMinutes(t.startTime);
                if (/afternoon/i.test(rawTarget)) return m >= 12 * 60;
                if (/morning/i.test(rawTarget)) return m < 12 * 60;
                return true;
              });
              if (pending.length === 0) {
                return { reply: "No matching scheduled tasks found to shift.", actions: [] };
              }
              const acts = pending.map((t) => ({ type: "reschedule_task", taskId: t.id, shiftMinutes: delta }));
              const applied = this.executeActions(acts, selectedDate);
              return {
                reply: `Shifted ${pending.length} task${pending.length > 1 ? "s" : ""} ${
                  delta > 0 ? "later" : "earlier"
                } by ${formatDuration(Math.abs(delta))}.`,
                actions: applied
              };
            }

            const found = this.store.findTaskByIdOrTitle(rawTarget, selectedDate);
            if (found) {
              const applied = this.executeActions(
                [{ type: "reschedule_task", taskId: found.id, shiftMinutes: delta }],
                selectedDate
              );
              const updated = this.store.findTaskByIdOrTitle(found.id);
              return {
                reply: `Shifted "${found.title}" by ${formatDuration(Math.abs(delta))} → now at ${
                  updated.startTime || "unscheduled"
                }.`,
                actions: applied
              };
            }
          }
        }

        // Move to explicit time or date: "move team sync to 4pm" / "reschedule X to tomorrow at 10am"
        const moveToMatch = input.match(
          /^(?:please\s+)?(?:move|reschedule|shift|push|postpone)\s+["']?(.+?)["']?\s+(?:to|at)\s+(.+)$/i
        );
        if (moveToMatch) {
          const targetStr = moveToMatch[1].trim();
          const destStr = moveToMatch[2].trim();
          const found = this.store.findTaskByIdOrTitle(targetStr, selectedDate);
          if (!found) {
            return {
              reply: `I couldn't find a task matching "${targetStr}". Could you use a word from the task title?`,
              actions: []
            };
          }
          const dateInfo = parseDateReference(destStr, found.date);
          const timeInfo = parseClockTime(destStr);
          if (!timeInfo && dateInfo.date === found.date) {
            return {
              reply: `Tell me the new time or date for "${found.title}" (for example: "Move ${found.title} to 3:30pm" or "tomorrow at 10am").`,
              actions: []
            };
          }
          const patch = { type: "reschedule_task", taskId: found.id, date: dateInfo.date };
          if (timeInfo) patch.startTime = timeInfo.time;
          const applied = this.executeActions([patch], selectedDate);
          const updated = this.store.findTaskByIdOrTitle(found.id);
          return {
            reply: `Moved "${updated.title}" to ${formatDateHeading(updated.date)}${
              updated.startTime ? ` at ${updated.startTime}` : ""
            }.`,
            actions: applied
          };
        }
      }

      // 9. Free slots / Availability query
      if (/\b(free\s*(?:time|slots?|window)|available|availability|open\s*slots?|when\s+can\s+i\s+fit)\b/i.test(lower)) {
        const durInfo = parseDuration(input);
        const minDur = durInfo ? durInfo.duration : 20;
        const slots = this.store.getFreeSlots(selectedDate, minDur);
        if (slots.length === 0) {
          return {
            reply: `Your workday on ${formatDateHeading(selectedDate)} doesn't have an open block of ${formatDuration(
              minDur
            )} or more. Want me to reorganize or roll over low-priority tasks?`,
            actions: []
          };
        }
        const list = slots
          .map((s) => `• ${minutesToTime(s.start)} – ${minutesToTime(s.end)} (${formatDuration(s.duration)})`)
          .join("\n");
        return {
          reply: `Available slots (${formatDuration(minDur)}+) on ${formatDateHeading(selectedDate)}:\n\n${list}`,
          actions: []
        };
      }

      // 10. Summary / Briefing / What's next / Conflicts
      if (
        /\b(summar|briefing|overview|what'?s\s+(?:next|left|on\s+my\s+(?:plate|schedule))|how\s+does\s+my\s+day\s+look|conflicts?|overlaps?|status)\b/i.test(
          lower
        )
      ) {
        return { reply: this._buildDailyBriefing(selectedDate), actions: [] };
      }

      // 11. Add one or more tasks (explicit "add ..." or natural list / task sentence)
      const segments = input
        .split(/\n+|;\s*|\s+and\s+(?=(?:add|schedule|create|book|call|write|review|meet|finish|prepare|send|gym|workout)\b)/i)
        .map((s) => s.trim())
        .filter(Boolean);

      const taskActions = [];
      for (const seg of segments) {
        const parsed = parseSingleTaskPhrase(seg, selectedDate);
        if (parsed && parsed.title.length >= 2) {
          taskActions.push({ type: "add_task", ...parsed });
        }
      }

      if (taskActions.length > 0) {
        const applied = this.executeActions(taskActions, selectedDate);
        const conflicts = this.store.detectConflicts(selectedDate);
        let reply =
          taskActions.length === 1
            ? `Added "${taskActions[0].title}" for ${formatDateHeading(taskActions[0].date)}${
                taskActions[0].startTime ? ` at ${taskActions[0].startTime}` : " (unscheduled)"
              } (${formatDuration(taskActions[0].duration)}, ${taskActions[0].priority} priority).`
            : `Added ${taskActions.length} tasks to your planner:\n` +
              taskActions
                .map(
                  (t) =>
                    `• ${t.title} (${formatDateHeading(t.date)}${t.startTime ? ` @ ${t.startTime}` : ""}, ${formatDuration(
                      t.duration
                    )}, ${t.priority})`
                )
                .join("\n");

        if (conflicts.pairs.length > 0) {
          reply += `\n\n⚠ Heads up: there ${conflicts.pairs.length === 1 ? "is" : "are"} ${
            conflicts.pairs.length
          } overlapping time slot${conflicts.pairs.length > 1 ? "s" : ""}. Say "Fix conflicts" if you'd like me to resolve them.`;
        } else if (taskActions.some((t) => !t.startTime)) {
          reply += `\n\nSay "Plan my day" whenever you'd like me to slot unscheduled tasks automatically.`;
        }

        return { reply, actions: applied };
      }

      return {
        reply:
          "I wasn't sure what action to take on that. Try asking me to add a task, reschedule one, prioritize your list, or say \"Plan my day\" (or type \"help\" for examples).",
        actions: []
      };
    }

    _buildDailyBriefing(selectedDate) {
      const tasks = this.store.getTasksForDate(selectedDate);
      const pending = tasks.filter((t) => t.status !== "done");
      const done = tasks.filter((t) => t.status === "done");
      const totalMin = pending.reduce((sum, t) => sum + (t.duration || 30), 0);
      const high = pending.filter((t) => t.priority === "high");
      const unscheduled = pending.filter((t) => timeToMinutes(t.startTime) === null);
      const conflicts = this.store.detectConflicts(selectedDate);
      const free = this.store.getFreeSlots(selectedDate, 30);

      if (tasks.length === 0) {
        return `Your schedule for ${formatDateHeading(selectedDate)} is completely open! Tell me what you want to work on and I'll build a plan.`;
      }

      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const isToday = selectedDate === getTodayISO();
      const upcoming = pending.find((t) => {
        const s = timeToMinutes(t.startTime);
        return s !== null && (!isToday || s + (t.duration || 30) >= nowMin);
      });

      const lines = [
        `📋 Briefing for ${formatDateHeading(selectedDate)}:`,
        `• Progress: ${done.length}/${tasks.length} completed (${pending.length} pending, ${formatDuration(totalMin)} left)`,
        `• High priority remaining: ${high.length}${high.length ? ` (${high.map((t) => t.title).join(", ")})` : ""}`
      ];

      if (upcoming) {
        lines.push(`• Up next: "${upcoming.title}" (${formatTimeRange(upcoming.startTime, upcoming.duration)})`);
      }
      if (unscheduled.length > 0) {
        lines.push(`• Unscheduled tasks: ${unscheduled.length} — say "Plan my day" to auto-slot them.`);
      }
      if (conflicts.pairs.length > 0) {
        lines.push(
          `• ⚠ Schedule conflicts: ${conflicts.pairs.map(([a, b]) => `"${a.title}" overlaps "${b.title}"`).join("; ")}`
        );
      } else {
        lines.push(`• Conflicts: None detected.`);
      }
      if (free.length > 0) {
        lines.push(
          `• Open focus windows (30m+): ${free
            .slice(0, 3)
            .map((s) => `${minutesToTime(s.start)}–${minutesToTime(s.end)}`)
            .join(", ")}`
        );
      }
      return lines.join("\n");
    }
  }

  global.DailyPlannerAgent = DailyPlannerAgent;
})(window);
