fn main() {
    // The file dialog (rfd) imports TaskDialogIndirect from comctl32 v6. If the
    // loader ever binds the v5 DLL instead (seen once on a freshly built exe),
    // a static import kills the app at startup with "entry point not found".
    // Delay-loading resolves it on first use instead, after the manifest's
    // activation context is in place.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("windows") && target.contains("msvc") {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }
    google_oauth_client();
    tauri_build::build()
}

/// Desktop Google sign-in needs an OAuth client of type "Desktop app". Put the JSON
/// downloaded from Google Cloud Console at `src-tauri/google_oauth.json` or `ELviewer/google_oauth.json` (gitignored);
/// without it the app builds fine and Google Drive shows as unavailable.
fn google_oauth_client() {
    // Looked up next to Cargo.toml first, then in the ELviewer folder above it.
    let candidates = ["google_oauth.json", "../google_oauth.json"];
    for c in candidates {
        println!("cargo:rerun-if-changed={c}");
    }
    let Some(text) = candidates.iter().find_map(|c| std::fs::read_to_string(c).ok()) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        println!("cargo:warning=google_oauth.json is not valid JSON");
        return;
    };
    // Google's download wraps the client in "installed"; a flat object works too.
    let c = v.get("installed").unwrap_or(&v);
    if let (Some(id), Some(secret)) = (c.get("client_id").and_then(|x| x.as_str()), c.get("client_secret").and_then(|x| x.as_str())) {
        println!("cargo:rustc-env=ELVIEWER_GOOGLE_CLIENT_ID={id}");
        println!("cargo:rustc-env=ELVIEWER_GOOGLE_CLIENT_SECRET={secret}");
    }
}