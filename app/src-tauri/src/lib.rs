//! Desktop shell for VISION STREAM.
//!
//! Capture, encoding and transport run inside the WebView (WebView2 on
//! Windows: Windows Graphics Capture + Media Foundation hardware encoders +
//! WebRTC). This native side supplies what a web page cannot read: machine
//! CPU / memory load and NVIDIA GPU + NVENC utilisation through NVML.

use std::collections::HashSet;
use std::sync::Mutex;

use nvml_wrapper::enum_wrappers::device::TemperatureSensor;
use nvml_wrapper::Nvml;
use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuMetrics {
    name: String,
    utilization: u32,
    encoder_utilization: u32,
    memory_used_mb: u64,
    memory_total_mb: u64,
    temperature_c: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemMetrics {
    cpu: f32,
    cpu_cores: usize,
    memory_used_mb: u64,
    memory_total_mb: u64,
    app_memory_mb: u64,
    gpu: Option<GpuMetrics>,
}

struct Monitor {
    system: Mutex<System>,
    /// `None` when the NVIDIA driver (nvml.dll / libnvidia-ml.so) is not installed.
    nvml: Option<Nvml>,
}

const MB: u64 = 1024 * 1024;

/// Memory of this process and everything it spawned (the WebView processes).
fn process_tree_memory(system: &System) -> u64 {
    let root = Pid::from_u32(std::process::id());
    let mut tree: HashSet<Pid> = HashSet::from([root]);
    // Parents may be listed after their children, so iterate until no new descendants appear.
    loop {
        let before = tree.len();
        for (pid, process) in system.processes() {
            if process.parent().is_some_and(|parent| tree.contains(&parent)) {
                tree.insert(*pid);
            }
        }
        if tree.len() == before {
            break;
        }
    }
    tree.iter()
        .filter_map(|pid| system.process(*pid))
        .map(|process| process.memory())
        .sum()
}

fn gpu_metrics(nvml: &Nvml) -> Option<GpuMetrics> {
    let device = nvml.device_by_index(0).ok()?;
    let memory = device.memory_info().ok()?;
    Some(GpuMetrics {
        name: device.name().unwrap_or_else(|_| "NVIDIA GPU".into()),
        utilization: device.utilization_rates().map(|u| u.gpu).unwrap_or(0),
        encoder_utilization: device.encoder_utilization().map(|e| e.utilization).unwrap_or(0),
        memory_used_mb: memory.used / MB,
        memory_total_mb: memory.total / MB,
        temperature_c: device.temperature(TemperatureSensor::Gpu).ok(),
    })
}

/// Polled once per second by the Performance dashboard. CPU usage is the
/// average since the previous call.
#[tauri::command]
fn system_metrics(monitor: State<'_, Monitor>) -> SystemMetrics {
    let mut system = monitor.system.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    system.refresh_cpu_usage();
    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::All, true);
    SystemMetrics {
        cpu: system.global_cpu_usage(),
        cpu_cores: system.cpus().len(),
        memory_used_mb: system.used_memory() / MB,
        memory_total_mb: system.total_memory() / MB,
        app_memory_mb: process_tree_memory(&system) / MB,
        gpu: monitor.nvml.as_ref().and_then(gpu_metrics),
    }
}

pub fn run() {
    let mut system = System::new();
    system.refresh_cpu_usage(); // first sample: later calls report usage relative to this one
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Monitor { system: Mutex::new(system), nvml: Nvml::init().ok() })
        .invoke_handler(tauri::generate_handler![system_metrics])
        .run(tauri::generate_context!())
        .expect("failed to start VISION STREAM");
}
