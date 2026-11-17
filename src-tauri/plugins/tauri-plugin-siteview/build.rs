const COMMANDS: &[&str] = &[
    "open",
    "activate",
    "close",
    "set_rect",
    "set_interactive_regions",
    "set_covered",
    "navigate",
    "go_back",
    "go_forward",
    "reload",
    "set_color_scheme",
    "fetch_favicon",
    "set_content_rule_lists",
    "set_document_start_script",
    "notify",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .android_path("android")
        .build();
}
