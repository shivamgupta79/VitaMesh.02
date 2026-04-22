//! vitalswarm_vertex v6.0 — Tashi Vertex consensus + FoxMQ MQTT integration

use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// ── VertexNode (simulation mode — real FFI requires libvertex_bridge.a) ──
pub struct VertexNode { _private: () }
unsafe impl Send for VertexNode {}
unsafe impl Sync for VertexNode {}
impl VertexNode {
    pub fn new(_node_id: &str, _n_peers: u32) -> Option<Self> { None }
    pub fn submit(&self, _payload: &[u8]) -> bool { true }
    pub fn poll(&self) -> Option<Vec<u8>> { None }
    pub fn consensus_state(&self) -> String {
        r#"{"votes_received":0,"votes_required":1,"accepted":false}"#.into()
    }
}

// ── Domain types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmEvent {
    pub node_id: String,
    pub role: String,
    pub event_type: String,
    pub x: f32,
    pub y: f32,
    pub battery: f32,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heart_rate: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spo2: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Consensus {
    pub votes_received: u32,
    pub votes_required: u32,
    pub accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshLink {
    pub node_a: String,
    pub node_b: String,
    pub rssi: i32,
    pub packet_loss: u32,
    pub latency_ms: u32,
    pub active: bool,
    pub relay_count: u32,
    pub bandwidth_kbps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Incident {
    pub inc_id: String,
    pub node_id: String,
    pub role: String,
    pub event_type: String,
    pub detected: i64,
    pub dispatched: Option<i64>,
    pub en_route: Option<i64>,
    pub resolved: Option<i64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VitalsReading {
    pub hr: f32,
    pub spo2: f32,
    pub temp: f32,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SwarmStats {
    pub total_events: u64,
    pub critical_count: u64,
    pub predictive_count: u64,
    pub response_complete: u64,
    pub task_accepted: u64,
    pub uptime_start: i64,
    pub node_count: usize,
    pub open_incidents: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmState {
    pub status: String,
    pub mesh_health: u32,
    pub consensus: Consensus,
    pub events: Vec<SwarmEvent>,
    pub incidents: HashMap<String, Incident>,
    pub mesh_links: HashMap<String, MeshLink>,
    pub vitals_history: HashMap<String, Vec<VitalsReading>>,
    pub stats: SwarmStats,
}

pub type SharedState = Arc<RwLock<SwarmState>>;

pub fn initial_state() -> SwarmState {
    let now = Utc::now().timestamp_millis();
    let mut state = SwarmState {
        status: "cloud-independent".into(),
        mesh_health: 100,
        consensus: Consensus { votes_received: 5, votes_required: 5, accepted: true },
        events: vec![
            SwarmEvent { node_id: "wearable-01".into(), role: "wearable".into(), event_type: "CRITICAL_ALERT".into(), x: -1.2, y: 3.4, battery: 3.9, ts: now, heart_rate: Some(88.0), spo2: Some(89.0), temperature: Some(38.7) },
            SwarmEvent { node_id: "rover-01".into(), role: "rover".into(), event_type: "TASK_ACCEPTED".into(), x: -1.2, y: 3.4, battery: 3.8, ts: now, heart_rate: None, spo2: None, temperature: None },
            SwarmEvent { node_id: "rover-02".into(), role: "rover".into(), event_type: "PATH_BLOCKED".into(), x: 1.1, y: 0.4, battery: 3.8, ts: now, heart_rate: None, spo2: None, temperature: None },
            SwarmEvent { node_id: "drone-01".into(), role: "drone".into(), event_type: "DRONE_RELAY_ACTIVE".into(), x: -0.5, y: 2.0, battery: 3.7, ts: now, heart_rate: None, spo2: None, temperature: None },
        ],
        incidents: HashMap::new(),
        mesh_links: HashMap::new(),
        vitals_history: HashMap::new(),
        stats: SwarmStats {
            uptime_start: Utc::now().timestamp(),
            node_count: 7,
            ..Default::default()
        },
    };
    // Seed mesh links for initial 7 nodes
    let node_positions = [
        ("wearable-01", -2.0f32, 3.0f32),
        ("wearable-02",  2.5,    3.5),
        ("wearable-03",  0.0,    4.0),
        ("rover-01",    -3.0,    0.0),
        ("rover-02",     3.0,    0.0),
        ("rover-03",     0.0,   -1.0),
        ("drone-01",     0.0,    1.5),
    ];
    for (i, (a, ax, ay)) in node_positions.iter().enumerate() {
        for (b, bx, by) in node_positions.iter().skip(i + 1) {
            let dist = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
            let key = if a < b { format!("{}|{}", a, b) } else { format!("{}|{}", b, a) };
            state.mesh_links.insert(key, MeshLink {
                node_a: a.to_string(), node_b: b.to_string(),
                rssi: (-40 - (dist * 8.0) as i32).max(-90),
                packet_loss: (((dist - 3.0) * 10.0) as u32).min(100),
                latency_ms: ((dist * 5.0) as u32).max(1),
                active: dist < 8.0,
                relay_count: 0,
                bandwidth_kbps: (250 - (dist * 20.0) as u32).max(10),
            });
        }
    }
    state
}

pub fn tick(state: &mut SwarmState) {
    let mut rng = rand::thread_rng();
    let candidates = [
        ("wearable-01","wearable","VITALS_UPDATE"),
        ("wearable-01","wearable","CRITICAL_ALERT"),
        ("wearable-02","wearable","PREDICTIVE_ALERT"),
        ("rover-01","rover","ROVER_EN_ROUTE"),
        ("rover-01","rover","TASK_ACCEPTED"),
        ("rover-02","rover","PATH_BLOCKED"),
        ("rover-03","rover","HEARTBEAT"),
        ("drone-01","drone","DRONE_RELAY_ACTIVE"),
        ("drone-01","drone","MESH_RELAY_EXTENDED"),
    ];
    let (node_id, role, event_type) = candidates[rng.gen_range(0..candidates.len())];
    let ev = SwarmEvent {
        node_id: node_id.into(), role: role.into(), event_type: event_type.into(),
        x: rng.gen_range(-5.0_f32..5.0), y: rng.gen_range(-5.0_f32..5.0),
        battery: rng.gen_range(3.5_f32..4.2), ts: Utc::now().timestamp_millis(),
        heart_rate:  if role == "wearable" { Some(rng.gen_range(65.0_f32..105.0)) } else { None },
        spo2:        if role == "wearable" { Some(rng.gen_range(88.0_f32..99.0))  } else { None },
        temperature: if role == "wearable" { Some(rng.gen_range(36.0_f32..39.5))  } else { None },
    };

    // Update vitals history
    if ev.role == "wearable" {
        if let (Some(hr), Some(spo2), Some(temp)) = (ev.heart_rate, ev.spo2, ev.temperature) {
            let h = state.vitals_history.entry(ev.node_id.clone()).or_default();
            h.push(VitalsReading { hr, spo2, temp, ts: ev.ts });
            if h.len() > 60 { h.remove(0); }
        }
    }

    // Handle incidents
    if ev.event_type == "CRITICAL_ALERT" {
        let inc_id = format!("INC-{:04}", state.incidents.len() + 1);
        state.incidents.insert(inc_id.clone(), Incident {
            inc_id, node_id: ev.node_id.clone(), role: ev.role.clone(),
            event_type: ev.event_type.clone(), detected: ev.ts,
            dispatched: None, en_route: None, resolved: None, status: "open".into(),
        });
        state.stats.critical_count += 1;
    } else if ev.event_type == "TASK_ACCEPTED" {
        for inc in state.incidents.values_mut() {
            if inc.status == "open" && inc.dispatched.is_none() {
                inc.dispatched = Some(ev.ts); inc.status = "responding".into(); break;
            }
        }
        state.stats.task_accepted += 1;
    } else if ev.event_type == "RESPONSE_COMPLETE" {
        for inc in state.incidents.values_mut() {
            if inc.status == "responding" {
                inc.resolved = Some(ev.ts); inc.status = "resolved".into(); break;
            }
        }
        state.stats.response_complete += 1;
    } else if ev.event_type == "PREDICTIVE_ALERT" {
        state.stats.predictive_count += 1;
    }

    state.stats.total_events += 1;
    state.stats.open_incidents = state.incidents.values().filter(|i| i.status != "resolved").count();
    state.stats.node_count = 7;

    state.events.push(ev);
    if state.events.len() > 60 { state.events.remove(0); }

    // Update consensus
    let total = 8u32;
    let critical = state.events.iter().filter(|e| e.event_type == "CRITICAL_ALERT").count() as u32;
    state.consensus.votes_required = (total as f32 * 0.6).ceil() as u32;
    state.consensus.votes_received = (total.saturating_sub(1) + critical).min(total);
    state.consensus.accepted = state.consensus.votes_received >= state.consensus.votes_required;

    // Update mesh health
    let active = state.mesh_links.values().filter(|l| l.active).count();
    let total_links = state.mesh_links.len().max(1);
    state.mesh_health = ((active as f32 / total_links as f32) * 40.0 + 60.0 - (critical as f32 * 5.0).min(30.0)).max(0.0) as u32;
}

// ── FoxMQ topic helpers ───────────────────────────────────────────────────

pub fn foxmq_topic_for(event: &SwarmEvent) -> String {
    match event.event_type.as_str() {
        "CRITICAL_ALERT" | "PREDICTIVE_ALERT" => format!("swarm/alert/{}", event.node_id),
        "MESH_RELAY_EXTENDED" | "DRONE_RELAY_ACTIVE" => format!("swarm/relay/{}", event.node_id),
        _ => format!("swarm/state/{}", event.node_id),
    }
}

pub fn foxmq_qos_for(event: &SwarmEvent) -> rumqttc::QoS {
    match event.event_type.as_str() {
        "CRITICAL_ALERT" | "TASK_ACCEPTED" | "RESPONSE_COMPLETE" => rumqttc::QoS::ExactlyOnce,
        _ => rumqttc::QoS::AtLeastOnce,
    }
}