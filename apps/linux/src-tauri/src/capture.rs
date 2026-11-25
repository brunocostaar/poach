//! Screen capture through xdg-desktop-portal.
//!
//! Wayland does not let applications read the screen directly. The ScreenCast
//! portal asks the user what to share and hands back a PipeWire stream, which a
//! `gst-launch-1.0` child encodes to H.264 MP4 (openh264 ships with Fedora, so
//! no extra repositories are needed). The Screenshot portal returns a file.

use std::{
    io::Read,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    screenshot::Screenshot,
    PersistMode, ResponseError, Session,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use crate::paths;

/// Native recordings are capped like the macOS client.
pub const MAX_RECORDING_SECONDS: u64 = 30;
/// File descriptor number the PipeWire remote gets inside the encoder process.
const CHILD_PIPEWIRE_FD: i32 = 3;

#[derive(Default)]
pub struct Recorder(Mutex<Option<ActiveRecording>>);

pub struct ActiveRecording {
    encoder: Child,
    output: PathBuf,
    started: Instant,
    size: Option<(i32, i32)>,
    session: Session<Screencast>,
    // The PipeWire remote must outlive the encoder.
    _remote: OwnedFd,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum CaptureSource {
    Monitor,
    Window,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStarted {
    max_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    path: PathBuf,
    duration_ms: u128,
    width: Option<i32>,
    height: Option<i32>,
}

fn portal_error(error: ashpd::Error) -> String {
    match error {
        ashpd::Error::Response(ResponseError::Cancelled) => "Capture was cancelled.".into(),
        other => format!("The desktop portal refused the request: {other}"),
    }
}

#[tauri::command]
pub async fn start_recording(
    source: CaptureSource,
    recorder: State<'_, Recorder>,
) -> Result<RecordingStarted, String> {
    let mut slot = recorder.0.lock().await;
    if slot.is_some() {
        return Err("A recording is already in progress.".into());
    }

    let proxy = Screencast::new().await.map_err(portal_error)?;
    // TODO(pointer-trace): request CursorMode::METADATA and read cursor
    // positions from the PipeWire stream metadata instead of embedding them.
    let cursor = match proxy.available_cursor_modes().await {
        Ok(modes) if modes.contains(CursorMode::EMBEDDED) => CursorMode::EMBEDDED,
        _ => CursorMode::HIDDEN,
    };
    let sources = match source {
        CaptureSource::Monitor => SourceType::MONITOR,
        CaptureSource::Window => SourceType::WINDOW,
    };
    let session = proxy.create_session(Default::default()).await.map_err(portal_error)?;
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(cursor)
                .set_sources(sources)
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await
        .map_err(portal_error)?
        .response()
        .map_err(portal_error)?;
    let streams = proxy
        .start(&session, None, Default::default())
        .await
        .map_err(portal_error)?
        .response()
        .map_err(portal_error)?;
    let stream = streams.streams().first().ok_or("Nothing was selected for sharing.")?;
    let target = match stream.pipewire_serial() {
        Some(serial) => format!("target-object={serial}"),
        None => format!("path={}", stream.pipe_wire_node_id()),
    };
    let size = stream.size();
    let remote = proxy
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(portal_error)?;

    let output = paths::private_dir("captures")?.join(format!("recording-{}.mp4", uuid::Uuid::new_v4()));
    let mut encoder = spawn_encoder(&remote, &target, &output)?;

    // A missing GStreamer plugin makes the encoder exit right away.
    tokio::time::sleep(Duration::from_millis(400)).await;
    if let Ok(Some(status)) = encoder.try_wait() {
        let _ = session.close().await;
        return Err(format!("The recorder stopped immediately ({status}). {}", read_stderr(&mut encoder)));
    }

    *slot = Some(ActiveRecording { encoder, output, started: Instant::now(), size, session, _remote: remote });
    Ok(RecordingStarted { max_seconds: MAX_RECORDING_SECONDS })
}

fn spawn_encoder(remote: &OwnedFd, target: &str, output: &Path) -> Result<Child, String> {
    let pipeline = format!(
        "pipewiresrc fd={CHILD_PIPEWIRE_FD} {target} do-timestamp=true keepalive-time=1000 always-copy=true \
         ! videorate ! video/x-raw,framerate=30/1 \
         ! videoconvert ! video/x-raw,format=I420 \
         ! openh264enc usage-type=screen rate-control=bitrate bitrate=12000000 \
         ! h264parse ! mp4mux ! filesink location=\"{}\"",
        output.display()
    );
    let raw = remote.as_raw_fd();
    let mut command = Command::new("gst-launch-1.0");
    command
        .arg("-q")
        .arg("-e") // Turn SIGINT into end-of-stream so mp4mux writes its index.
        .args(pipeline.split_whitespace())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe libc calls run between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if raw == CHILD_PIPEWIRE_FD {
                let flags = libc::fcntl(raw, libc::F_GETFD);
                if flags < 0 || libc::fcntl(raw, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(raw, CHILD_PIPEWIRE_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start gst-launch-1.0 ({error}). Install GStreamer and its PipeWire plugin."))
}

fn read_stderr(child: &mut Child) -> String {
    let mut text = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_string(&mut text);
    }
    text.trim().to_string()
}

#[tauri::command]
pub async fn stop_recording(recorder: State<'_, Recorder>) -> Result<Recording, String> {
    let active = recorder.0.lock().await.take().ok_or("No recording is in progress.")?;
    let ActiveRecording { mut encoder, output, started, size, session, _remote } = active;
    let duration_ms = started.elapsed().as_millis();

    // SAFETY: plain signal to our own child process.
    unsafe { libc::kill(encoder.id() as libc::pid_t, libc::SIGINT) };
    let (status, stderr) = tokio::task::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            match encoder.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = encoder.kill();
                    let _ = encoder.wait();
                    break None;
                }
            }
        };
        (status, read_stderr(&mut encoder))
    })
    .await
    .map_err(|error| format!("The recorder could not be stopped: {error}"))?;
    let _ = session.close().await;
    drop(_remote);

    match status {
        Some(status) if status.success() && output.is_file() => Ok(Recording {
            path: output,
            duration_ms,
            width: size.map(|(width, _)| width),
            height: size.map(|(_, height)| height),
        }),
        Some(status) => Err(format!("The recording could not be saved ({status}). {stderr}")),
        None => Err("The recorder did not finish in time and was stopped.".into()),
    }
}

#[tauri::command]
pub async fn take_screenshot() -> Result<PathBuf, String> {
    let response = Screenshot::request()
        .interactive(true)
        .send()
        .await
        .map_err(portal_error)?
        .response()
        .map_err(portal_error)?;
    let source = url::Url::parse(response.uri().as_str())
        .ok()
        .and_then(|uri| uri.to_file_path().ok())
        .ok_or("The portal returned a screenshot location Poach cannot read.")?;
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("png").to_lowercase();
    let destination = paths::private_dir("captures")?.join(format!("screenshot-{}.{extension}", uuid::Uuid::new_v4()));
    std::fs::copy(&source, &destination).map_err(|error| format!("Could not keep the screenshot: {error}"))?;
    Ok(destination)
}
