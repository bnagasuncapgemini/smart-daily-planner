# Smart Daily Planner — Aura AI Agent

A standalone, zero-dependency Daily Planner web application powered by a tool-using conversational AI agent (**Aura**). Works **100% offline** out of the box and optionally connects to **Google Gemini** or any **OpenAI-compatible** API (Bring Your Own Key).

## Features

- **Conversational AI Daily Planner Agent**: Add one or multiple tasks in plain English with times, time ranges, durations, priorities, dates, and auto-inferred categories.
- **Auto-Scheduling & Conflict Detection**: Automatically places unscheduled tasks into conflict-free blocks aligned to your workday hours, break buffer, and peak focus energy window.
- **Smart Reprioritization & Rescheduling**: Move tasks to specific times/dates, shift tasks earlier/later, or roll over unfinished tasks to tomorrow.
- **One-Click Undo**: Every batch of AI agent changes creates a reversible snapshot.
- **Dual Views**: Switch seamlessly between a grouped **Tasks** list and an hourly **Timeline** view, with light & dark mode support.
- **Persistence & Export**: Saves automatically to browser `localStorage` (plus optional disk sync via `server.ps1`), and exports schedules to **`.ics`** calendar files or **`.json`** backups.

## Quick Start (Windows PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\server.ps1
```

Then open **http://localhost:8085/** in your browser.

> You can also open `index.html` directly in any modern browser — the Offline AI Agent and browser `localStorage` work with zero setup. Running `server.ps1` adds disk persistence (`data/planner-state.json`) and a local BYOK mock endpoint (`/v1/chat/completions`).

## Example Agent Prompts

- `"Add write quarterly report for 90m at 10am high priority"`
- `"Add call Alex at 11:30am for 30m, and gym workout at 6pm for 1h"`
- `"Plan my day"`
- `"Prioritize my tasks"`
- `"Move team sync to 3:30pm"`
- `"Push draft project plan back 30m"`
- `"Find a 1 hour free slot"`
- `"Summarize my day"`
- `"Move unfinished tasks to tomorrow"`

## Using a Live LLM (Optional BYOK)

Click **Offline Agent** (or the `⚙` icon) in the top bar:
1. Select **Google Gemini API (BYOK)** (e.g., `gemini-2.5-flash`) or **OpenAI-Compatible API** (OpenAI, Groq, Ollama, or `http://localhost:8085/v1` for the local mock endpoint).
2. Enter your API key (stored strictly in local browser storage, never committed to code).
3. Configure workday hours, break buffer, peak focus window, and custom scheduling instructions.

## Project Structure

| File | Description |
| --- | --- |
| `index.html` | Semantic split-workspace UI with Tasks/Timeline views, chat pane, and native `<dialog>` modals |
| `styles.css` | Responsive light/dark theme styling with CSS custom properties |
| `planner-store.js` | State management, conflict detection, free-slot finder, auto-scheduler, undo stack, `.ics`/`.json` export |
| `agent-engine.js` | Unified tool-calling agent executor + Offline NLP agent + Gemini & OpenAI-compatible BYOK clients |
| `app.js` | UI controller, safe DOM rendering, modal workflows, and keyboard shortcuts |
| `server.ps1` | Zero-dependency PowerShell static server + `/api/state` disk sync + local `/v1/chat/completions` mock |
