# Requirements Document

## Introduction

VitalSwarm-Vertex v6 is a decentralized rural healthcare swarm system for the Vertex Swarm Challenge 2026 (Track 1 "Ghost in the Machine"). The system coordinates ESP32 wearable sensors, rover responders, and a relay drone over a peer-to-peer ESP-NOW mesh, bridged to a dashboard via a Python/Rust REST+WebSocket server and a FoxMQ decentralized MQTT broker.

This upgrade spec addresses six concrete defects and one documentation gap identified in the v5.x codebase:

1. The Rust bridge (`main.rs`) is missing REST endpoints that the dashboard expects, causing "Bridge unreachable" errors when the Rust binary is used as the backend.
2. The Python bridge FoxMQ `swarm/hello` publish path needs verification and the Last Will pattern needs to be confirmed working.
3. The dashboard nav bar is missing a button for the Mesh tab (the tab panel exists in HTML but is unreachable via the nav).
4. The `pull()` polling function in `swarm_ws.js` fetches `/api/mesh` only conditionally; it must always fetch it so `lastMesh` stays current.
5. The `SwarmPacket` struct in `wearable_vitals.ino` and `rover_responder.ino` is missing the `packetId` field that `drone_relay.ino` already has, causing struct-size mismatches on the ESP-NOW mesh.
6. The README does not document the `swarm/hello` handshake topic or the Last Will pattern used by the Python bridge.

---

## Glossary

- **Rust_Bridge**: The Rust binary (`vertex-integration/src/main.rs`) that serves the REST + WebSocket API on port 8787 and connects to FoxMQ via `rumqttc`.
- **Python_Bridge**: The Python script (`vertex-integration/vertex_bridge.py`) that serves the same REST + WebSocket API and is the currently active backend.
- **Dashboard**: The single-page application (`dashboard/index.html` + `dashboard/swarm_ws.js`) that visualises swarm state across 8 tabs.
- **FoxMQ**: The local Tashi decentralized MQTT 5.0 broker that the bridges publish to and the dashboard subscribes to via MQTT-over-WebSockets.
- **SwarmPacket**: The C struct shared across all three ESP32 firmware files that carries node telemetry over ESP-NOW.
- **Mesh_Tab**: The dashboard tab (panel id `tab-mesh`) that renders live mesh topology, link quality, and relay paths.
- **pull()**: The JavaScript polling function in `swarm_ws.js` that fetches all REST endpoints every 3 seconds.
- **packetId**: A `uint32_t` field in `SwarmPacket` used for deduplication across the ESP-NOW mesh.
- **Last_Will**: An MQTT Last Will and Testament message that FoxMQ delivers automatically if a client disconnects ungracefully.
- **swarm/hello**: The FoxMQ topic on which a bridge publishes a retained online-status message immediately after connecting.

---

## Requirements

### Requirement 1: Rust Bridge — Missing REST Endpoints

**User Story:** As a developer running the Rust bridge as the active backend, I want all REST endpoints that the dashboard calls to be implemented, so that the dashboard does not show "Bridge unreachable" errors.

#### Acceptance Criteria

1. THE Rust_Bridge SHALL expose `GET /api/stats` and return a JSON object containing `total_events`, `critical_count`, `predictive_count`, `response_complete`, `task_accepted`, `uptime_seconds`, `node_count`, `open_incidents`, `mesh_health`, `recovery_rate`, `active_links`, `total_links`, and `vitals_history`.
2. THE Rust_Bridge SHALL expose `GET /api/mesh` and return a JSON object containing `links`, `relay_paths`, `active_links`, `total_links`, `avg_rssi`, and `avg_latency_ms`.
3. THE Rust_Bridge SHALL expose `GET /api/incidents` and return a JSON array of incident objects sorted by `detected` descending, each containing `inc_id`, `node_id`, `role`, `event_type`, `detected`, `dispatched`, `en_route`, `resolved`, and `status`.
4. THE Rust_Bridge SHALL expose `POST /api/swarm/trigger` accepting `{ node_id, event_type }` and return `{ ok: true, event: <SwarmEvent> }` with HTTP 200 when the node exists.
5. IF a `POST /api/swarm/trigger` request references a `node_id` that does not exist in the current event log, THEN THE Rust_Bridge SHALL return HTTP 404 with `{ "error": "node not found" }`.
6. THE Rust_Bridge SHALL expose `POST /api/nodes` accepting `{ node_id, role }` and return HTTP 201 with `{ ok: true, node_id, role }` when the node is successfully added.
7. IF a `POST /api/nodes` request supplies an empty `node_id` or a `role` not in `["wearable", "rover", "drone"]`, THEN THE Rust_Bridge SHALL return HTTP 400 with `{ "error": "node_id and valid role required" }`.
8. IF a `POST /api/nodes` request supplies a `node_id` that already exists, THEN THE Rust_Bridge SHALL return HTTP 409 with `{ "error": "node already exists" }`.
9. THE Rust_Bridge SHALL expose `DELETE /api/nodes/{id}` and return HTTP 200 with `{ ok: true, removed: <id> }` when the node is found and removed.
10. IF a `DELETE /api/nodes/{id}` request references a `node_id` that does not exist, THEN THE Rust_Bridge SHALL return HTTP 404 with `{ "error": "node not found" }`.
11. THE Rust_Bridge SHALL expose `DELETE /api/swarm/events` and return `{ ok: true }` after clearing the in-memory event log and resetting `total_events` to zero.
12. THE Rust_Bridge SHALL expose `GET /api/metrics` and return Prometheus-format plain text containing at minimum `vitalswarm_nodes`, `vitalswarm_events_total`, `vitalswarm_critical_total`, `vitalswarm_mesh_health`, `vitalswarm_active_links`, and `vitalswarm_open_incidents`.
13. WHEN the Rust_Bridge starts, THE Rust_Bridge SHALL print the URLs for the REST API, WebSocket endpoint, and FoxMQ WebSocket endpoint to stdout.

---

### Requirement 2: Python Bridge — FoxMQ swarm/hello and Last Will Verification

**User Story:** As a developer integrating with FoxMQ, I want the Python bridge to correctly publish the `swarm/hello` handshake and configure a Last Will, so that other subscribers can detect bridge presence and absence reliably.

#### Acceptance Criteria

1. WHEN the Python_Bridge connects to FoxMQ, THE Python_Bridge SHALL publish a retained message to `swarm/hello/<BRIDGE_ID>` with payload `{ "agent_id": "<BRIDGE_ID>", "role": "bridge", "status": "online", "timestamp_ms": <epoch_ms> }` at QoS 1.
2. WHEN the Python_Bridge connects to FoxMQ, THE Python_Bridge SHALL register a Last Will message on topic `swarm/state/<BRIDGE_ID>` with payload `{ "agent_id": "<BRIDGE_ID>", "status": "offline" }` at QoS 1 retained, so FoxMQ delivers it automatically on ungraceful disconnect.
3. WHEN the Python_Bridge successfully connects to FoxMQ, THE Python_Bridge SHALL print `[foxmq] Connected to FoxMQ broker at <host>:<port>` and `[foxmq] Published swarm/hello/<BRIDGE_ID> (handshake)` to stdout.
4. IF the Python_Bridge cannot connect to FoxMQ at startup, THEN THE Python_Bridge SHALL print a human-readable error message and the FoxMQ start command to stdout, and SHALL continue serving the REST API without crashing.
5. WHEN the Python_Bridge publishes a `CRITICAL_ALERT` or `TASK_ACCEPTED` or `RESPONSE_COMPLETE` event to FoxMQ, THE Python_Bridge SHALL use QoS 2 (exactly-once delivery).
6. WHEN the Python_Bridge publishes a `VITALS_UPDATE` or `HEARTBEAT` event to FoxMQ, THE Python_Bridge SHALL set the `retain` flag to `true`.

---

### Requirement 3: Dashboard — Mesh Tab Navigation Button

**User Story:** As a dashboard user, I want a visible Mesh tab button in the navigation bar, so that I can navigate to the Mesh topology view without knowing it exists.

#### Acceptance Criteria

1. THE Dashboard SHALL render a navigation button labelled "📡 Mesh" (or equivalent mesh icon + text) in the `.tabs` nav bar alongside the existing Overview, Nodes, Vitals, Log, Manage Nodes, Scenarios, and Incidents buttons.
2. WHEN the Mesh nav button is clicked, THE Dashboard SHALL activate the `tab-mesh` panel and deactivate all other tab panels, consistent with the behaviour of all other nav buttons.
3. THE Dashboard SHALL apply the `.active` CSS class to the Mesh nav button when the Mesh tab is the currently displayed tab, and remove it when another tab is selected.
4. THE Dashboard SHALL render the Mesh nav button in the same visual style as all other nav buttons (same font, padding, and hover behaviour).

---

### Requirement 4: Dashboard — pull() Always Fetches /api/mesh

**User Story:** As a dashboard user, I want the mesh topology to stay current on every poll cycle, so that the Mesh tab and the swarm map always reflect the latest link state.

#### Acceptance Criteria

1. WHEN `pull()` executes, THE Dashboard SHALL always issue a `fetch` request to `${API}/api/mesh`, regardless of which tab is currently active.
2. WHEN the `/api/mesh` response is received successfully, THE Dashboard SHALL update `lastMesh` with the response data on every poll cycle.
3. IF the `/api/mesh` fetch throws an error, THEN THE Dashboard SHALL silently continue without updating `lastMesh` and without displaying an error toast for this non-critical endpoint.
4. WHEN `pull()` receives a successful `/api/mesh` response and the Mesh tab is currently active, THE Dashboard SHALL call `renderMeshTab()` with the new mesh data.
5. WHEN `pull()` receives a successful `/api/mesh` response and the Mesh tab is not active, THE Dashboard SHALL still update `lastMesh` so the swarm map link overlay uses current link quality data.

---

### Requirement 5: Firmware — SwarmPacket Struct Consistency

**User Story:** As a firmware developer, I want all three ESP32 firmware files to use an identical `SwarmPacket` struct layout, so that ESP-NOW packets can be received and decoded correctly by any node regardless of sender.

#### Acceptance Criteria

1. THE `wearable_vitals.ino` SwarmPacket struct SHALL contain a `uint32_t packetId` field as its last member, matching the field order and type used in `drone_relay.ino`.
2. THE `rover_responder.ino` SwarmPacket struct SHALL contain a `uint32_t packetId` field as its last member, matching the field order and type used in `drone_relay.ino`.
3. THE `drone_relay.ino` SwarmPacket struct SHALL retain its existing `uint8_t hopCount` field followed by `uint32_t packetId` as the last two members.
4. WHEN `wearable_vitals.ino` broadcasts a `SwarmPacket`, THE wearable firmware SHALL populate `packetId` with a value derived from `millis() ^ random(0xFFFF)` to provide a unique deduplication identifier per transmission.
5. WHEN `rover_responder.ino` broadcasts a `SwarmPacket`, THE rover firmware SHALL populate `packetId` with a value derived from `millis() ^ random(0xFFFF)`.
6. FOR ALL three firmware files, `sizeof(SwarmPacket)` SHALL be identical so that the `len != sizeof(SwarmPacket)` guard in each `onDataRecv` callback accepts packets from any node type.

---

### Requirement 6: README — FoxMQ Pattern Documentation

**User Story:** As a new contributor or hackathon judge, I want the README to document the `swarm/hello` handshake and Last Will patterns, so that I understand how bridge presence is signalled without reading the source code.

#### Acceptance Criteria

1. THE README SHALL include a `swarm/hello/<node_id>` row in the FoxMQ topic schema table, documenting QoS 1, retained flag true, and its purpose as a connect handshake.
2. THE README SHALL include a description of the Last Will pattern, specifying that the bridge registers a Last Will on `swarm/state/<BRIDGE_ID>` with `{ "status": "offline" }` payload, QoS 1 retained, delivered by FoxMQ on ungraceful disconnect.
3. THE README SHALL document the Last Will and `swarm/hello` patterns in the same section as the existing FoxMQ topic schema table so they are co-located with related information.
4. THE README SHALL document that the `swarm/hello` message is published immediately after FoxMQ connection is established, before any event publishing begins.
