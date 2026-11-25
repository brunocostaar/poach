mod analysis;
mod capture;
mod handoff;
mod mutter;
mod paths;
mod window_shape;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(capture::Recorder::default())
        .manage(window_shape::WindowShape::default())
        .setup(|app| {
            window_shape::track(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::start_recording,
            capture::stop_recording,
            capture::take_screenshot,
            analysis::inspect,
            handoff::share_handoff,
            handoff::connector_connected,
            window_shape::window_radius,
        ])
        .run(tauri::generate_context!())
        .expect("Poach could not start");
}
