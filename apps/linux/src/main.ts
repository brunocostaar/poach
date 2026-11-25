import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { handoffPrompt, implementationContext, type Note } from "./prompt";

interface Keyframe {
  readonly kind: string;
  readonly timeMs: number;
  readonly imagePath: string;
}

/** Subset of @poach/core's InspectionResult the UI reads; the rest is passed through. */
interface Inspection {
  readonly mediaType: "video" | "image";
  readonly sourcePath: string;
  readonly keyframes: readonly Keyframe[];
  readonly palette: readonly string[];
  readonly timing: { readonly token: string };
  readonly [key: string]: unknown;
}

interface Recording {
  readonly path: string;
  readonly durationMs: number;
}

const STAGE_LABELS: Record<string, string> = {
  motion: "Measuring motion…",
  frames: "Extracting keyframes…",
  palette: "Sampling colors…",
};

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

const ui = {
  connector: element<HTMLParagraphElement>("connector"),
  captureActions: element<HTMLDivElement>("capture-actions"),
  recording: element<HTMLDivElement>("recording"),
  elapsed: element<HTMLSpanElement>("elapsed"),
  stop: element<HTMLButtonElement>("stop"),
  screenshot: element<HTMLButtonElement>("screenshot"),
  import: element<HTMLButtonElement>("import"),
  status: element<HTMLParagraphElement>("status"),
  editor: element<HTMLElement>("editor"),
  media: element<HTMLDivElement>("media"),
  notesArea: element<HTMLDivElement>("notes-area"),
  noteForm: element<HTMLFormElement>("note-form"),
  noteText: element<HTMLInputElement>("note-text"),
  notes: element<HTMLOListElement>("notes"),
  palette: element<HTMLUListElement>("palette"),
  timing: element<HTMLParagraphElement>("timing"),
  keyframes: element<HTMLUListElement>("keyframes"),
  context: element<HTMLTextAreaElement>("context"),
  handoffStatus: element<HTMLParagraphElement>("handoff-status"),
};

let inspection: Inspection | null = null;
let notes: Note[] = [];
let video: HTMLVideoElement | null = null;
let recordingTimer: number | undefined;
let connected = false;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function setBusy(busy: boolean): void {
  for (const button of ui.captureActions.querySelectorAll("button")) button.disabled = busy;
}

// --- Connector status -------------------------------------------------------

async function refreshConnector(): Promise<void> {
  connected = await invoke<boolean>("connector_connected").catch(() => false);
  ui.connector.textContent = connected ? "Connector active" : "No assistant connected";
  ui.connector.classList.toggle("on", connected);
  ui.connector.title = connected ? "" : "Add the Poach MCP server to Claude Code or Codex and open a session.";
}

// --- Capture ----------------------------------------------------------------

async function startRecording(source: "monitor" | "window"): Promise<void> {
  setBusy(true);
  ui.status.textContent = "Choose what to share in the system dialog.";
  try {
    const { maxSeconds } = await invoke<{ maxSeconds: number }>("start_recording", { source });
    const started = performance.now();
    ui.captureActions.hidden = true;
    ui.recording.hidden = false;
    ui.status.textContent = `Recording. Stops automatically after ${maxSeconds} seconds.`;
    ui.stop.focus();
    recordingTimer = window.setInterval(() => {
      const seconds = (performance.now() - started) / 1000;
      ui.elapsed.textContent = `${seconds.toFixed(1)} s`;
      if (seconds >= maxSeconds) void stopRecording();
    }, 100);
  } catch (error) {
    ui.status.textContent = errorText(error);
    setBusy(false);
  }
}

async function stopRecording(): Promise<void> {
  if (recordingTimer === undefined) return;
  window.clearInterval(recordingTimer);
  recordingTimer = undefined;
  ui.stop.disabled = true;
  ui.status.textContent = "Saving recording…";
  try {
    const recording = await invoke<Recording>("stop_recording");
    await analyze(recording.path, true);
  } catch (error) {
    ui.status.textContent = errorText(error);
  } finally {
    ui.recording.hidden = true;
    ui.captureActions.hidden = false;
    ui.stop.disabled = false;
    setBusy(false);
  }
}

async function takeScreenshot(): Promise<void> {
  setBusy(true);
  ui.status.textContent = "Choose what to capture in the system dialog.";
  try {
    await analyze(await invoke<string>("take_screenshot"), false);
  } catch (error) {
    ui.status.textContent = errorText(error);
  } finally {
    setBusy(false);
  }
}

async function importFile(): Promise<void> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images and videos", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "mp4", "mov"] }],
  });
  if (typeof path !== "string") return;
  setBusy(true);
  try {
    await analyze(path, false);
  } catch (error) {
    ui.status.textContent = errorText(error);
  } finally {
    setBusy(false);
  }
}

async function analyze(path: string, isRecording: boolean): Promise<void> {
  ui.status.textContent = "Analyzing…";
  inspection = await invoke<Inspection>("inspect", { path, isRecording });
  notes = [];
  ui.status.textContent = "";
  ui.handoffStatus.textContent = "";
  renderEditor();
}

// --- Editor -----------------------------------------------------------------

function renderEditor(): void {
  if (!inspection) return;
  const isVideo = inspection.mediaType === "video";
  ui.editor.hidden = false;
  ui.media.replaceChildren();
  video = null;
  if (isVideo) {
    video = document.createElement("video");
    video.src = convertFileSrc(inspection.sourcePath);
    video.controls = true;
    video.preload = "auto";
    video.setAttribute("aria-label", "Captured recording");
    ui.media.append(video);
  } else {
    const image = document.createElement("img");
    image.src = convertFileSrc(inspection.sourcePath);
    image.alt = "Captured screenshot";
    ui.media.append(image);
  }
  ui.notesArea.hidden = !isVideo;

  ui.palette.replaceChildren(
    ...inspection.palette.map((hex) => {
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = hex;
      swatch.setAttribute("aria-hidden", "true");
      item.append(swatch, hex);
      return item;
    }),
  );
  ui.timing.textContent = inspection.timing.token;
  ui.keyframes.replaceChildren(
    ...inspection.keyframes.map((frame) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "keyframe";
      button.disabled = !isVideo;
      button.addEventListener("click", () => seek(frame.timeMs));
      const image = document.createElement("img");
      image.src = convertFileSrc(frame.imagePath);
      image.alt = "";
      const caption = document.createElement("span");
      caption.textContent = `${frame.kind} · ${(frame.timeMs / 1000).toFixed(2)} s`;
      button.append(image, caption);
      button.setAttribute("aria-label", `Go to ${caption.textContent}`);
      item.append(button);
      return item;
    }),
  );
  renderNotes();
  ui.editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function seek(timeMs: number): void {
  if (!video) return;
  video.pause();
  video.currentTime = timeMs / 1000;
}

function renderNotes(): void {
  ui.notes.replaceChildren(
    ...notes.map((note, index) => {
      const item = document.createElement("li");
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "link";
      jump.textContent = `${(note.timeMs / 1000).toFixed(2)} s`;
      jump.setAttribute("aria-label", `Go to ${jump.textContent}`);
      jump.addEventListener("click", () => seek(note.timeMs));
      const text = document.createElement("span");
      text.textContent = note.text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove note at ${jump.textContent}`);
      remove.addEventListener("click", () => {
        notes.splice(index, 1);
        renderNotes();
      });
      item.append(jump, text, remove);
      return item;
    }),
  );
}

function addNote(event: SubmitEvent): void {
  event.preventDefault();
  const text = ui.noteText.value.trim();
  if (!video || !text) return;
  video.pause();
  notes.push({ timeMs: Math.round(video.currentTime * 1000), text });
  notes.sort((first, second) => first.timeMs - second.timeMs);
  ui.noteText.value = "";
  renderNotes();
}

async function handoff(assistant: "claude" | "codex"): Promise<void> {
  if (!inspection) return;
  await refreshConnector();
  if (!connected) {
    ui.handoffStatus.textContent = "Open a Claude Code or Codex session with the Poach MCP server first.";
    return;
  }
  try {
    const context = implementationContext(ui.context.value, notes);
    const briefId = await invoke<string>("share_handoff", { inspection, context, annotations: notes });
    await writeText(handoffPrompt(briefId, inspection.mediaType === "video"));
    const name = assistant === "claude" ? "Claude Code" : "Codex";
    ui.handoffStatus.textContent = `Prompt copied. Paste it into ${name}.`;
  } catch (error) {
    ui.handoffStatus.textContent = errorText(error);
  }
}

// --- Wiring -----------------------------------------------------------------

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-record]")) {
  button.addEventListener("click", () => void startRecording(button.dataset.record === "window" ? "window" : "monitor"));
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-assistant]")) {
  button.addEventListener("click", () => void handoff(button.dataset.assistant === "codex" ? "codex" : "claude"));
}
ui.stop.addEventListener("click", () => void stopRecording());
ui.screenshot.addEventListener("click", () => void takeScreenshot());
ui.import.addEventListener("click", () => void importFile());
ui.noteForm.addEventListener("submit", addNote);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && recordingTimer !== undefined) void stopRecording();
});

void listen<string>("inspect-progress", (event) => {
  ui.status.textContent = STAGE_LABELS[event.payload] ?? "Analyzing…";
});
void refreshConnector();
window.setInterval(() => void refreshConnector(), 5000);
