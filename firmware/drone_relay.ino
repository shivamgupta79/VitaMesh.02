/**
 * drone_relay.ino  v3.0  —  VitalSwarm Drone Relay Node
 *
 * v3 upgrades:
 *  - Camera setup retry: 3 attempts with 500ms delay
 *  - ESCALATION_NEEDED relay: re-broadcasts with reset hop count
 *  - Improved dedup: seenIds ring buffer now 64 entries
 */
#include <WiFi.h>
#include <esp_now.h>
#include "esp_camera.h"
#include <esp_task_wdt.h>

#define NODE_ID        "drone-01"
#define WDT_TIMEOUT_S  10
#define TX_INTERVAL_MS 2500
#define MAX_HOP_COUNT  3
#define DEDUP_SIZE     64    // v3: doubled from 32

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
  uint8_t  hopCount;
  uint32_t packetId;
};

uint8_t broadcastAddress[] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
unsigned long lastTx = 0;
bool cameraOk = false;

uint32_t seenIds[DEDUP_SIZE] = {0};
int seenIdx = 0;

#define PWDN_GPIO_NUM  32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM   0
#define SIOD_GPIO_NUM  26
#define SIOC_GPIO_NUM  27
#define Y9_GPIO_NUM    35
#define Y8_GPIO_NUM    34
#define Y7_GPIO_NUM    39
#define Y6_GPIO_NUM    36
#define Y5_GPIO_NUM    21
#define Y4_GPIO_NUM    19
#define Y3_GPIO_NUM    18
#define Y2_GPIO_NUM     5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM  23
#define PCLK_GPIO_NUM  22

bool setupCamera() {
  camera_config_t cfg;
  cfg.ledc_channel = LEDC_CHANNEL_0; cfg.ledc_timer = LEDC_TIMER_0;
  cfg.pin_d0=Y2_GPIO_NUM; cfg.pin_d1=Y3_GPIO_NUM; cfg.pin_d2=Y4_GPIO_NUM;
  cfg.pin_d3=Y5_GPIO_NUM; cfg.pin_d4=Y6_GPIO_NUM; cfg.pin_d5=Y7_GPIO_NUM;
  cfg.pin_d6=Y8_GPIO_NUM; cfg.pin_d7=Y9_GPIO_NUM;
  cfg.pin_xclk=XCLK_GPIO_NUM; cfg.pin_pclk=PCLK_GPIO_NUM;
  cfg.pin_vsync=VSYNC_GPIO_NUM; cfg.pin_href=HREF_GPIO_NUM;
  cfg.pin_sscb_sda=SIOD_GPIO_NUM; cfg.pin_sscb_scl=SIOC_GPIO_NUM;
  cfg.pin_pwdn=PWDN_GPIO_NUM; cfg.pin_reset=RESET_GPIO_NUM;
  cfg.xclk_freq_hz=20000000; cfg.pixel_format=PIXFORMAT_JPEG;
  cfg.frame_size=FRAMESIZE_QVGA; cfg.jpeg_quality=12; cfg.fb_count=1;
  return esp_camera_init(&cfg) == ESP_OK;
}

bool isDuplicate(uint32_t id) {
  for (int i = 0; i < DEDUP_SIZE; i++) if (seenIds[i] == id) return true;
  seenIds[seenIdx % DEDUP_SIZE] = id; seenIdx++;
  return false;
}

void broadcastEvent(const char* et, uint8_t hops = 0) {
  SwarmPacket pkt;
  strncpy(pkt.nodeId,    NODE_ID, sizeof(pkt.nodeId)-1);
  strncpy(pkt.role,      "drone", sizeof(pkt.role)-1);
  strncpy(pkt.eventType, et,      sizeof(pkt.eventType)-1);
  pkt.heartRate=0; pkt.spo2=0; pkt.temperature=0; pkt.accel=0;
  pkt.battery  = 3.9f;
  pkt.posX     = random(-50, 50) / 10.0f;
  pkt.posY     = random(-50, 50) / 10.0f;
  pkt.ts       = millis();
  pkt.hopCount = hops;
  pkt.packetId = (uint32_t)(millis() ^ random(0xFFFF));
  esp_now_send(broadcastAddress, (uint8_t*)&pkt, sizeof(pkt));
}

void captureAndConfirm() {
  if (!cameraOk) { broadcastEvent("VISUAL_CONFIRMATION_REQUESTED"); return; }
  camera_fb_t *fb = esp_camera_fb_get();
  if (fb) {
    Serial.printf("[%s] Image captured: %d bytes\n", NODE_ID, fb->len);
    esp_camera_fb_return(fb);
    broadcastEvent("VISUAL_CONFIRMATION");
  } else {
    broadcastEvent("VISUAL_CONFIRMATION_REQUESTED");
  }
}

void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len < (int)sizeof(SwarmPacket)) return;
  SwarmPacket pkt; memcpy(&pkt, data, sizeof(pkt));
  if (isDuplicate(pkt.packetId)) return;

  String et = String(pkt.eventType);
  String sender = String(pkt.nodeId);

  if (et == "CRITICAL_ALERT") captureAndConfirm();

  // Standard relay for critical health events
  if (sender != NODE_ID && pkt.hopCount < MAX_HOP_COUNT) {
    if (et == "CRITICAL_ALERT" || et == "VITALS_UPDATE" || et == "PREDICTIVE_ALERT") {
      pkt.hopCount++;
      esp_now_send(broadcastAddress, (uint8_t*)&pkt, sizeof(pkt));
      broadcastEvent("MESH_RELAY_EXTENDED");
    }
  }

  // v3: ESCALATION_NEEDED relay — reset hop count so all rovers hear it
  if (et == "ESCALATION_NEEDED" && sender != NODE_ID) {
    pkt.hopCount = 0;  // reset so it propagates fully
    pkt.packetId = (uint32_t)(millis() ^ random(0xFFFF)); // new ID to avoid dedup
    esp_now_send(broadcastAddress, (uint8_t*)&pkt, sizeof(pkt));
    broadcastEvent("MESH_RELAY_EXTENDED");
    Serial.printf("[%s] Relayed ESCALATION_NEEDED from %s\n", NODE_ID, sender.c_str());
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

void setup() {
  Serial.begin(115200);
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);

  // v3: Camera retry — 3 attempts with 500ms delay
  for (int attempt = 1; attempt <= 3; attempt++) {
    cameraOk = setupCamera();
    if (cameraOk) break;
    Serial.printf("[%s] Camera init attempt %d/3 failed, retrying...\n", NODE_ID, attempt);
    delay(500);
  }

  setupEspNow();
  Serial.printf("[%s] boot OK v3.0 — camera=%s dedup=%d escalation_relay=ON\n",
                NODE_ID, cameraOk ? "OK" : "FAIL", DEDUP_SIZE);
}

void loop() {
  esp_task_wdt_reset();
  unsigned long now = millis();
  if (now - lastTx < TX_INTERVAL_MS) { delay(50); return; }
  lastTx = now;
  if (cameraOk) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
  }
  broadcastEvent("DRONE_RELAY_ACTIVE");
}
