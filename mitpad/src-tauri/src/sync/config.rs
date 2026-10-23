// src-tauri/src/sync/config.rs
//
// Configuración de la nube. NUNCA en el código:
//   - MITPAD_CONVEX_URL: https://<despliegue>.convex.cloud (variable de entorno, la línea
//     MITPAD_CONVEX_URL=... de ~/.config/mitpad/convex_token.env, o la fijada al compilar)
//   - MITPAD_TOKEN: token de la app (variable de entorno, o la línea
//     MITPAD_TOKEN=... de ~/.config/mitpad/convex_token.env)
use std::path::PathBuf;

pub struct Config {
    pub url: String,
    pub token: String,
}

/// Una línea CLAVE=valor de ~/.config/mitpad/convex_token.env (archivo privado del usuario).
fn del_archivo(clave: &str) -> Option<String> {
    let ruta: PathBuf = dirs::config_dir()?.join("mitpad").join("convex_token.env");
    let prefijo = format!("{clave}=");
    std::fs::read_to_string(ruta).ok()?.lines().find_map(|l| {
        l.strip_prefix(prefijo.as_str())
            .map(|t| t.trim().to_string())
    })
}

/// La configuración de la nube, si está disponible.
pub fn leer_config() -> Option<Config> {
    let url = std::env::var("MITPAD_CONVEX_URL")
        .ok()
        .or_else(|| del_archivo("MITPAD_CONVEX_URL"))
        .or_else(|| option_env!("MITPAD_CONVEX_URL").map(String::from))?;
    let token = std::env::var("MITPAD_TOKEN")
        .ok()
        .or_else(|| del_archivo("MITPAD_TOKEN"))?;
    (!url.is_empty() && !token.is_empty()).then_some(Config { url, token })
}
