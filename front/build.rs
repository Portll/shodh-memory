//! Build guard for the embedded UI.
//!
//! `src/main.rs` embeds the React app with
//! `include_str!("../ui/dist/index.html")`. That file is a BUILD ARTEFACT and is
//! deliberately not committed — `front/ui/.gitignore` ignores `dist/` because it
//! is a ~1MB single inlined HTML file that changes on every build and would make
//! diffs unreviewable.
//!
//! The consequence is that a fresh clone cannot compile this crate until the UI
//! has been built. Without this guard the developer gets rustc's raw
//! `couldn't read ../ui/dist/index.html: The system cannot find the path
//! specified` pointing at an `include_str!` line, which names the symptom and
//! not the remedy. Panicking here runs BEFORE rustc reaches the macro, so the
//! instruction below is the first thing they see.

use std::path::Path;

fn main() {
    // Re-run when the built UI changes, so `cargo check` after a `npm run build`
    // picks up the new bundle instead of serving a cached compilation.
    println!("cargo:rerun-if-changed=ui/dist/index.html");
    // Also re-run when the artefact appears for the first time; without watching
    // the directory, creating a previously-absent file does not always
    // invalidate the build script on every cargo version.
    println!("cargo:rerun-if-changed=ui/dist");

    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("ui/dist/index.html");
    if !dist.is_file() {
        panic!(
            "\n\n\
             shodh-front: the embedded UI has not been built.\n\n\
             Expected: {}\n\n\
             The React app under front/ui is compiled to ONE self-contained\n\
             index.html which this crate embeds at compile time. It is a build\n\
             artefact and is not committed, so it must be produced first:\n\n\
             \x20   cd front/ui && npm install && npm run build\n\n\
             Then re-run the cargo command.\n",
            dist.display()
        );
    }
}
