//! vertex_bridge — Tashi Vertex consensus bridge with FoxMQ MQTT publishing
//!
//! Startup sequence:
//!   1. Initialise Vertex consensus node (via libvertex_bridge.a FFI)
//!   2. Connect to local FoxMQ broker (MQTT 5.0, port 1883)
//!   3. Spawn background tick: simulate swarm events → submit to Vertex
//!   4. Spawn consensus poller: drain Vertex-ordered events → publish to FoxMQ
//!   5. Serve REST + WebSocket API on :8787 for the dashboard

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Duration};
use warp::Filter;
use warp::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};

use vitalswarm_vertex::{
    foxmq_qos_for, foxmq_topic_for, initial_state, tick, Consensus, Incident, MeshLink,
    SharedState, SwarmState, VitalsReading, VertexNode,
};

use rumqttc::{AsyncClient, MqttOptions, QoS};
use serde::{Deserialize, Serialize};
use serde_json::json;

// ── FoxMQ connection settings ─────────────────────────────────────────────
const FOXMQ_HOST: &str = "127.0.0.1";
const FOXMQ_PORT: u16 = 1883;
const FOXMQ_CLIENT_ID: &str = "vitalswarm-bridge";

// ── Request/response types ────────────────────────────────────────────────
#[derive(Debug, Deserialize)]
struct AddNodeRequest {
    node_id: String,
    role: String,
}

#[derive(Debug, Deserialize)]
struct TriggerRequest {
    node_id: String,
    event_type: Option<String>,
}

#[tokio::main]
async fn main() {
    // ── 1. Vertex consensus node ──────────────────────────────────────────
    let vertex = VertexNode::new("bridge-01", 8);
    if vertex.is_some() {
        println!("[vertex] Consensus node initialised (8 peers, BFT threshold = 3)");
    } else {
        println!("[vertex] WARNING: libvertex_bridge.a not linked — running in simulation mode");
    }
    let vertex = Arc::new(vertex);

    // ── 2. FoxMQ MQTT client ──────────────────────────────────────────────
    let mut mqtt_opts = MqttOptions::new(FOXMQ_CLIENT_ID, FOXMQ_HOST, FOXMQ_PORT);
    mqtt_opts.set_keep_alive(Duration::from_secs(30));

    let (mqtt_client, mut mqtt_eventloop) = AsyncClient::new(mqtt_opts, 64);
    let mqtt_client = Arc::new(mqtt_client);

    tokio::spawn(async move {
        loop {
            match mqtt_eventloop.poll().await {
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[foxmq] connection error: {e} — retrying in 5s");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
    println!("[foxmq] Connected to FoxMQ broker at {FOXMQ_HOST}:{FOXMQ_PORT}");

    // ── 3. Shared swarm state ─────────────────────────────────────────────
    let state: SharedState = Arc::new(RwLock::new(initial_state()));

    // ── 4. WebSocket broadcast channel ───────────────────────────────────
    let (ws_tx, _) = broadcast::channel::<String>(64);
    let ws_tx = Arc::new(ws_tx);

    // ── 5. Background tick: simulate events → submit to Vertex ────────────
    {
        let tick_state = Arc::clone(&state);
        let tick_vertex = Arc::clone(&vertex);
        let tick_mqtt = Arc::clone(&mqtt_client);
        let tick_ws = Arc::clone(&ws_tx);
        tokio::spawn(async move {
            let mut timer = interval(Duration::from_secs(2));
            loop {
                timer.tick().await;
                let mut s = tick_state.write().await;
                tick(&mut s);

                if let Some(ev) = s.events.last() {
                    if let Ok(payload) = serde_json::to_vec(ev) {
                        if let Some(vx) = tick_vertex.as_ref() {
                            if !vx.submit(&payload) {
                                eprintln!("[vertex] submit failed for {}", ev.event_type);
                            }
                        }
                        let topic = foxmq_topic_for(ev);
                        let qos = foxmq_qos_for(ev);
                        let retain = matches!(ev.event_type.as_str(), "VITALS_UPDATE" | "HEARTBEAT");
                        let _ = tick_mqtt.publish(topic, qos, retain, payload).await;
                    }
                }

                let cs_json = serde_json::to_vec(&s.consensus).unwrap_or_default();
                let _ = tick_mqtt.publish("swarm/consensus", QoS::AtLeastOnce, true, cs_json).await;

                // Push state snapshot to WebSocket subscribers
                if let Ok(snapshot) = serde_json::to_string(&*s) {
                    let _ = tick_ws.send(snapshot);
                }
            }
        });
    }

    // ── 6. Vertex consensus poller ────────────────────────────────────────
    {
        let poll_vertex = Arc::clone(&vertex);
        let poll_mqtt = Arc::clone(&mqtt_client);
        let poll_state = Arc::clone(&state);
        tokio::spawn(async move {
            let mut timer = interval(Duration::from_millis(50));
            loop {
                timer.tick().await;
                if let Some(vx) = poll_vertex.as_ref() {
                    while let Some(bytes) = vx.poll() {
                        if let Ok(ev) = serde_json::from_slice::<vitalswarm_vertex::SwarmEvent>(&bytes) {
                            {
                                let mut s = poll_state.write().await;
                                s.events.push(ev.clone());
                                if s.events.len() > 60 { s.events.remove(0); }
                            }
                            let topic = format!("swarm/ordered/{}", ev.node_id);
                            let payload = serde_json::to_vec(&ev).unwrap_or_default();
                            let _ = poll_mqtt.publish(topic, QoS::AtLeastOnce, false, payload).await;
                        }
                    }
                    let cs_str = vx.consensus_state();
                    if let Ok(cs) = serde_json::from_str::<Consensus>(&cs_str) {
                        let mut s = poll_state.write().await;
                        s.consensus = cs;
                    }
                }
            }
        });
    }

    // ── 7. REST + WebSocket API ───────────────────────────────────────────
    let state_filter = {
        let s = Arc::clone(&state);
        warp::any().map(move || Arc::clone(&s))
    };
    let ws_tx_filter = {
        let tx = Arc::clone(&ws_tx);
        warp::any().map(move || Arc::clone(&tx))
    };

    // GET /api/swarm
    let swarm_route = warp::path!("api" / "swarm")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_swarm);

    // GET /api/nodes
    let get_nodes_route = warp::path!("api" / "nodes")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_nodes);

    // POST /api/nodes
    let post_nodes_route = warp::path!("api" / "nodes")
        .and(warp::post())
        .and(warp::body::json::<AddNodeRequest>())
        .and(state_filter.clone())
        .and_then(post_nodes);

    // DELETE /api/nodes/{id}
    let delete_node_route = warp::path!("api" / "nodes" / String)
        .and(warp::delete())
        .and(state_filter.clone())
        .and_then(delete_node);

    // GET /api/stats
    let stats_route = warp::path!("api" / "stats")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_stats);

    // GET /api/incidents
    let incidents_route = warp::path!("api" / "incidents")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_incidents);

    // GET /api/mesh
    let mesh_route = warp::path!("api" / "mesh")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_mesh);

    // GET /api/metrics  (Prometheus format)
    let metrics_route = warp::path!("api" / "metrics")
        .and(warp::get())
        .and(state_filter.clone())
        .and_then(get_metrics);

    // POST /api/swarm/trigger
    let trigger_route = warp::path!("api" / "swarm" / "trigger")
        .and(warp::post())
        .and(warp::body::json::<TriggerRequest>())
        .and(state_filter.clone())
        .and_then(post_trigger);

    // DELETE /api/swarm/events
    let clear_events_route = warp::path!("api" / "swarm" / "events")
        .and(warp::delete())
        .and(state_filter.clone())
        .and_then(delete_events);

    // GET /health
    let health_route = warp::path!("health")
        .and(warp::get())
        .map(|| warp::reply::json(&json!({"status":"ok","engine":"vertex","broker":"foxmq"})));

    // GET /ws  (WebSocket live push)
    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(state_filter.clone())
        .and(ws_tx_filter.clone())
        .map(|ws: warp::ws::Ws, state: SharedState, tx: Arc<broadcast::Sender<String>>| {
            ws.on_upgrade(move |socket| handle_ws(socket, state, tx))
        });

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST", "DELETE", "OPTIONS"])
        .allow_headers(vec!["Content-Type"]);

    let routes = swarm_route
        .or(get_nodes_route)
        .or(post_nodes_route)
        .or(delete_node_route)
        .or(stats_route)
        .or(incidents_route)
        .or(mesh_route)
        .or(metrics_route)
        .or(trigger_route)
        .or(clear_events_route)
        .or(health_route)
        .or(ws_route)
        .with(cors);

    println!("[bridge] REST API  → http://127.0.0.1:8787");
    println!("[bridge] WebSocket → ws://127.0.0.1:8787/ws");
    println!("[bridge] FoxMQ WS  → ws://127.0.0.1:8080  (subscribe: swarm/#)");
    println!("[bridge] Topics    → swarm/state/<id>  swarm/alert/<id>  swarm/consensus");

    warp::serve(routes).run(([127, 0, 0, 1], 8787)).await;
}

// ── WebSocket handler ─────────────────────────────────────────────────────
async fn handle_ws(ws: WebSocket, state: SharedState, tx: Arc<broadcast::Sender<String>>) {
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Send current state immediately on connect
    {
        let s = state.read().await;
        if let Ok(snapshot) = serde_json::to_string(&*s) {
            let _ = ws_tx.send(Message::text(snapshot)).await;
        }
    }

    // Subscribe to broadcast channel for live updates
    let mut rx = tx.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    if ws_tx.send(Message::text(msg)).await.is_err() { break; }
                }
                Err(_) => break,
            }
        }
    });

    // Drain incoming messages (ping/close handling)
    while let Some(result) = ws_rx.next().await {
        match result {
            Ok(msg) if msg.is_close() => break,
            Err(_) => break,
            _ => {}
        }
    }
}

// ── Route handlers ────────────────────────────────────────────────────────

async fn get_swarm(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    Ok(warp::reply::json(&*s))
}

async fn get_nodes(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    let mut seen: HashMap<String, _> = HashMap::new();
    for ev in &s.events {
        seen.insert(ev.node_id.clone(), ev.clone());
    }
    let nodes: Vec<_> = seen.into_values().collect();
    Ok(warp::reply::json(&nodes))
}

async fn post_nodes(
    body: AddNodeRequest,
    state: SharedState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let valid_roles = ["wearable", "rover", "drone"];
    if body.node_id.trim().is_empty() || !valid_roles.contains(&body.role.as_str()) {
        let reply = warp::reply::json(&json!({"error": "node_id and valid role required"}));
        return Ok(warp::reply::with_status(reply, warp::http::StatusCode::BAD_REQUEST));
    }
    let mut s = state.write().await;
    let already_exists = s.events.iter().any(|e| e.node_id == body.node_id);
    if already_exists {
        let reply = warp::reply::json(&json!({"error": "node already exists"}));
        return Ok(warp::reply::with_status(reply, warp::http::StatusCode::CONFLICT));
    }
    let ev = vitalswarm_vertex::SwarmEvent {
        node_id: body.node_id.clone(),
        role: body.role.clone(),
        event_type: "NODE_JOINED".into(),
        x: 0.0, y: 0.0, battery: 4.2,
        ts: chrono::Utc::now().timestamp_millis(),
        heart_rate: None, spo2: None, temperature: None,
    };
    s.events.push(ev);
    let reply = warp::reply::json(&json!({"ok": true, "node_id": body.node_id, "role": body.role}));
    Ok(warp::reply::with_status(reply, warp::http::StatusCode::CREATED))
}

async fn delete_node(
    node_id: String,
    state: SharedState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut s = state.write().await;
    let exists = s.events.iter().any(|e| e.node_id == node_id);
    if !exists {
        let reply = warp::reply::json(&json!({"error": "node not found"}));
        return Ok(warp::reply::with_status(reply, warp::http::StatusCode::NOT_FOUND));
    }
    s.events.retain(|e| e.node_id != node_id);
    s.vitals_history.remove(&node_id);
    let reply = warp::reply::json(&json!({"ok": true, "removed": node_id}));
    Ok(warp::reply::with_status(reply, warp::http::StatusCode::OK))
}

async fn get_stats(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    let uptime = chrono::Utc::now().timestamp() - s.stats.uptime_start;
    let recovery_rate = if s.stats.task_accepted > 0 {
        (s.stats.response_complete as f64 / s.stats.task_accepted as f64) * 100.0
    } else { 0.0 };
    let out = json!({
        "total_events": s.stats.total_events,
        "critical_count": s.stats.critical_count,
        "predictive_count": s.stats.predictive_count,
        "response_complete": s.stats.response_complete,
        "task_accepted": s.stats.task_accepted,
        "uptime_seconds": uptime,
        "node_count": s.stats.node_count,
        "open_incidents": s.stats.open_incidents,
        "mesh_health": s.mesh_health,
        "recovery_rate": (recovery_rate * 10.0).round() / 10.0,
        "active_links": s.mesh_links.values().filter(|l| l.active).count(),
        "total_links": s.mesh_links.len(),
        "vitals_history": s.vitals_history,
    });
    Ok(warp::reply::json(&out))
}

async fn get_incidents(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    let mut incidents: Vec<_> = s.incidents.values().cloned().collect();
    incidents.sort_by(|a, b| b.detected.cmp(&a.detected));
    Ok(warp::reply::json(&incidents))
}

async fn get_mesh(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    let links: Vec<_> = s.mesh_links.values().cloned().collect();
    let active_links = links.iter().filter(|l| l.active).count();
    let avg_rssi = if links.is_empty() { 0.0 } else {
        links.iter().map(|l| l.rssi as f64).sum::<f64>() / links.len() as f64
    };
    let avg_latency = if links.is_empty() { 0.0 } else {
        links.iter().map(|l| l.latency_ms as f64).sum::<f64>() / links.len() as f64
    };
    let out = json!({
        "links": links,
        "relay_paths": [],
        "active_links": active_links,
        "total_links": links.len(),
        "avg_rssi": (avg_rssi * 10.0).round() / 10.0,
        "avg_latency_ms": (avg_latency * 10.0).round() / 10.0,
    });
    Ok(warp::reply::json(&out))
}

async fn get_metrics(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let s = state.read().await;
    let active_links = s.mesh_links.values().filter(|l| l.active).count();
    let lines = vec![
        format!("vitalswarm_nodes {}", s.stats.node_count),
        format!("vitalswarm_events_total {}", s.stats.total_events),
        format!("vitalswarm_critical_total {}", s.stats.critical_count),
        format!("vitalswarm_mesh_health {}", s.mesh_health),
        format!("vitalswarm_active_links {}", active_links),
        format!("vitalswarm_open_incidents {}", s.stats.open_incidents),
    ];
    let body = lines.join("\n");
    Ok(warp::reply::with_header(body, "Content-Type", "text/plain"))
}

async fn post_trigger(
    body: TriggerRequest,
    state: SharedState,
) -> Result<impl warp::Reply, warp::Rejection> {
    let mut s = state.write().await;
    let exists = s.events.iter().any(|e| e.node_id == body.node_id);
    if !exists {
        let reply = warp::reply::json(&json!({"error": "node not found"}));
        return Ok(warp::reply::with_status(reply, warp::http::StatusCode::NOT_FOUND));
    }
    let role = s.events.iter()
        .filter(|e| e.node_id == body.node_id)
        .last()
        .map(|e| e.role.clone())
        .unwrap_or_else(|| "wearable".into());
    let event_type = body.event_type.unwrap_or_else(|| "CRITICAL_ALERT".into());
    let ev = vitalswarm_vertex::SwarmEvent {
        node_id: body.node_id.clone(),
        role,
        event_type: event_type.clone(),
        x: 0.0, y: 0.0, battery: 3.9,
        ts: chrono::Utc::now().timestamp_millis(),
        heart_rate: None, spo2: None, temperature: None,
    };
    s.events.push(ev.clone());
    if s.events.len() > 60 { s.events.remove(0); }
    let reply = warp::reply::json(&json!({"ok": true, "event": ev}));
    Ok(warp::reply::with_status(reply, warp::http::StatusCode::OK))
}

async fn delete_events(state: SharedState) -> Result<impl warp::Reply, warp::Rejection> {
    let mut s = state.write().await;
    s.events.clear();
    s.stats.total_events = 0;
    Ok(warp::reply::json(&json!({"ok": true})))
}
