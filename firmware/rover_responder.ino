/**
 * rover_responder.ino  v3.0  —  VitalSwarm Rover Node
 *
 * v3 upgrades:
 *  - packetId field added to SwarmPacket (consistent with drone)
 *  - Vector-field navigation with obstacle avoidance (replaces simple heading)
 *  - Incident timeout escalation: broadcasts ESCALATION_NEEDED
 *  - Listens for ESCALATION_NEEDED to pick up abandoned incidents
 */
#include <WiFi.h>
#include <esp_now.h>
#include <ESP32Servo.h>
#include <esp_task_wdt.h>

#define NODE_ID           "rover-01"
#define BATTERY_PIN       34
#define BATT_DIVIDER      2.0f
#define WDT_TIMEOUT_S     10
#define TX_INTERVAL_MS    1500
#define BATT_MIN_DISPATCH 3.6f
#define ARRIVAL_DIST_CM   30.0f
#define ESCALATION_MS     20000   // escalate if no progress in 20s

struct SwarmPacket {
  char     nodeId[16];
  char     role[16];
  char     eventType[24];
  float    heartRate;
  float    spo2;
  float    temperature;
  float    accel;
  float    battery;
  float    posX;
  float    posY;
  uint32_t ts;
  uint32_t packetId;   // v3: deduplication ID
};

const int TRIG_PIN = 5, ECHO_PIN = 18;
const int IN1 = 12, IN2 = 13, IN3 = 14, IN4 = 27;
const int SERVO_PIN = 19;
Servo payloadServo;
uint8_t broadcastAddress[] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};

float targetX = 0, targetY = 0;
float posX = 0, posY = 0;
bool  responding = false;
bool  taskLocked = false;
unsigned long lastTx = 0;
unsigned long respondingStart = 0;
unsigned long lastProgressMs = 0;
float lastDistToTarget = 999;
const unsigned long RESPONSE_TIMEOUT_MS = 30000;

void stopMotors()  { digitalWrite(IN1,LOW);  digitalWrite(IN2,LOW);  digitalWrite(IN3,LOW);  digitalWrite(IN4,LOW); }
void forward()     { digitalWrite(IN1,HIGH); digitalWrite(IN2,LOW);  digitalWrite(IN3,HIGH); digitalWrite(IN4,LOW); }
void backward()    { digitalWrite(IN1,LOW);  digitalWrite(IN2,HIGH); digitalWrite(IN3,LOW);  digitalWrite(IN4,HIGH); }
void turnRight()   { digitalWrite(IN1,HIGH); digitalWrite(IN2,LOW);  digitalWrite(IN3,LOW);  digitalWrite(IN4,HIGH); }
void turnLeft()    { digitalWrite(IN1,LOW);  digitalWrite(IN2,HIGH); digitalWrite(IN3,HIGH); digitalWrite(IN4,LOW); }

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long dur = pulseIn(ECHO_PIN, HIGH, 30000);
  return dur * 0.034f / 2.0f;
}

float readBattery() {
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(BATTERY_PIN); delay(2); }
  return ((sum / 8.0f) / 4095.0f) * 3.3f * BATT_DIVIDER;
}

void broadcastEvent(const char* et, float x, float y) {
  SwarmPacket pkt;
  strncpy(pkt.nodeId,    NODE_ID, sizeof(pkt.nodeId)-1);
  strncpy(pkt.role,      "rover", sizeof(pkt.role)-1);
  strncpy(pkt.eventType, et,      sizeof(pkt.eventType)-1);
  pkt.heartRate = 0; pkt.spo2 = 0; pkt.temperature = 0;
  pkt.accel   = readDistanceCm();
  pkt.battery = readBattery();
  pkt.posX = x; pkt.posY = y;
  pkt.ts = millis();
  pkt.packetId = (uint32_t)(millis() ^ random(0xFFFF));
  esp_now_send(broadcastAddress, (uint8_t*)&pkt, sizeof(pkt));
}

void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len < (int)sizeof(SwarmPacket)) return;
  SwarmPacket pkt; memcpy(&pkt, data, sizeof(pkt));
  String et = String(pkt.eventType);
  String sender = String(pkt.nodeId);

  if ((et == "CRITICAL_ALERT" || et == "ESCALATION_NEEDED") && !responding && !taskLocked) {
    float batt = readBattery();
    if (batt < BATT_MIN_DISPATCH) return;
    targetX = pkt.posX; targetY = pkt.posY;
    responding = true; respondingStart = millis(); lastProgressMs = millis();
    lastDistToTarget = 999;
    broadcastEvent("TASK_ACCEPTED", targetX, targetY);
    Serial.printf("[%s] Task accepted (%s) -> (%.1f, %.1f)\n", NODE_ID, et.c_str(), targetX, targetY);
  }
  if (et == "TASK_ACCEPTED" && sender != NODE_ID && !responding) {
    taskLocked = true;
  }
  if (et == "RESPONSE_COMPLETE") {
    taskLocked = false;
  }
}

void setupEspNow() {
  WiFi.mode(WIFI_STA);
  if (esp_now_init() != ESP_OK) return;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, broadcastAddress, 6);
  peer.channel = 0; peer.encrypt = false;
  esp_now_add_peer(&peer);
  esp_now_register_recv_cb(onDataRecv);
}

void dropKit() {
  broadcastEvent("ROVER_ARRIVED", posX, posY);
  payloadServo.write(90); delay(800); payloadServo.write(0);
}

// Vector-field navigation: attractive force toward target + repulsive from obstacles
void navigateVectorField(float dist) {
  float dx = targetX - posX, dy = targetY - posY;
  float distToTarget = sqrt(dx*dx + dy*dy);

  // Track progress for escalation
  if (distToTarget < lastDistToTarget - 0.1f) {
    lastDistToTarget = distToTarget;
    lastProgressMs = millis();
  }

  if (distToTarget < 0.3f) { stopMotors(); return; }

  // Repulsive force from obstacle
  float repX = 0, repY = 0;
  if (dist > 0 && dist < 50) {
    float repMag = 1.0f / (dist * dist);
    repX = -repMag; // obstacle is in front, push back
  }

  // Combine attractive + repulsive
  float netX = dx / distToTarget + repX;
  float netY = dy / distToTarget + repY;

  if (abs(netX) > abs(netY)) {
    if (netX > 0) turnRight(); else turnLeft();
  } else {
    if (netY > 0) forward(); else backward();
  }
  posX += dx * 0.05f; posY += dy * 0.05f;
}

void setup() {
  Serial.begin(115200);
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);
  pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT);
  pinMode(IN1,OUTPUT); pinMode(IN2,OUTPUT); pinMode(IN3,OUTPUT); pinMode(IN4,OUTPUT);
  payloadServo.attach(SERVO_PIN); payloadServo.write(0);
  analogReadResolution(12); analogSetAttenuation(ADC_11db);
  setupEspNow();
  Serial.printf("[%s] boot OK v3.0 — vector-field nav, escalation support\n", NODE_ID);
}

void loop() {
  esp_task_wdt_reset();
  float dist = readDistanceCm();
  unsigned long now = millis();
  if (now - lastTx < TX_INTERVAL_MS) { delay(50); return; }
  lastTx = now;

  if (responding && (now - respondingStart > RESPONSE_TIMEOUT_MS)) {
    stopMotors(); responding = false; taskLocked = false;
    broadcastEvent("RESPONSE_TIMEOUT", posX, posY);
    return;
  }

  // Escalation: no progress for ESCALATION_MS → broadcast ESCALATION_NEEDED
  if (responding && (now - lastProgressMs > ESCALATION_MS)) {
    broadcastEvent("ESCALATION_NEEDED", posX, posY);
    Serial.printf("[%s] Escalating — no progress for %lums\n", NODE_ID, ESCALATION_MS);
    lastProgressMs = now; // reset to avoid spam
  }

  if (responding) {
    if (dist > 0 && dist < ARRIVAL_DIST_CM) {
      stopMotors(); dropKit();
      broadcastEvent("RESPONSE_COMPLETE", posX, posY);
      responding = false; taskLocked = false;
    } else if (dist > 0 && dist < 20) {
      stopMotors();
      broadcastEvent("PATH_BLOCKED", posX, posY);
      turnRight(); delay(600);
    } else {
      navigateVectorField(dist);
      broadcastEvent("ROVER_EN_ROUTE", posX, posY);
    }
  } else {
    stopMotors();
    broadcastEvent("HEARTBEAT", posX, posY);
  }
}
