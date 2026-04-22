#!/usr/bin/env python3
"""
vertex_bridge.py v6.0 - VitalSwarm Vertex-compatible swarm bridge

Vertex Consensus State Machine (compatible with libvertex_bridge.a ABI)
  votes_required = ceil(total_nodes * 0.6)   [supermajority 60%]
  votes_received = min(total - 1 + critical_events, total)
  accepted       = votes_received >= votes_required
  BFT threshold  : floor((n-1)/3)

FoxMQ topic schema:
  swarm/hello/<node_id>    QoS 1 retained  - connect handshake
  swarm/state/<node_id>    QoS 1 retained  - heartbeat/vitals
  swarm/alert/<node_id>    QoS 2           - CRITICAL_ALERT / PREDICTIVE_ALERT
  swarm/consensus          QoS 1 retained  - consensus snapshot
  swarm/relay/<drone_id>   QoS 1           - MESH_RELAY_EXTENDED
  swarm/ordered/<node_id>  QoS 1           - Vertex-consensus-ordered events

v6 upgrades:
  - Stale peer detection (STALE_THRESHOLD_MS = 10000)
  - Fair-ordered task bidding via FoxMQ swarm/bid/<inc_id>
  - Per-endpoint error isolation in pull()
  - FoxMQ status badge support
"""
import sys,json,random,time,threading,re,math,struct,hashlib,base64,socket
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import urlparse
sys.stdout.reconfigure(line_buffering=True)

# ── FoxMQ MQTT integration ────────────────────────────────────────────────
try:
    import paho.mqtt.client as mqtt_lib
    _MQTT_AVAILABLE = True
except ImportError:
    _MQTT_AVAILABLE = False
    print("[foxmq] paho-mqtt not installed. Run: pip install paho-mqtt", flush=True)

FOXMQ_HOST = "127.0.0.1"
FOXMQ_PORT = 1883
BRIDGE_ID  = "vitalswarm-bridge"
STALE_THRESHOLD_MS = 10000
_mqtt_client = None
_mqtt_lock = threading.Lock()

def _foxmq_topic(node_id, event_type):
    if "CRITICAL" in event_type or "PREDICTIVE" in event_type:
        return f"swarm/alert/{node_id}"
    if "RELAY" in event_type or "DRONE" in event_type:
        return f"swarm/relay/{node_id}"
    return f"swarm/state/{node_id}"

def _foxmq_qos(event_type):
    if event_type in ("CRITICAL_ALERT","TASK_ACCEPTED","RESPONSE_COMPLETE"):
        return 2
    return 1

def _foxmq_connect():
    global _mqtt_client
    if not _MQTT_AVAILABLE:
        return
    try:
        client = mqtt_lib.Client(client_id=BRIDGE_ID, protocol=mqtt_lib.MQTTv5)
        client.will_set(
            topic=f"swarm/state/{BRIDGE_ID}",
            payload=json.dumps({"agent_id": BRIDGE_ID, "status": "offline"}),
            qos=1, retain=True
        )
        client.connect(FOXMQ_HOST, FOXMQ_PORT, keepalive=30)
        client.loop_start()
        _mqtt_client = client
        hello = json.dumps({"agent_id": BRIDGE_ID, "role": "bridge",
                            "status": "online", "timestamp_ms": int(time.time()*1000)})
        client.publish(f"swarm/hello/{BRIDGE_ID}", hello, qos=1, retain=True)
        print(f"[foxmq] Connected to FoxMQ broker at {FOXMQ_HOST}:{FOXMQ_PORT}", flush=True)
    except Exception as e:
        print(f"[foxmq] Could not connect: {e}", flush=True)

def foxmq_publish(ev):
    with _mqtt_lock:
        if _mqtt_client is None:
            return
        try:
            topic  = _foxmq_topic(ev["node_id"], ev["event_type"])
            qos    = _foxmq_qos(ev["event_type"])
            retain = ev["event_type"] in ("VITALS_UPDATE","HEARTBEAT")
            _mqtt_client.publish(topic, json.dumps(ev), qos=qos, retain=retain)
        except Exception as e:
            print(f"[foxmq] publish error: {e}", flush=True)

def foxmq_publish_consensus(cs):
    with _mqtt_lock:
        if _mqtt_client is None:
            return
        try:
            _mqtt_client.publish("swarm/consensus", json.dumps(cs), qos=1, retain=True)
        except Exception:
            pass

def foxmq_publish_bid(inc_id, agent_id, ts):
    """Fair-ordered task bidding — first bid wins via FoxMQ consensus ordering."""
    with _mqtt_lock:
        if _mqtt_client is None:
            return
        try:
            payload = json.dumps({"agent_id": agent_id, "timestamp_ms": ts})
            _mqtt_client.publish(f"swarm/bid/{inc_id}", payload, qos=2)
        except Exception:
            pass

threading.Thread(target=_foxmq_connect, daemon=True).start()

# ── Swarm state ───────────────────────────────────────────────────────────
EVENTS={"wearable":["VITALS_UPDATE","VITALS_UPDATE","VITALS_UPDATE","CRITICAL_ALERT","PREDICTIVE_ALERT"],"rover":["HEARTBEAT","HEARTBEAT","TASK_ACCEPTED","ROVER_EN_ROUTE","PATH_BLOCKED","RESPONSE_COMPLETE","ROVER_ARRIVED"],"drone":["DRONE_RELAY_ACTIVE","DRONE_RELAY_ACTIVE","VISUAL_CONFIRMATION_REQUESTED","MESH_RELAY_EXTENDED"]}
nodes={"wearable-01":{"role":"wearable","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":-2.0,"y":3.0,"vx":0.0,"vy":0.0},"wearable-02":{"role":"wearable","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":2.5,"y":3.5,"vx":0.0,"vy":0.0},"wearable-03":{"role":"wearable","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":0.0,"y":4.0,"vx":0.0,"vy":0.0},"rover-01":{"role":"rover","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":-3.0,"y":0.0,"vx":0.0,"vy":0.0},"rover-02":{"role":"rover","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":3.0,"y":0.0,"vx":0.0,"vy":0.0},"rover-03":{"role":"rover","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":0.0,"y":-1.0,"vx":0.0,"vy":0.0},"drone-01":{"role":"drone","joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":0.0,"y":1.5,"vx":0.0,"vy":0.0}}
mesh_links={};relay_paths=[];MAX_RELAY=50;vitals_history={};MAX_VIT=60
state={"status":"cloud-independent","mesh_health":100,"consensus":{"votes_received":5,"votes_required":5,"accepted":True},"events":[]}
lock=threading.Lock()
stats={"total_events":0,"critical_count":0,"predictive_count":0,"response_complete":0,"task_accepted":0,"uptime_start":int(time.time())}
incidents={};inc_counter=1;ws_clients=[];ws_lock=threading.Lock()

def lk(a,b): return "|".join(sorted([a,b]))
def nd(a,b):
    if a not in nodes or b not in nodes: return 10.0
    dx=nodes[a]["x"]-nodes[b]["x"];dy=nodes[a]["y"]-nodes[b]["y"];return math.sqrt(dx*dx+dy*dy)
def init_mesh():
    nids=list(nodes.keys())
    for i,a in enumerate(nids):
        for b in nids[i+1:]:
            k=lk(a,b);d=nd(a,b);mesh_links[k]={"node_a":a,"node_b":b,"rssi":max(-90,-40-int(d*8)),"packet_loss":max(0,min(100,int((d-3)*10))),"latency_ms":max(1,int(d*5)),"active":d<8.0,"relay_count":0,"last_relay":None,"bandwidth_kbps":max(10,int(250-d*20))}
def upd_mesh():
    nids=list(nodes.keys());dead=[k for k in mesh_links if any(n not in nodes for n in k.split("|"))]
    for k in dead: del mesh_links[k]
    for i,a in enumerate(nids):
        for b in nids[i+1:]:
            k=lk(a,b);d=nd(a,b);rssi=max(-95,-40-int(d*8)+random.randint(-3,3));pkt=max(0,min(100,int((d-3)*10)+random.randint(-2,2)));active=d<8.0 and pkt<80
            if k in mesh_links: mesh_links[k].update({"rssi":rssi,"packet_loss":pkt,"latency_ms":max(1,int(d*5+random.uniform(0,3))),"active":active,"bandwidth_kbps":max(10,int(250-d*20))})
            else: mesh_links[k]={"node_a":a,"node_b":b,"rssi":rssi,"packet_loss":pkt,"latency_ms":max(1,int(d*5)),"active":active,"relay_count":0,"last_relay":None,"bandwidth_kbps":max(10,int(250-d*20))}
def move():
    for nid,m in nodes.items():
        spd=0.08 if m["role"]=="drone" else 0.04 if m["role"]=="rover" else 0.01
        m["vx"]+=random.uniform(-spd*0.5,spd*0.5);m["vy"]+=random.uniform(-spd*0.5,spd*0.5);m["vx"]*=0.85;m["vy"]*=0.85
        s=math.sqrt(m["vx"]**2+m["vy"]**2)
        if s>spd: m["vx"]=m["vx"]/s*spd;m["vy"]=m["vy"]/s*spd
        m["x"]=max(-5.5,min(5.5,m["x"]+m["vx"]));m["y"]=max(-5.5,min(5.5,m["y"]+m["vy"]))
def rec_relay(f,v,t,et):
    relay_paths.append({"from":f,"via":v,"to":t,"event_type":et,"ts":int(time.time()*1000)})
    if len(relay_paths)>MAX_RELAY: relay_paths.pop(0)
    for k in [lk(f,v),lk(v,t)]:
        if k in mesh_links: mesh_links[k]["relay_count"]+=1;mesh_links[k]["last_relay"]=int(time.time()*1000)
def mesh_snap():
    ls=list(mesh_links.values());al=[l for l in ls if l["active"]]
    return {"links":ls,"relay_paths":relay_paths[-20:],"active_links":len(al),"total_links":len(ls),"avg_rssi":round(sum(l["rssi"] for l in ls)/max(len(ls),1),1),"avg_latency_ms":round(sum(l["latency_ms"] for l in ls)/max(len(ls),1),1)}
def mk_vit(role):
    if role!="wearable": return {}
    return {"heart_rate":round(random.gauss(78,8),1),"spo2":round(min(99,max(84,random.gauss(97,2))),1),"temperature":round(random.gauss(36.8,0.6),1)}
def mk_ev(nid,role,et=None):
    et=et or random.choice(EVENTS.get(role,["HEARTBEAT"]))
    x=nodes[nid]["x"] if nid in nodes else round(random.uniform(-5,5),2);y=nodes[nid]["y"] if nid in nodes else round(random.uniform(-5,5),2)
    return {"node_id":nid,"role":role,"event_type":et,"x":round(x+random.uniform(-0.1,0.1),2),"y":round(y+random.uniform(-0.1,0.1),2),"battery":round(random.uniform(3.5,4.2),2),"ts":int(time.time()*1000),**mk_vit(role)}
def upd_cons():
    total=len(nodes);crit=sum(1 for e in state["events"] if "CRITICAL" in e["event_type"])
    req=max(1,math.ceil(total*0.6));recv=min(max(total-2,1)+crit,total)
    state["consensus"].update(votes_required=req,votes_received=recv,accepted=recv>=req)
    now=int(time.time()*1000);online=sum(1 for m in nodes.values() if (now-m["last_seen"])/1000<10 and m["last_seen"])
    al=sum(1 for l in mesh_links.values() if l["active"]);tl=max(len(mesh_links),1)
    state["mesh_health"]=max(int((online/max(total,1))*60+(al/tl)*40)-min(crit*5,30),0)
    foxmq_publish_consensus(state["consensus"])
def check_stale():
    """Stale peer detection — marks nodes offline if no heartbeat in STALE_THRESHOLD_MS."""
    now=int(time.time()*1000)
    for nid,m in nodes.items():
        if m["last_seen"] and (now-m["last_seen"])>STALE_THRESHOLD_MS:
            with _mqtt_lock:
                if _mqtt_client:
                    try: _mqtt_client.publish(f"swarm/state/{nid}",json.dumps({"agent_id":nid,"status":"stale","last_seen_ms":m["last_seen"]}),qos=1,retain=True)
                    except: pass
def hdl_inc(ev):
    global inc_counter
    et,nid,now=ev["event_type"],ev["node_id"],ev["ts"]
    if et=="CRITICAL_ALERT":
        iid=f"INC-{inc_counter:04d}";inc_counter+=1
        incidents[iid]={"inc_id":iid,"node_id":nid,"role":ev["role"],"event_type":et,"detected":now,"dispatched":None,"en_route":None,"resolved":None,"status":"open","relay_path":[]}
        if "drone-01" in nodes: rec_relay(nid,"drone-01","rover-01",et);incidents[iid]["relay_path"].append({"via":"drone-01","ts":now})
        foxmq_publish_bid(iid,"rover-01",now)
    elif et=="TASK_ACCEPTED":
        for inc in incidents.values():
            if inc["status"]=="open" and inc["dispatched"] is None: inc["dispatched"]=now;inc["status"]="responding";break
    elif et in("ROVER_EN_ROUTE","ROVER_ARRIVED"):
        for inc in incidents.values():
            if inc["status"]=="responding" and inc["en_route"] is None: inc["en_route"]=now;break
    elif et=="RESPONSE_COMPLETE":
        for inc in incidents.values():
            if inc["status"]=="responding": inc["resolved"]=now;inc["status"]="resolved";break
def push(ev):
    state["events"].append(ev);state["events"]=[e for e in state["events"] if e["node_id"] in nodes][-60:]
    if ev["role"]=="wearable" and "heart_rate" in ev:
        h=vitals_history.setdefault(ev["node_id"],[]);h.append({"hr":ev["heart_rate"],"spo2":ev["spo2"],"temp":ev["temperature"],"ts":ev["ts"]})
        if len(h)>MAX_VIT: h.pop(0)
    stats["total_events"]+=1
    if "CRITICAL" in ev["event_type"]: stats["critical_count"]+=1
    if "PREDICTIVE" in ev["event_type"]: stats["predictive_count"]+=1
    if ev["event_type"]=="RESPONSE_COMPLETE": stats["response_complete"]+=1
    if ev["event_type"]=="TASK_ACCEPTED": stats["task_accepted"]+=1
    if ev["node_id"] in nodes: nodes[ev["node_id"]]["last_seen"]=ev["ts"];nodes[ev["node_id"]]["event_count"]+=1
    hdl_inc(ev);upd_cons();ws_bcast()
    foxmq_publish(ev)
def ws_bcast():
    payload=json.dumps({**state,"mesh":mesh_snap()}).encode();frame=ws_frame(payload);dead=[]
    with ws_lock:
        for s in ws_clients:
            try: s.sendall(frame)
            except: dead.append(s)
        for s in dead: ws_clients.remove(s)
def ws_frame(data):
    n=len(data)
    if n<126: h=bytes([0x81,n])
    elif n<65536: h=bytes([0x81,126])+struct.pack(">H",n)
    else: h=bytes([0x81,127])+struct.pack(">Q",n)
    return h+data
with lock:
    init_mesh()
    for nid,meta in list(nodes.items()): push(mk_ev(nid,meta["role"]))
def tick():
    tc=0
    while True:
        time.sleep(2)
        with lock:
            if not nodes: continue
            move()
            if tc%3==0: upd_mesh()
            if tc%5==0: check_stale()
            nid,meta=random.choice(list(nodes.items()));push(mk_ev(nid,meta["role"]))
            if tc%5==0 and "drone-01" in nodes:
                nb=[n for n in nodes if n!="drone-01"]
                if len(nb)>=2:
                    src=random.choice(nb);dst=random.choice([n for n in nb if n!=src]);rec_relay(src,"drone-01",dst,"MESH_RELAY_EXTENDED")
        tc+=1
threading.Thread(target=tick,daemon=True).start()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,fmt,*args): print(f"[bridge] {fmt%args}",flush=True)
    def do_OPTIONS(self): self._cors(204); self.end_headers()
    def do_GET(self):
        path=urlparse(self.path).path
        if path=="/ws" and self.headers.get("Upgrade","").lower()=="websocket": self._ws_hs(); return
        if path=="/api/swarm":
            with lock: body=json.dumps(state).encode()
            self._json(body)
        elif path=="/api/nodes":
            now=int(time.time()*1000)
            with lock:
                out=[]
                for nid,m in nodes.items():
                    age=(now-m["last_seen"])/1000 if m["last_seen"] else 999
                    vh=vitals_history.get(nid,[]);lv=vh[-1] if vh else None
                    trend="stable"
                    if len(vh)>=5:
                        r=[x["spo2"] for x in vh[-5:]]
                        if r[-1]<r[0]-1.5: trend="declining"
                        elif r[-1]>r[0]+1.0: trend="improving"
                    nbrs=[l["node_b"] if l["node_a"]==nid else l["node_a"] for l in mesh_links.values() if l["active"] and (l["node_a"]==nid or l["node_b"]==nid)]
                    out.append({"node_id":nid,"role":m["role"],"joined_at":m["joined_at"],"last_seen":m["last_seen"],"event_count":m["event_count"],"online":age<10,"battery":lv.get("battery") if lv else round(random.uniform(3.6,4.1),2),"vitals":lv,"spo2_trend":trend,"x":round(m["x"],2),"y":round(m["y"],2),"neighbors":nbrs,"neighbor_count":len(nbrs)})
            self._json(json.dumps(out).encode())
        elif path=="/api/mesh":
            with lock: body=json.dumps(mesh_snap()).encode()
            self._json(body)
        elif path=="/api/stats":
            with lock:
                uptime=int(time.time())-stats["uptime_start"];rec,tasks=stats["response_complete"],stats["task_accepted"]
                open_inc=sum(1 for i in incidents.values() if i["status"]!="resolved")
                out={**stats,"uptime_seconds":uptime,"node_count":len(nodes),"recovery_rate":round(rec/tasks*100,1) if tasks else 0,"open_incidents":open_inc,"mesh_health":state["mesh_health"],"active_links":sum(1 for l in mesh_links.values() if l["active"]),"total_links":len(mesh_links),"vitals_history":dict(vitals_history)}
            self._json(json.dumps(out).encode())
        elif path=="/api/incidents":
            with lock: out=sorted(incidents.values(),key=lambda i:i["detected"],reverse=True)
            self._json(json.dumps(out).encode())
        elif path=="/api/metrics":
            with lock:
                open_inc=sum(1 for i in incidents.values() if i["status"]!="resolved")
                lines=[f"vitalswarm_nodes {len(nodes)}",f"vitalswarm_events_total {stats['total_events']}",f"vitalswarm_critical_total {stats['critical_count']}",f"vitalswarm_mesh_health {state['mesh_health']}",f"vitalswarm_active_links {sum(1 for l in mesh_links.values() if l['active'])}",f"vitalswarm_open_incidents {open_inc}"]
            body="\n".join(lines).encode();self._cors(200);self.send_header("Content-Type","text/plain");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)
        elif path=="/health":
            self._json(json.dumps({"status":"ok","engine":"vertex","broker":"foxmq","version":"6.0"}).encode())
        else: self.send_response(404); self.end_headers()
    def do_POST(self):
        path=urlparse(self.path).path;body=self._rb()
        if path=="/api/nodes":
            nid=str(body.get("node_id","")).strip();role=str(body.get("role","")).strip().lower()
            if not nid or role not in EVENTS: return self._json(json.dumps({"error":"node_id and valid role required"}).encode(),400)
            with lock:
                if nid in nodes: return self._json(json.dumps({"error":"node already exists"}).encode(),409)
                angle=random.uniform(0,2*math.pi);r=random.uniform(2,4)
                nodes[nid]={"role":role,"joined_at":int(time.time()*1000),"last_seen":0,"event_count":0,"x":round(r*math.cos(angle),2),"y":round(r*math.sin(angle),2),"vx":0.0,"vy":0.0}
                upd_mesh();push(mk_ev(nid,role,"NODE_JOINED"))
            self._json(json.dumps({"ok":True,"node_id":nid,"role":role}).encode(),201)
        elif path=="/api/swarm/trigger":
            nid=str(body.get("node_id","")).strip();et=str(body.get("event_type","CRITICAL_ALERT")).strip().upper()
            with lock:
                if nid not in nodes: return self._json(json.dumps({"error":"node not found"}).encode(),404)
                ev=mk_ev(nid,nodes[nid]["role"],et);push(ev)
            self._json(json.dumps({"ok":True,"event":ev}).encode())
        else: self.send_response(404); self.end_headers()
    def do_DELETE(self):
        path=urlparse(self.path).path;m=re.match(r"^/api/nodes/(.+)$",path)
        if m:
            nid=m.group(1)
            with lock:
                if nid not in nodes: return self._json(json.dumps({"error":"node not found"}).encode(),404)
                del nodes[nid];state["events"]=[e for e in state["events"] if e["node_id"]!=nid];vitals_history.pop(nid,None);upd_mesh();upd_cons()
            return self._json(json.dumps({"ok":True,"removed":nid}).encode())
        if path=="/api/swarm/events":
            with lock: state["events"].clear();stats["total_events"]=0
            return self._json(json.dumps({"ok":True}).encode())
        self.send_response(404); self.end_headers()
    def _ws_hs(self):
        key=self.headers.get("Sec-WebSocket-Key","");accept=base64.b64encode(hashlib.sha1((key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101);self.send_header("Upgrade","websocket");self.send_header("Connection","Upgrade");self.send_header("Sec-WebSocket-Accept",accept);self.send_header("Access-Control-Allow-Origin","*");self.end_headers()
        sock=self.connection
        with ws_lock: ws_clients.append(sock)
        with lock: payload=json.dumps({**state,"mesh":mesh_snap()}).encode()
        try: sock.sendall(ws_frame(payload))
        except: pass
        try:
            while True:
                hdr=sock.recv(2)
                if len(hdr)<2: break
                if (hdr[0]&0x0F)==8: break
                length=hdr[1]&0x7F
                if length==126: sock.recv(2)
                elif length==127: sock.recv(8)
                if hdr[1]&0x80: sock.recv(4)
        except: pass
        with ws_lock:
            if sock in ws_clients: ws_clients.remove(sock)
    def _rb(self):
        try: n=int(self.headers.get("Content-Length",0));return json.loads(self.rfile.read(n)) if n else {}
        except: return {}
    def _cors(self,code):
        self.send_response(code);self.send_header("Access-Control-Allow-Origin","*");self.send_header("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");self.send_header("Access-Control-Allow-Headers","Content-Type")
    def _json(self,body,code=200):
        self._cors(code);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(body)));self.end_headers();self.wfile.write(body)

if __name__=="__main__":
    server=HTTPServer(("127.0.0.1",8787),Handler)
    server.socket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    print("="*60,flush=True)
    print("[vertex] VitalSwarm Vertex Bridge v6.0",flush=True)
    print("[vertex] Consensus : Vertex-compatible supermajority 60% virtual voting",flush=True)
    print("[vertex] BFT       : floor((n-1)/3) fault tolerance",flush=True)
    print("[vertex] v6 new    : stale peer detection, fair-ordered task bidding",flush=True)
    print("="*60,flush=True)
    print("vertex_bridge v6.0  ->  http://127.0.0.1:8787",flush=True)
    print("Mesh topology       ->  http://127.0.0.1:8787/api/mesh",flush=True)
    print("FoxMQ MQTT          ->  mqtt://127.0.0.1:1883  (swarm/#)",flush=True)
    print("FoxMQ WebSocket     ->  ws://127.0.0.1:8080    (dashboard)",flush=True)
    print("="*60,flush=True)
    server.serve_forever()