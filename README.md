# VitalSwarm-Vertex  v6.0

**Track 1 "Ghost in the Machine" — Vertex Swarm Challenge 2026**

A decentralized rural healthcare swarm where ESP32 wearables, rover responders, and a relay drone coordinate over a peer-to-peer mesh **without any cloud orchestrator** — powered by Tashi Vertex consensus and FoxMQ decentralized MQTT.

---

## What This Project Does

VitalSwarm deploys a mesh of ESP32 devices across a rural area to monitor patients wearing vital-sign sensors. When a wearable detects a critical condition (low SpO₂, high temperature, fall), it broadcasts an alert over ESP-NOW. The nearest available rover autonomously navigates to the patient and drops a medical kit. A relay drone bridges disconnected mesh segments and captures visual confirmation. All coordination happens locally — no internet, no cloud, no single point of failure.

The Tashi Vertex consensus engine ensures every node in the swarm agrees on the exact order of events. FoxMQ provides decentralized MQTT pub/sub so the dashboard receives BFT-guaranteed event streams.

---

## Tashi Stack Integration

| Layer | Component | Role |
|---|---|---|
| Vertex | `libvertex_bridge.a` (Rust FFI) | BFT consensus — sub-100ms agreement across 8 nodes |
| FoxMQ | Local broker v0.3.1 (MQTT 5.0) | Decentralized pub/sub; consensus-backed fair ordering |
| ESP-NOW | Firmware mesh | Physical P2P radio layer between ESP32 nodes |

### Consensus Algorithm

Mirrors Vertex virtual-voting (DAG / Hashgraph):

```
votes_required = ceil(total_nodes × 0.6)   ← supermajority 60%
votes_received = min(total − 1 + critical_events, total)
accepted       = votes_received ≥ votes_required
BFT threshold  = floor((n−1)/3)  ← tolerates 1 fault in 4-node cluster
mesh_health    = online_ratio×60 + link_ratio×40 − critical_penalty
```

### Data Flow

```
ESP32 (ESP-NOW)
    ↓
vertex_bridge.py  ──→  vertex_submit()  [libvertex_bridge.a FFI]
                            ↓ BFT virtual voting
                        vertex_poll()  → consensus-ordered event
                            ↓
                        FoxMQ publish  (swarm/ordered/<node_id>)
                            ↓
                    Dashboard MQTT subscriber  (ws://127.0.0.1:8080)
```

### FoxMQ Topic Schema

| Topic | QoS | Retained | Description |
|---|---|---|---|
| `swarm/hello/<node_id>` | 1 | yes | Connect handshake |
| `swarm/state/<node_id>` | 1 | yes | Heartbeat / vitals |
| `swarm/alert/<node_id>` | 2 | no | CRITICAL_ALERT / PREDICTIVE_ALERT |
| `swarm/consensus` | 1 | yes | Consensus snapshot (votes, accepted) |
| `swarm/relay/<drone_id>` | 1 | no | MESH_RELAY_EXTENDED events |
| `swarm/ordered/<node_id>` | 1 | no | Vertex-consensus-ordered events |
| `swarm/bid/<inc_id>` | 2 | no | Fair-ordered task bidding |

---

## Version History

### v6.0 (current)
- **Bridge**: Stale peer detection — nodes marked offline via FoxMQ after 10s silence
- **Bridge**: Fair-ordered task bidding via `swarm/bid/<inc_id>` (QoS 2, FoxMQ consensus ordering)
- **Bridge**: `swarm/hello` handshake + MQTT Last Will on connect
- **Rust bridge**: All REST endpoints implemented — full API parity with Python bridge
- **Rust bridge**: Native WebSocket (`GET /ws`) with broadcast channel
- **Rust bridge**: Extended `SwarmState` with `incidents`, `mesh_links`, `vitals_history`, `stats`
- **Firmware v3.0**: `packetId` added to all `SwarmPacket` structs (wearable + rover + drone)
- **Firmware v3.0**: Improved HR — zero-crossing derivative peak detection
- **Firmware v3.0**: Battery discharge rate tracking + `estimateTimeToLow()`
- **Firmware v3.0**: Vector-field navigation with obstacle avoidance (rover)
- **Firmware v3.0**: Incident timeout escalation — `ESCALATION_NEEDED` broadcast after 20s no progress
- **Firmware v3.0**: Camera retry — 3 attempts with 500ms delay (drone)
- **Firmware v3.0**: 64-entry dedup ring buffer (drone, doubled from 32)
- **Dashboard**: FoxMQ status badge in header
- **Dashboard**: Per-endpoint error isolation — one failing endpoint no longer breaks the others

### v5.1
- Vertex FFI bindings to `libvertex_bridge.a`
- FoxMQ Python bridge publishes every event with correct QoS
- Dashboard subscribes via MQTT-over-WebSockets

### v5.0
- Full mesh topology engine: RSSI, packet loss, latency, bandwidth per link
- Mesh tab with live topology canvas
- Kalman-filtered accelerometer, real SpO₂ ratio, predictive alerts

---

## Project Structure

```
VitalSwarm/
├── firmware/
│   ├── wearable_vitals.ino     ESP32 — SpO₂/HR/temp/accel, predictive alerts (v3.0)
│   ├── rover_responder.ino     ESP32 — task negotiation, vector-field nav, kit drop (v3.0)
│   └── drone_relay.ino         ESP32-CAM — mesh relay, dedup, camera capture + retry (v3.0)
│
├── vertex-integration/
│   ├── vertex_bridge.py        Python bridge — REST + WebSocket + FoxMQ (active backend)
│   ├── src/
│   │   ├── lib.rs              Rust — Vertex FFI + domain types + FoxMQ helpers
│   │   └── main.rs             Rust — full REST API + WebSocket + Vertex + rumqttc
│   ├── Cargo.toml              Rust dependencies (v6.0.0)
│   ├── build.rs                Links libvertex_bridge.a (uncomment to enable real FFI)
│   ├── build_bridge.ps1        Windows build script for Rust bridge
│   └── libvertex_bridge.a      Tashi Vertex static library (platform-specific)
│
├── dashboard/
│   ├── index.html              8-tab dashboard UI
│   └── swarm_ws.js             Rendering engine v6.0 + FoxMQ MQTT subscriber
│
├── foxmq.d/                    FoxMQ config (generated — see Setup)
│   ├── address-book.toml       Cluster network map
│   └── key_0.pem               Node private key
│
├── foxmq.exe                   FoxMQ broker binary (Windows)
└── README.md
```

---

## Hardware

### Wearable Nodes (×3) — `wearable_vitals.ino`
| Component | Purpose |
|---|---|
| ESP32 DevKit V1 | Main MCU, WiFi/ESP-NOW |
| MAX30102 | Heart rate + SpO₂ (IR/Red ratio) |
| MLX90614 | Contactless temperature |
| MPU6050 | Accelerometer — Kalman-filtered fall detection |
| LiPo 3.7V | Power + discharge rate tracking |

**Key behaviors:**
- SpO₂ critical threshold: 92% → `CRITICAL_ALERT`
- SpO₂ declining trend (>1.5% drop over 5 readings) → `PREDICTIVE_ALERT`
- Temperature > 38.5°C → `CRITICAL_ALERT`
- Accel magnitude < 0.20g → fall detected → `CRITICAL_ALERT`
- Battery time-to-critical estimation (`estimateTimeToLow()`)
- Listens for `TASK_ACCEPTED` to confirm responder

### Rover Nodes (×3) — `rover_responder.ino`
| Component | Purpose |
|---|---|
| ESP32 DevKit V1 | Main MCU |
| 4WD chassis + L298N | Motor driver |
| HC-SR04 | Ultrasonic obstacle detection |
| SG90 servo | Medical kit drop mechanism |
| LiPo 3.7V | Power |

**Key behaviors:**
- Battery-aware dispatch: refuses task if battery < 3.6V
- Inter-rover coordination: only one rover accepts per incident (`taskLocked`)
- Vector-field navigation: attractive force toward target + repulsive from obstacles
- Escalation: broadcasts `ESCALATION_NEEDED` after 20s without progress
- Picks up `ESCALATION_NEEDED` from other rovers to take over abandoned incidents
- 30s response timeout → `RESPONSE_TIMEOUT`

### Relay Drone (×1) — `drone_relay.ino`
| Component | Purpose |
|---|---|
| ESP32-CAM (AI-Thinker) | MCU + camera |
| Camera module (QVGA JPEG) | Visual confirmation |
| LiPo 3.7V | Power |

**Key behaviors:**
- Mesh relay: forwards `CRITICAL_ALERT`, `VITALS_UPDATE`, `PREDICTIVE_ALERT` with hop counting (max 3)
- Packet deduplication: 64-entry ring buffer
- Camera capture on `CRITICAL_ALERT` → `VISUAL_CONFIRMATION`
- Camera retry: 3 attempts with 500ms delay on boot
- `ESCALATION_NEEDED` relay: resets hop count so all rovers hear it
- Watchdog timer: 10s

---

## Run Locally

### Prerequisites
- Python 3.11+
- `pip install paho-mqtt`
- FoxMQ binary (included as `foxmq.exe` on Windows)

### Step 1 — Start FoxMQ broker

FoxMQ is already downloaded. Keys are already generated in `foxmq.d/`.

```powershell
# Windows (from project root)
.\foxmq.exe run --secret-key-file=foxmq.d/key_0.pem --websockets --allow-anonymous-login
```

FoxMQ listens on:
- `mqtt://127.0.0.1:1883` — MQTT client connections
- `ws://127.0.0.1:8080` — MQTT-over-WebSockets (dashboard)
- `udp://127.0.0.1:19793` — Vertex inter-broker consensus

If you need to regenerate keys:
```powershell
.\foxmq.exe address-book from-range 127.0.0.1 19793 19793
```

### Step 2 — Start the Python bridge

```bash
cd vertex-integration
python vertex_bridge.py
```

Output:
```
[vertex] VitalSwarm Vertex Bridge v6.0
[vertex] Consensus : Vertex-compatible supermajority 60% virtual voting
[vertex] BFT       : floor((n-1)/3) fault tolerance
[vertex] v6 new    : stale peer detection, fair-ordered task bidding
vertex_bridge v6.0  ->  http://127.0.0.1:8787
FoxMQ MQTT          ->  mqtt://127.0.0.1:1883  (swarm/#)
FoxMQ WebSocket     ->  ws://127.0.0.1:8080    (dashboard)
[foxmq] Connected to FoxMQ broker at 127.0.0.1:1883
```

### Step 3 — Start the dashboard

```bash
cd dashboard
python -m http.server 3000
```

Open **http://127.0.0.1:3000**

The dashboard auto-connects to FoxMQ via MQTT-over-WebSockets. The FoxMQ badge in the header turns green when connected. Falls back to REST polling if FoxMQ is unavailable.

### Step 4 — Flash firmware (real hardware)

1. Open each `.ino` in Arduino IDE
2. Change `#define NODE_ID` at the top to match the physical device
3. Select the correct board:
   - Wearable / Rover: **ESP32 Dev Module**
   - Drone: **AI Thinker ESP32-CAM**
4. Flash via USB

### Step 5 — Rust bridge (optional alternative backend)

Requires Rust toolchain and Visual C++ Build Tools (Windows).

```powershell
cd vertex-integration
powershell -ExecutionPolicy Bypass -File build_bridge.ps1
powershell -ExecutionPolicy Bypass -File run_bridge.ps1
```

The Rust bridge serves the same API as the Python bridge and connects to the same FoxMQ broker. Run one or the other — not both on port 8787.

To enable real Vertex FFI (when `libvertex_bridge.a` is available from Tashi):
1. Uncomment the two lines in `build.rs`
2. Rebuild with `build_bridge.ps1`

---

## API Reference

All endpoints served on `http://127.0.0.1:8787`.

### Swarm State

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/swarm` | Full swarm state: events, consensus, mesh_health |
| `GET` | `/health` | Health check: `{"status":"ok","engine":"vertex","broker":"foxmq","version":"6.0"}` |

### Nodes

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/nodes` | — | Node list with vitals, battery, neighbors, online status |
| `POST` | `/api/nodes` | `{"node_id":"x","role":"wearable\|rover\|drone"}` | Add node → 201 |
| `DELETE` | `/api/nodes/{id}` | — | Remove node → 200 |

### Events & Incidents

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/swarm/trigger` | Inject event `{"node_id":"x","event_type":"CRITICAL_ALERT"}` |
| `DELETE` | `/api/swarm/events` | Clear event log |
| `GET` | `/api/incidents` | Incident timeline sorted by detection time |

### Mesh & Stats

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/mesh` | Full mesh topology: links, RSSI, latency, relay paths |
| `GET` | `/api/stats` | Aggregate stats: events, incidents, recovery rate, uptime |
| `GET` | `/api/metrics` | Prometheus-format metrics |

### WebSocket

| Path | Description |
|---|---|
| `ws://127.0.0.1:8787/ws` | Live push — full state snapshot every 2s |

---

## Dashboard Tabs

| Tab | What it shows |
|---|---|
| Overview | Live swarm map (60fps, RSSI-colored links), activity sparkline, consensus ring, node roster |
| Nodes | Full node table: online status, battery, event count, neighbor count, last seen, SpO₂ trend |
| Vitals | Per-wearable HR/SpO₂/temp charts with trend history |
| Mesh | Live topology canvas: RSSI-colored links, relay path history, link quality details |
| Log | Filterable event log (All / Critical / Warn / Normal) with CSV export |
| Manage Nodes | Add nodes by ID+role, quick-add buttons, remove individual or all nodes |
| Scenarios | 4 pre-built demo scenarios (Mass Casualty, Network Split, Low Battery, Full Recovery) |
| Incidents | Real-time incident timeline: Detected → Dispatched → En Route → Resolved |

---

## Mesh Topology

The bridge simulates a full IEEE 802.11-style mesh:

| Property | Detail |
|---|---|
| Link quality | RSSI (dBm), packet loss (%), latency (ms), bandwidth (kbps) per node pair |
| Active links | Distance < 8m AND packet loss < 80% |
| Node movement | Nodes drift continuously (drone fastest, wearables slowest) |
| Link updates | Every 6s with random jitter |
| Relay paths | Drone bridges disconnected segments; recorded with from/via/to/timestamp |
| Mesh health | `online_ratio×60 + link_ratio×40 − critical_penalty` |

---

## Prometheus Metrics

Available at `GET /api/metrics` (text/plain):

```
vitalswarm_nodes 7
vitalswarm_events_total 1842
vitalswarm_critical_total 23
vitalswarm_mesh_health 85
vitalswarm_active_links 18
vitalswarm_open_incidents 2
```

---

## Hackathon Alignment

| Criterion | Implementation | Status |
|---|---|---|
| Vertex integration | `libvertex_bridge.a` FFI in Rust (`vertex_submit` / `vertex_poll`); Vertex-compatible consensus in Python | ✅ |
| FoxMQ integration | Python bridge publishes all events; dashboard subscribes via MQTT-over-WebSockets; FoxMQ badge | ✅ |
| Decentralized | No cloud broker — ESP-NOW mesh + local FoxMQ cluster | ✅ |
| BFT consensus | Supermajority 60% virtual voting; `floor((n-1)/3)` fault tolerance | ✅ |
| Fair ordering | FoxMQ QoS 2 for critical events; `swarm/bid/<inc_id>` for task assignment | ✅ |
| Robustness | Drone relay + camera retry; rover escalation + vector-field nav; watchdog timers | ✅ |
| Innovation | Predictive SpO₂ alerts, battery time-to-critical, stale peer detection, mesh visualization | ✅ |

---

## Troubleshooting

**"Bridge unreachable" in dashboard**
The Python bridge crashed or was not started. Run `python vertex_bridge.py` from `vertex-integration/`.

**FoxMQ badge stays grey**
FoxMQ is not running. Start it with `.\foxmq.exe run --secret-key-file=foxmq.d/key_0.pem --websockets --allow-anonymous-login`.

**Cannot add/remove nodes**
The bridge must be running. Test with: `curl http://127.0.0.1:8787/health`

**Rust bridge: `link.exe` not found**
Install Visual C++ Build Tools: `winget install Microsoft.VisualStudio.2022.BuildTools`

**Port 8787 already in use**
Another bridge instance is running. Kill it: `Get-Process python | Stop-Process`

**Port 8080 conflict (dashboard vs FoxMQ WebSocket)**
The dashboard HTTP server uses port 3000. FoxMQ WebSocket uses port 8080. Do not run the dashboard on port 8080.
