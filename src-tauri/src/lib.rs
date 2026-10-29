/// Entry point of `--mcp-stdio`: relays MCP messages between stdin/stdout and the running app.
/// A stub until the MCP server lands.
pub fn mcp_stdio_bridge() -> i32 {
    1
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .run(tauri::generate_context!())
        .expect("error while running DocBro");
}
