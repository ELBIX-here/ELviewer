//! Folder watching via `notify` (ReadDirectoryChangesW on Windows). Events are
//! debounced and forwarded to the webview as a single `library-changed` event.

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

type Watcher = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<Watcher>>);

pub fn watch(app: AppHandle, state: &WatchState, roots: &[String]) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    // Dropping the old debouncer stops the old watcher.
    *guard = None;
    if roots.is_empty() {
        return Ok(());
    }
    let emitter = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(700),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let paths: Vec<String> = events
                    .iter()
                    .flat_map(|e| e.paths.iter())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if !paths.is_empty() {
                    let _ = emitter.emit("library-changed", paths);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;
    for root in roots {
        let p = Path::new(root);
        if p.is_dir() {
            debouncer
                .watch(p, RecursiveMode::Recursive)
                .map_err(|e| format!("{root}: {e}"))?;
        }
    }
    *guard = Some(debouncer);
    Ok(())
}
