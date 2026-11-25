mod analysis;
mod capture;
mod handoff;
mod paths;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(capture::Recorder::default())
        .invoke_handler(tauri::generate_handler![
            capture::start_recording,
            capture::stop_recording,
            capture::take_screenshot,
            analysis::inspect,
            handoff::share_handoff,
            handoff::connector_connected,
        ])
        .run(tauri::generate_context!())
        .expect("Poach could not start");
}
