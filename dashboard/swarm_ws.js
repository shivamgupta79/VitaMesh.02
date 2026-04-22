/* ── VitalSwarm · swarm_ws.js  v6.0 ──────────────────────────────────────
   Data flow:
     ESP32 firmware → ESP-NOW broadcast → (real HW: serial bridge)
     Python bridge simulates swarm → REST + WebSocket → this file
     FoxMQ MQTT broker (Vertex-backed) → MQTT-over-WebSockets → this file
     This file polls /api/swarm, /api/nodes, /api/stats, /api/incidents, /api/mesh
     and renders: map, mesh topology, vitals, log, incidents, manage nodes

   New in v5:
     - Mesh topology tab: animated link quality, RSSI, latency, relay paths
     - Mesh canvas: separate 60fps render with link strength coloring
     - Node positions from bridge (persistent, smoothly animated)
     - Neighbor count in node table
     - Relay path history visualization

   FoxMQ integration (v5.1):
     - Subscribes to swarm/# via MQTT-over-WebSockets on ws://127.0.0.1:8080
     - CRITICAL_ALERT events arrive via swarm/alert/<node_id> (QoS 2)
     - Consensus snapshots arrive via swarm/consensus (retained)
     - Falls back to REST polling if FoxMQ is not running
──────────────────────────────────────────────────────────────────────────── */
const API    = 'http://127.0.0.1:8787';
const WS_URL = 'ws://127.0.0.1:8787/ws';

// ── FoxMQ MQTT-over-WebSockets ────────────────────────────────────────────
// Requires: FoxMQ running with --websockets --allow-anonymous-login
// Install mqtt.js via CDN (added in index.html) or npm.
// Topic schema:
//   swarm/state/<node_id>    → heartbeat / vitals
//   swarm/alert/<node_id>    → CRITICAL_ALERT / PREDICTIVE_ALERT
//   swarm/consensus          → consensus snapshot (retained)
//   swarm/relay/<drone_id>   → MESH_RELAY_EXTENDED
//   swarm/ordered/<node_id>  → Vertex-consensus-ordered events
const FOXMQ_WS_URL = 'ws://127.0.0.1:8080';
let foxmqClient = null;

function connectFoxMQ() {
  // mqtt.js must be loaded — we load it lazily from CDN
  if (typeof mqtt === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
    s.onload = () => _initFoxMQ();
    document.head.appendChild(s);
  } else {
    _initFoxMQ();
  }
}

function _initFoxMQ() {
  try {
    foxmqClient = mqtt.connect(FOXMQ_WS_URL, {
      protocolVersion: 5,
      clientId: 'vitalswarm-dashboard-' + Math.random().toString(16).slice(2, 8),
      reconnectPeriod: 5000,
      connectTimeout: 4000,
    });

    foxmqClient.on('connect', () => {
      console.log('[foxmq] Connected to FoxMQ broker via WebSocket');
      const badge = document.getElementById('foxmqBadge');
      if (badge) { badge.className = 'badge badge-ok'; badge.innerHTML = '<span class="pulse"></span>FoxMQ Live'; }
      foxmqClient.subscribe('swarm/#', { qos: 1 });
      showToast('FoxMQ connected — BFT-ordered events active', 'ok');
    });

    foxmqClient.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        _handleFoxMQMessage(topic, data);
      } catch (e) { /* ignore malformed */ }
    });

    foxmqClient.on('error', (err) => {
      console.warn('[foxmq] Error:', err.message, '— falling back to REST polling');
    });

    foxmqClient.on('offline', () => {
      console.warn('[foxmq] Broker offline — REST polling active');
    });
  } catch (e) {
    console.warn('[foxmq] Could not connect:', e.message);
  }
}

function _handleFoxMQMessage(topic, data) {
  if (topic === 'swarm/consensus') {
    // Update consensus ring directly from FoxMQ retained message
    if (data.votes_received !== undefined) {
      if (lastData) {
        lastData.consensus = data;
        updateConsensus(lastData);
      }
    }
    return;
  }

  if (topic.startsWith('swarm/alert/') || topic.startsWith('swarm/state/') ||
      topic.startsWith('swarm/relay/') || topic.startsWith('swarm/ordered/')) {
    // Inject the event into the live log immediately (no poll wait)
    if (data.event_type && data.node_id) {
      renderEvents([data]);
      // Trigger a full pull to sync all state
      pull();
    }
  }
}

// Kick off FoxMQ connection after DOM is ready
window.addEventListener('load', () => setTimeout(connectFoxMQ, 500));

const FALLBACK = {
  status:'cloud-independent', mesh_health:80,
  consensus:{votes_received:5,votes_required:7,accepted:false},
  events:[
    {node_id:'wearable-01',role:'wearable',event_type:'CRITICAL_ALERT',   x:-2.0,y:3.0,battery:3.9,heart_rate:88,spo2:89,temperature:38.7,ts:Date.now()},
    {node_id:'rover-01',   role:'rover',   event_type:'TASK_ACCEPTED',    x:-3.0,y:0.0,battery:3.8,ts:Date.now()},
    {node_id:'rover-02',   role:'rover',   event_type:'PATH_BLOCKED',     x: 3.0,y:0.0,battery:3.8,ts:Date.now()},
    {node_id:'drone-01',   role:'drone',   event_type:'DRONE_RELAY_ACTIVE',x:0.0,y:1.5,battery:3.7,ts:Date.now()},
  ],
};

const SCENARIOS = [
  { id:'mass_casualty', icon:'🚨', name:'Mass Casualty',
    desc:'All wearables fire CRITICAL_ALERT. Rovers scramble. Drone relays.',
    steps:[{delay:0,events:[{n:'wearable-01',e:'CRITICAL_ALERT'},{n:'wearable-02',e:'CRITICAL_ALERT'},{n:'wearable-03',e:'CRITICAL_ALERT'}]},
           {delay:3,events:[{n:'rover-01',e:'TASK_ACCEPTED'},{n:'rover-02',e:'TASK_ACCEPTED'}]},
           {delay:5,events:[{n:'drone-01',e:'MESH_RELAY_EXTENDED'}]},
           {delay:9,events:[{n:'rover-01',e:'RESPONSE_COMPLETE'}]}]},
  { id:'network_split', icon:'📡', name:'Network Split',
    desc:'Drone bridges two disconnected segments. Rovers reroute.',
    steps:[{delay:0,events:[{n:'drone-01',e:'DRONE_RELAY_ACTIVE'}]},
           {delay:3,events:[{n:'rover-01',e:'PATH_BLOCKED'},{n:'rover-02',e:'ROVER_EN_ROUTE'}]},
           {delay:6,events:[{n:'drone-01',e:'MESH_RELAY_EXTENDED'}]},
           {delay:9,events:[{n:'rover-03',e:'TASK_ACCEPTED'}]}]},
  { id:'low_battery', icon:'🔋', name:'Low Battery Alert',
    desc:'Wearable battery critical. Nearest rover dispatched for kit drop.',
    steps:[{delay:0,events:[{n:'wearable-02',e:'CRITICAL_ALERT'}]},
           {delay:3,events:[{n:'rover-02',e:'TASK_ACCEPTED'}]},
           {delay:7,events:[{n:'rover-02',e:'ROVER_EN_ROUTE'}]},
           {delay:12,events:[{n:'rover-02',e:'RESPONSE_COMPLETE'}]}]},
  { id:'full_recovery', icon:'🏁', name:'Full Recovery',
    desc:'All rovers complete missions. Swarm returns to standby.',
    steps:[{delay:0,events:[{n:'rover-01',e:'RESPONSE_COMPLETE'},{n:'rover-02',e:'RESPONSE_COMPLETE'},{n:'rover-03',e:'RESPONSE_COMPLETE'}]},
           {delay:3,events:[{n:'wearable-01',e:'VITALS_UPDATE'},{n:'wearable-02',e:'VITALS_UPDATE'},{n:'wearable-03',e:'VITALS_UPDATE'}]},
           {delay:6,events:[{n:'drone-01',e:'DRONE_RELAY_ACTIVE'}]}]},
];

const ROLE_COLOR = {wearable:'#00d4c8', rover:'#f59e0b', drone:'#10b981'};
const ROLE_GLOW  = {wearable:'rgba(0,212,200,.4)', rover:'rgba(245,158,11,.4)', drone:'rgba(16,185,129,.4)'};
const ROLE_ICON  = {wearable:'🩺', rover:'🚗', drone:'🚁'};
const CIRC = 2 * Math.PI * 42;
const HIST = 30;

let lastData       = null;
let lastStats      = null;
let lastNodes      = [];
let lastMesh       = null;
let logFilter      = 'all';
let lastEventTs    = 0;
let activeScenario = null;
let wsConn         = null;
let wsRetries      = 0;
const actHist      = Array(HIST).fill(0);
const quickAddCounters = {wearable:4, rover:4, drone:2};

const $       = id => document.getElementById(id);
const setText = (id,v) => { const e=$(id); if(e && e.textContent!==String(v)) e.textContent=v; };
const sev     = t => t.includes('CRITICAL')?'critical':t.includes('BLOCKED')||t.includes('WARN')||t.includes('PREDICTIVE')?'warn':'normal';
const dotCol  = t => sev(t)==='critical'?'#ff3d5a':sev(t)==='warn'?'#f59e0b':'#10b981';
const battCol = v => v>=3.9?'#10b981':v>=3.6?'#f59e0b':'#ff3d5a';
const battPct = v => Math.min(((v-3.3)/(4.2-3.3))*100,100).toFixed(0);
const fmtTime = s => { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; };
const rssiColor = r => r>=-60?'#10b981':r>=-75?'#f59e0b':'#ff3d5a';

/* ── KPI strip ── */
const KPI_DEFS = [
  {id:'kpiNodes',    label:'Nodes',       sub:'in swarm',      icon:'🌐', kc:'var(--accent2)'},
  {id:'kpiOnline',   label:'Online',      sub:'active',        icon:'✅', kc:'var(--ok)'},
  {id:'kpiAlerts',   label:'Alerts',      sub:'critical',      icon:'⚠️', kc:'var(--danger)'},
  {id:'kpiConsensus',label:'Consensus',   sub:'votes',         icon:'🗳️', kc:'var(--accent)'},
  {id:'kpiBattery',  label:'Avg Battery', sub:'volts',         icon:'🔋', kc:'var(--warn)'},
  {id:'kpiMesh',     label:'Mesh Health', sub:'connectivity',  icon:'📡', kc:'var(--ok)'},
  {id:'kpiIncidents',label:'Incidents',   sub:'open',          icon:'🚑', kc:'var(--danger)'},
  {id:'kpiPredictive',label:'Predictive', sub:'early warnings',icon:'🔮', kc:'var(--accent3)'},
];
(function buildKPIs(){
  const strip=$('kpiStrip');
  KPI_DEFS.forEach(k=>{
    const d=document.createElement('div'); d.className='kpi'; d.style.setProperty('--kc',k.kc);
    d.innerHTML=`<div class="kpi-label">${k.label}</div><div class="kpi-value" id="${k.id}">—</div><div class="kpi-sub">${k.sub}</div><div class="kpi-icon">${k.icon}</div>`;
    strip.appendChild(d);
  });
})();

function updateKPIs(data,stats){
  const events=data.events||[];
  const unique=new Map(); events.forEach(e=>unique.set(e.node_id,e));
  const nodes=[...unique.values()];
  const alerts=events.filter(e=>e.event_type.includes('CRITICAL')).length;
  const avgB=nodes.length?nodes.reduce((s,n)=>s+n.battery,0)/nodes.length:0;
  const predictive=events.filter(e=>e.event_type==='PREDICTIVE_ALERT').length;
  const openInc=stats?.open_incidents??0;
  setText('kpiNodes',    nodes.length);
  setText('kpiOnline',   nodes.length);
  setText('kpiAlerts',   alerts);
  setText('kpiConsensus',`${data.consensus.votes_received}/${data.consensus.votes_required}`);
  setText('kpiBattery',  avgB.toFixed(2)+'V');
  setText('kpiMesh',     (data.mesh_health??100)+'%');
  setText('kpiIncidents',openInc);
  setText('kpiPredictive',predictive);
  const ae=$('kpiAlerts'); if(ae) ae.style.color=alerts>0?'var(--danger)':'var(--text)';
  const mi=$('kpiMesh'); if(mi) mi.style.color=(data.mesh_health??100)<60?'var(--danger)':(data.mesh_health??100)<80?'var(--warn)':'var(--ok)';
  const ii=$('kpiIncidents'); if(ii) ii.style.color=openInc>0?'var(--danger)':'var(--text)';
}

/* ── Theme ── */
function toggleTheme(){
  const html=document.documentElement, dark=html.getAttribute('data-theme')!=='light';
  html.setAttribute('data-theme',dark?'light':'dark');
  $('btnTheme').textContent=dark?'🌙':'☀️';
}

/* ── Tabs ── */
function switchTab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${name}`));
  if(name==='vitals'&&lastStats) renderVitals(lastStats.vitals_history||{});
  if(name==='incidents') fetch(`${API}/api/incidents`).then(r=>r.json()).then(renderIncidents).catch(()=>{});
  if(name==='mesh'&&lastMesh) renderMeshTab(lastMesh);
}

/* ── Toast ── */
let toastT=null;
function showToast(msg,type='ok'){
  const el=$('toast'); el.textContent=(type==='ok'?'✓ ':'✕ ')+msg; el.className=`show ${type}`;
  clearTimeout(toastT); toastT=setTimeout(()=>el.className='',3000);
}

/* ── Alert banner ── */
let lastAlertNode=null;
function dismissAlert(){ $('alertBanner').classList.remove('show'); lastAlertNode=null; }
function updateAlertBanner(events){
  const crit=(events||[]).filter(e=>e.event_type.includes('CRITICAL'));
  if(!crit.length) return;
  const latest=crit[crit.length-1];
  if(latest.node_id===lastAlertNode) return;
  lastAlertNode=latest.node_id;
  setText('alertTitle',`🚨 CRITICAL — ${latest.node_id}`);
  setText('alertDesc', `${latest.event_type.replaceAll('_',' ')} · (${latest.x.toFixed(1)}, ${latest.y.toFixed(1)})`);
  $('alertBanner').classList.add('show');
}

/* ── Modals ── */
function handleOverlay(e,id){ if(e.target===$(id)) closeModal(id); }
function closeModal(id){ $(id).classList.remove('open'); }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') document.querySelectorAll('.modal-overlay.open').forEach(m=>m.classList.remove('open')); });

function openTriggerModal(){
  const sel=$('triggerNodeId'); sel.innerHTML='';
  lastNodes.forEach(n=>{ const o=document.createElement('option'); o.value=n.node_id; o.textContent=n.node_id; sel.appendChild(o); });
  $('triggerModal').classList.add('open');
}
async function submitTrigger(){
  const node_id=$('triggerNodeId').value, event_type=$('triggerEventType').value;
  try{
    const res=await fetch(`${API}/api/swarm/trigger`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node_id,event_type})});
    const j=await res.json();
    if(res.ok){ closeModal('triggerModal'); showToast(`${event_type} → ${node_id}`,'ok'); pull(); }
    else showToast(j.error||'Trigger failed','err');
  }catch{ showToast('Bridge unreachable','err'); }
}

/* ── Scenarios ── */
function buildScenarioGrid(){
  const grid=$('scenarioGrid'); if(!grid) return;
  SCENARIOS.forEach(sc=>{
    const card=document.createElement('div'); card.className='scenario-card'; card.id=`sc-${sc.id}`;
    card.innerHTML=`<div class="scenario-icon">${sc.icon}</div><div class="scenario-name">${sc.name}</div><div class="scenario-desc">${sc.desc}</div>`;
    card.onclick=()=>runScenario(sc); grid.appendChild(card);
  });
}
async function runScenario(sc){
  if(activeScenario){ showToast('Scenario already running','err'); return; }
  activeScenario=sc.id;
  document.querySelectorAll('.scenario-card').forEach(c=>c.classList.remove('active'));
  $(`sc-${sc.id}`)?.classList.add('active');
  showToast(`▶ ${sc.name} started`,'ok'); switchTab('overview');
  for(const step of sc.steps){
    await new Promise(r=>setTimeout(r,step.delay*1000));
    for(const ev of step.events){
      try{ await fetch(`${API}/api/swarm/trigger`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node_id:ev.n,event_type:ev.e})}); }catch{}
    }
    await pull();
  }
  setTimeout(()=>{ activeScenario=null; document.querySelectorAll('.scenario-card').forEach(c=>c.classList.remove('active')); showToast(`✓ ${sc.name} complete`,'ok'); },2000);
}

/* ── Log ── */
function setFilter(f){
  logFilter=f;
  document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===f));
  document.querySelectorAll('.event-item').forEach(el=>el.classList.toggle('hidden',f!=='all'&&(el.dataset.sev||'normal')!==f));
}
async function clearLog(){
  if(!confirm('Clear all events?')) return;
  try{ await fetch(`${API}/api/swarm/events`,{method:'DELETE'}); $('eventLog').innerHTML=''; lastEventTs=0; showToast('Log cleared','ok'); }
  catch{ showToast('Bridge unreachable','err'); }
}
function exportLog(){
  const rows=[['Time','Event','Node','X','Y','Battery']];
  [...$('eventLog').querySelectorAll('.event-item:not(.hidden)')].forEach(el=>{
    const type=el.querySelector('.event-type')?.textContent||'';
    const meta=(el.querySelector('.event-meta')?.textContent||'').split('·');
    rows.push([el.querySelector('.event-time')?.textContent||'',type.trim(),(meta[0]||'').trim(),(meta[1]||'').trim(),(meta[2]||'').trim()]);
  });
  const csv=rows.map(r=>r.map(c=>`"${c}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=`vitalswarm-log-${Date.now()}.csv`; a.click(); showToast('Exported CSV','ok');
}

/* ── Consensus ring ── */
function updateConsensus(data){
  const {votes_received:got,votes_required:need}=data.consensus;
  const pct=Math.min(Math.round((got/Math.max(need,1))*100),100);
  const color=pct>=100?'var(--ok)':pct>=60?'var(--accent)':'var(--danger)';
  const ring=$('ringFill'),lbl=$('ringPct');
  if(ring){ring.style.strokeDashoffset=CIRC-(pct/100)*CIRC;ring.style.stroke=color;}
  if(lbl){lbl.textContent=pct+'%';lbl.style.color=color;}
  setText('cVotes',got); setText('cRequired',need);
}

/* ── Node roster (overview) ── */
function renderNodeRoster(events){
  const unique=new Map(); events.forEach(e=>unique.set(e.node_id,e));
  const nodes=[...unique.values()];
  setText('rosterCount',`${nodes.length} node${nodes.length!==1?'s':''}`);
  const list=$('nodeList');
  const existing=new Map([...list.querySelectorAll('[data-node]')].map(el=>[el.dataset.node,el]));
  const seen=new Set();
  nodes.forEach(n=>{
    seen.add(n.node_id);
    const isAlert=n.event_type.includes('CRITICAL');
    const bPct=battPct(n.battery),bCol=battCol(n.battery);
    const color=ROLE_COLOR[n.role]||'#aaa',glow=ROLE_GLOW[n.role]||'transparent';
    let el=existing.get(n.node_id);
    if(!el){
      el=document.createElement('div'); el.className='node-item'; el.dataset.node=n.node_id;
      el.innerHTML=`<div class="node-dot"></div><div class="node-info"><div class="node-name">${n.node_id}</div><div class="node-evt"></div></div><div class="node-meta"><span class="role-pill role-${n.role}">${n.role}</span><div class="batt-bar"><div class="batt-fill"></div></div></div><button class="remove-btn" onclick="removeNode('${n.node_id}')">✕</button>`;
      list.appendChild(el);
    }
    el.classList.toggle('alert',isAlert);
    el.querySelector('.node-dot').style.cssText=`background:${color};box-shadow:0 0 5px ${glow}`;
    el.querySelector('.node-evt').textContent=n.event_type.replaceAll('_',' ');
    el.querySelector('.batt-fill').style.cssText=`width:${bPct}%;background:${bCol}`;
  });
  existing.forEach((el,id)=>{ if(!seen.has(id)) el.remove(); });
  nodes.forEach(n=>{ const el=list.querySelector(`[data-node="${n.node_id}"]`); if(el) list.appendChild(el); });
}

/* ── Node table (Nodes tab) ── */
function renderNodeTable(nodeList){
  lastNodes=nodeList;
  const body=$('nodeTableBody');
  const existing=new Map([...body.querySelectorAll('[data-node]')].map(el=>[el.dataset.node,el]));
  const seen=new Set();
  nodeList.forEach(n=>{
    seen.add(n.node_id);
    const bPct=battPct(n.battery??3.8),bCol=battCol(n.battery??3.8);
    const color=ROLE_COLOR[n.role]||'#aaa',glow=ROLE_GLOW[n.role]||'transparent';
    const lastSeen=n.last_seen?new Date(n.last_seen).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
    const isAlert=n.vitals&&(n.vitals.spo2<92||n.vitals.temp>38.5);
    let el=existing.get(n.node_id);
    if(!el){
      el=document.createElement('div'); el.className='node-row'; el.dataset.node=n.node_id;
      el.innerHTML=`<div class="node-id-cell"><div class="node-dot"></div><span>${n.node_id}</span></div><div><span class="role-pill role-${n.role}">${n.role}</span></div><div class="status-cell"></div><div class="batt-cell"><div class="batt-bar" style="width:52px"><div class="batt-fill"></div></div><span class="batt-txt"></span></div><div style="font-size:12px;font-family:var(--font-mono)" class="evt-count"></div><div style="font-size:12px;font-family:var(--font-mono);color:var(--accent)" class="nbr-count"></div><div style="font-size:11px;color:var(--muted);font-family:var(--font-mono)" class="last-seen"></div><button class="remove-btn" onclick="removeNode('${n.node_id}')">✕</button>`;
      body.appendChild(el);
    }
    el.classList.toggle('alert',!!isAlert);
    el.querySelector('.node-dot').style.cssText=`background:${color};box-shadow:0 0 4px ${glow}`;
    el.querySelector('.status-cell').innerHTML=`<span class="online-dot" style="background:${n.online?'var(--ok)':'var(--muted)'}"></span>${n.online?'Online':'Idle'}`;
    el.querySelector('.batt-fill').style.cssText=`width:${bPct}%;background:${bCol}`;
    el.querySelector('.batt-txt').textContent=(n.battery??'—')+'V';
    el.querySelector('.evt-count').textContent=n.event_count??'—';
    el.querySelector('.nbr-count').textContent=(n.neighbor_count??'—')+' nbr';
    el.querySelector('.last-seen').textContent=lastSeen;
  });
  existing.forEach((el,id)=>{ if(!seen.has(id)) el.remove(); });
  nodeList.forEach(n=>{ const el=body.querySelector(`[data-node="${n.node_id}"]`); if(el) body.appendChild(el); });
}

/* ── Vitals charts ── */
function renderVitals(history){
  const grid=$('vitalsGrid');
  const wearables=Object.keys(history);
  if(!wearables.length){ grid.innerHTML='<p style="color:var(--muted);padding:20px">No wearable vitals yet.</p>'; return; }
  wearables.forEach(nid=>{
    const readings=history[nid]||[],latest=readings[readings.length-1]||{};
    let card=grid.querySelector(`[data-vitals="${nid}"]`);
    if(!card){
      card=document.createElement('div'); card.className='vitals-card'; card.dataset.vitals=nid;
      card.innerHTML=`<div class="vitals-card-hdr"><div class="vitals-card-title">💓 ${nid}</div><span class="role-pill role-wearable">wearable</span></div><div class="vitals-stats"><div class="vstat"><div class="vstat-val" style="color:#ff3d5a" id="hr-${nid}">—</div><div class="vstat-lbl">Heart Rate</div></div><div class="vstat"><div class="vstat-val" style="color:var(--accent)" id="spo2-${nid}">—</div><div class="vstat-lbl">SpO₂ %</div></div><div class="vstat"><div class="vstat-val" style="color:var(--warn)" id="temp-${nid}">—</div><div class="vstat-lbl">Temp °C</div></div></div><div class="vitals-chart-wrap"><canvas class="vitals-canvas" height="80"></canvas></div>`;
      grid.appendChild(card);
    }
    if(latest.hr)   setText(`hr-${nid}`,  latest.hr.toFixed(0));
    if(latest.spo2) setText(`spo2-${nid}`, latest.spo2.toFixed(1)+'%');
    if(latest.temp) setText(`temp-${nid}`, latest.temp.toFixed(1)+'°');
    drawVitalsChart(card.querySelector('.vitals-canvas'),readings);
  });
}
function drawVitalsChart(canvas,readings){
  if(!canvas||!readings.length) return;
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width,h=rect.height; ctx.clearRect(0,0,w,h);
  const drawLine=(vals,color)=>{
    if(vals.length<2) return;
    const max=Math.max(...vals,1),min=Math.min(...vals,0),range=max-min||1;
    const step=w/(vals.length-1);
    const pts=vals.map((v,i)=>({x:i*step,y:h-(((v-min)/range)*(h-8))-4}));
    const grad=ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0,color+'44'); grad.addColorStop(1,color+'00');
    ctx.beginPath(); ctx.moveTo(pts[0].x,h);
    pts.forEach(p=>ctx.lineTo(p.x,p.y));
    ctx.lineTo(pts[pts.length-1].x,h); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
    ctx.beginPath(); pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
    ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.stroke();
  };
  drawLine(readings.map(r=>r.hr),'#ff3d5a');
  drawLine(readings.map(r=>r.spo2),'#00d4c8');
  ctx.setTransform(1,0,0,1,0,0);
}

/* ── Event log ── */
function renderEvents(events){
  setText('logCount',`${events.length} event${events.length!==1?'s':''}`);
  const log=$('eventLog');
  const newEvs=events.filter(e=>e.ts>lastEventTs);
  if(newEvs.length) lastEventTs=Math.max(...newEvs.map(e=>e.ts));
  newEvs.slice().reverse().forEach(e=>{
    const s=sev(e.event_type),col=dotCol(e.event_type);
    const time=new Date(e.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const div=document.createElement('div');
    div.className=`event-item ${s}`; div.dataset.sev=s;
    if(logFilter!=='all'&&s!==logFilter) div.classList.add('hidden');
    div.innerHTML=`<div class="event-dot" style="background:${col};box-shadow:0 0 4px ${col}"></div><div class="event-body"><div class="event-type ${s}">${e.event_type.replaceAll('_',' ')}</div><div class="event-meta">${e.node_id} · (${e.x.toFixed(1)}, ${e.y.toFixed(1)}) · ${e.battery.toFixed(2)}V</div></div><div class="event-time">${time}</div>`;
    log.prepend(div);
  });
  while(log.children.length>60) log.lastChild.remove();
}

/* ── Swarm map (rAF, uses node positions from bridge) ── */
function renderMap(events){
  const canvas=$('swarmMap'); if(!canvas) return;
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  const cw=Math.round(rect.width*dpr),ch=Math.round(rect.height*dpr);
  if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
  const ctx=canvas.getContext('2d');
  const w=rect.width,h=rect.height;
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  // Grid
  ctx.strokeStyle='rgba(255,255,255,0.035)'; ctx.lineWidth=1;
  for(let x=0;x<w;x+=55){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for(let y=0;y<h;y+=55){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.setLineDash([3,5]);
  ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w/2,h);ctx.stroke();
  ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
  ctx.setLineDash([]);
  const unique=new Map(); events.forEach(e=>unique.set(e.node_id,e));
  const nodes=[...unique.values()];
  const toS=(x,y)=>({px:w/2+x*50,py:h/2-y*40});
  // Mesh lines — use link quality if available
  if(lastMesh&&lastMesh.links){
    lastMesh.links.forEach(link=>{
      const na=nodes.find(n=>n.node_id===link.node_a);
      const nb=nodes.find(n=>n.node_id===link.node_b);
      if(!na||!nb||!link.active) return;
      const pa=toS(na.x,na.y),pb=toS(nb.x,nb.y);
      const alpha=Math.max(0.05, Math.min(0.4, (link.rssi+90)/50));
      const col=rssiColor(link.rssi);
      ctx.strokeStyle=col.replace(')',`,${alpha})`).replace('rgb','rgba'); ctx.lineWidth=1.5;
      ctx.beginPath();ctx.moveTo(pa.px,pa.py);ctx.lineTo(pb.px,pb.py);ctx.stroke();
    });
  } else {
    nodes.forEach((a,i)=>nodes.slice(i+1).forEach(b=>{
      const pa=toS(a.x,a.y),pb=toS(b.x,b.y);
      const dist=Math.hypot(pa.px-pb.px,pa.py-pb.py);
      const alpha=Math.max(0.03,0.12-dist/2000);
      ctx.strokeStyle=`rgba(0,212,200,${alpha})`; ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(pa.px,pa.py);ctx.lineTo(pb.px,pb.py);ctx.stroke();
    }));
  }
  const now=Date.now();
  nodes.forEach(n=>{
    const {px,py}=toS(n.x,n.y),color=ROLE_COLOR[n.role]||'#aaa';
    const isAlert=n.event_type.includes('CRITICAL');
    if(isAlert){
      const r=18+6*Math.sin(now/220);
      ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,61,90,${0.08+0.1*Math.sin(now/220)})`;ctx.fill();
    }
    const g=ctx.createRadialGradient(px,py,0,px,py,14);
    g.addColorStop(0,color+'50');g.addColorStop(1,'transparent');
    ctx.beginPath();ctx.arc(px,py,14,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    ctx.beginPath();ctx.arc(px,py,6,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=1.5;ctx.stroke();
    const isDark=document.documentElement.getAttribute('data-theme')!=='light';
    ctx.fillStyle=isDark?'#c8ddf0':'#1a2535';
    ctx.font='500 10px Inter,sans-serif';
    ctx.fillText(n.node_id,px+10,py+3);
    ctx.beginPath();ctx.arc(px+10+ctx.measureText(n.node_id).width+4,py,2.5,0,Math.PI*2);
    ctx.fillStyle=battCol(n.battery);ctx.fill();
  });
  ctx.setTransform(1,0,0,1,0,0);
}

/* ── Activity sparkline ── */
function renderActivity(events){
  actHist.push(events.length); if(actHist.length>HIST) actHist.shift();
  const canvas=$('activityChart'); if(!canvas) return;
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const w=rect.width,h=rect.height; ctx.clearRect(0,0,w,h);
  const max=Math.max(...actHist,1),step=w/(HIST-1);
  const pts=actHist.map((v,i)=>({x:i*step,y:h-(v/max)*(h-10)-5}));
  const grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'rgba(0,212,200,0.2)');grad.addColorStop(1,'rgba(0,212,200,0)');
  ctx.beginPath();ctx.moveTo(pts[0].x,h);
  pts.forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.lineTo(pts[pts.length-1].x,h);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));
  ctx.strokeStyle='#00d4c8';ctx.lineWidth=2;ctx.stroke();
  const last=pts[pts.length-1];
  ctx.beginPath();ctx.arc(last.x,last.y,3.5,0,Math.PI*2);ctx.fillStyle='#00d4c8';ctx.fill();
  ctx.setTransform(1,0,0,1,0,0);
}

/* ══════════════════════════════════════════════════════════════════════════
   MESH TAB — topology canvas + link list + relay paths
══════════════════════════════════════════════════════════════════════════ */
function renderMeshTab(mesh){
  if(!mesh) return;
  lastMesh=mesh;
  // Stats
  setText('msActiveLinks', mesh.active_links??'—');
  setText('msTotalLinks',  mesh.total_links??'—');
  setText('msAvgRssi',     (mesh.avg_rssi??'—')+'dBm');
  setText('msAvgLatency',  (mesh.avg_latency_ms??'—')+'ms');
  setText('msMeshHealth',  (lastData?.mesh_health??'—')+'%');
  const totalRelays=(mesh.links||[]).reduce((s,l)=>s+(l.relay_count||0),0);
  setText('msRelayCount',  totalRelays);
  // Link list
  renderLinkList(mesh.links||[]);
  // Relay paths
  renderRelayPaths(mesh.relay_paths||[]);
  // Canvas
  renderMeshCanvas(mesh);
}

function renderLinkList(links){
  const list=$('linkList'); if(!list) return;
  const sorted=[...links].sort((a,b)=>b.rssi-a.rssi);
  list.innerHTML=sorted.map(l=>`
    <div class="link-item ${l.active?'active':'inactive'}">
      <div class="link-header">
        <span class="link-nodes">${l.node_a} ↔ ${l.node_b}</span>
        <span class="link-badge ${l.active?'active':'inactive'}">${l.active?'Active':'Inactive'}</span>
      </div>
      <div class="link-metrics">
        <div class="lm"><div class="lm-val" style="color:${rssiColor(l.rssi)}">${l.rssi}</div><div class="lm-lbl">RSSI dBm</div></div>
        <div class="lm"><div class="lm-val">${l.latency_ms}ms</div><div class="lm-lbl">Latency</div></div>
        <div class="lm"><div class="lm-val">${l.packet_loss}%</div><div class="lm-lbl">Pkt Loss</div></div>
      </div>
    </div>`).join('');
}

function renderRelayPaths(paths){
  const list=$('relayList'); if(!list) return;
  setText('relayCount',`${paths.length} relay${paths.length!==1?'s':''}`);
  list.innerHTML=[...paths].reverse().slice(0,15).map(r=>{
    const time=new Date(r.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return `<div class="relay-item">
      <span style="font-family:var(--font-mono);font-size:11px">${r.from}</span>
      <span class="relay-arrow">→</span>
      <span class="relay-via">${r.via}</span>
      <span class="relay-arrow">→</span>
      <span style="font-family:var(--font-mono);font-size:11px">${r.to}</span>
      <span class="relay-time">${time}</span>
    </div>`;
  }).join('');
}

function renderMeshCanvas(mesh){
  const canvas=$('meshCanvas'); if(!canvas) return;
  const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
  const cw=Math.round(rect.width*dpr),ch=Math.round(rect.height*dpr);
  if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
  const ctx=canvas.getContext('2d');
  const w=rect.width,h=rect.height;
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  // Grid
  ctx.strokeStyle='rgba(255,255,255,0.03)'; ctx.lineWidth=1;
  for(let x=0;x<w;x+=60){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for(let y=0;y<h;y+=60){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  // Build node position map from lastNodes
  const nodePos={};
  lastNodes.forEach(n=>{ nodePos[n.node_id]={x:n.x??0,y:n.y??0,role:n.role,online:n.online}; });
  const toS=(x,y)=>({px:w/2+x*48,py:h/2-y*38});
  // Draw links with quality coloring
  (mesh.links||[]).forEach(link=>{
    const na=nodePos[link.node_a], nb=nodePos[link.node_b];
    if(!na||!nb) return;
    const pa=toS(na.x,na.y),pb=toS(nb.x,nb.y);
    if(!link.active){
      ctx.strokeStyle='rgba(255,61,90,0.15)'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
    } else {
      const alpha=Math.max(0.15,Math.min(0.7,(link.rssi+90)/50));
      const col=rssiColor(link.rssi);
      ctx.strokeStyle=col; ctx.globalAlpha=alpha; ctx.lineWidth=2; ctx.setLineDash([]);
    }
    ctx.beginPath();ctx.moveTo(pa.px,pa.py);ctx.lineTo(pb.px,pb.py);ctx.stroke();
    ctx.globalAlpha=1; ctx.setLineDash([]);
    // RSSI label on link midpoint
    if(link.active){
      const mx=(pa.px+pb.px)/2,my=(pa.py+pb.py)/2;
      ctx.fillStyle=rssiColor(link.rssi);
      ctx.font='bold 9px JetBrains Mono,monospace';
      ctx.fillText(`${link.rssi}dBm`,mx-14,my-4);
    }
  });
  // Draw nodes
  const now=Date.now();
  Object.entries(nodePos).forEach(([nid,n])=>{
    const {px,py}=toS(n.x,n.y);
    const color=ROLE_COLOR[n.role]||'#aaa';
    // Outer glow
    const g=ctx.createRadialGradient(px,py,0,px,py,20);
    g.addColorStop(0,color+'40');g.addColorStop(1,'transparent');
    ctx.beginPath();ctx.arc(px,py,20,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    // Node circle
    ctx.beginPath();ctx.arc(px,py,9,0,Math.PI*2);
    ctx.fillStyle=n.online?color:'#555';ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=2;ctx.stroke();
    // Role icon text
    ctx.fillStyle='rgba(0,0,0,0.8)';ctx.font='bold 11px sans-serif';
    ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText(ROLE_ICON[n.role]||'?',px,py);
    ctx.textAlign='left';ctx.textBaseline='alphabetic';
    // Label
    const isDark=document.documentElement.getAttribute('data-theme')!=='light';
    ctx.fillStyle=isDark?'#c8ddf0':'#1a2535';
    ctx.font='600 11px Inter,sans-serif';
    ctx.fillText(nid,px+13,py+4);
    // Online indicator
    ctx.beginPath();ctx.arc(px+8,py-8,4,0,Math.PI*2);
    ctx.fillStyle=n.online?'#10b981':'#ff3d5a';ctx.fill();
  });
  ctx.setTransform(1,0,0,1,0,0);
}

/* ── Incidents ── */
function renderIncidents(incData){
  const list=$('incidentList'); if(!list) return;
  if(!incData||!incData.length){
    list.innerHTML='<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px">No incidents recorded yet.</div>'; return;
  }
  list.innerHTML=incData.slice(0,20).map(inc=>{
    const steps=[
      {label:'Detected',  val:inc.detected   ?new Date(inc.detected).toLocaleTimeString()  :null},
      {label:'Dispatched',val:inc.dispatched  ?new Date(inc.dispatched).toLocaleTimeString():null},
      {label:'En Route',  val:inc.en_route    ?new Date(inc.en_route).toLocaleTimeString()  :null},
      {label:'Resolved',  val:inc.resolved    ?new Date(inc.resolved).toLocaleTimeString()  :null},
    ];
    const sc=inc.status==='open'?'open':inc.status==='responding'?'responding':'resolved';
    return `<div class="incident-card ${sc}">
      <div class="inc-header"><span class="inc-id">${inc.inc_id}</span><span class="inc-status ${sc}">${inc.status.toUpperCase()}</span></div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px"><strong style="color:var(--text)">${inc.node_id}</strong> &middot; ${inc.event_type.replaceAll('_',' ')} &middot; ${inc.role}</div>
      <div class="inc-timeline">${steps.map(s=>`<div class="inc-step ${s.val?'done':''}"><div class="inc-step-label">${s.label}</div><div class="inc-step-val">${s.val||'&mdash;'}</div></div>`).join('')}</div>
    </div>`;
  }).join('');
}

/* ── Predictive alerts ── */
const predictiveAlerted=new Set();
function checkPredictiveAlerts(events){
  const byNode=new Map();
  events.filter(e=>e.role==='wearable'&&e.spo2).forEach(e=>{
    if(!byNode.has(e.node_id)) byNode.set(e.node_id,[]);
    byNode.get(e.node_id).push(e.spo2);
  });
  byNode.forEach((readings,nid)=>{
    if(readings.length<3) return;
    const recent=readings.slice(-5);
    const key=`${nid}-${Math.floor(Date.now()/30000)}`;
    if(recent[recent.length-1]<recent[0]-1.5&&!predictiveAlerted.has(key)){
      predictiveAlerted.add(key);
      showToast(`⚠️ Predictive: ${nid} SpO₂ declining`,'err');
    }
  });
}

/* ── Manage Nodes ── */
async function removeNode(node_id){
  if(!confirm(`Remove ${node_id} from the swarm?`)) return;
  try{
    const res=await fetch(`${API}/api/nodes/${encodeURIComponent(node_id)}`,{method:'DELETE'});
    if(res.ok){ showToast(`${node_id} removed`,'ok'); pull(); }
    else{ const j=await res.json(); showToast(j.error||'Remove failed','err'); }
  }catch{ showToast('Bridge unreachable','err'); }
}
async function mnAddNode(nodeIdOverride,roleOverride){
  const node_id=(nodeIdOverride||$('mnNodeId')?.value||'').trim();
  const role=roleOverride||$('mnRole')?.value||'wearable';
  const errEl=$('mnErr');
  if(!node_id){ if(errEl) errEl.textContent='Node ID is required.'; return; }
  if(errEl) errEl.textContent='';
  try{
    const res=await fetch(`${API}/api/nodes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({node_id,role})});
    const j=await res.json();
    if(!res.ok){ if(errEl) errEl.textContent=j.error||'Failed.'; showToast(j.error||'Failed','err'); return; }
    if($('mnNodeId')) $('mnNodeId').value='';
    showToast(`${node_id} joined the swarm`,'ok'); await pull();
  }catch{ if(errEl) errEl.textContent='Bridge unreachable.'; showToast('Bridge unreachable','err'); }
}
function mnQuickAdd(role){
  const num=String(quickAddCounters[role]).padStart(2,'0');
  quickAddCounters[role]++;
  mnAddNode(`${role}-${num}`,role);
}
async function mnRemoveAll(){
  if(!lastNodes.length){ showToast('No nodes to remove','err'); return; }
  if(!confirm(`Remove all ${lastNodes.length} nodes?`)) return;
  for(const n of [...lastNodes]){
    try{ await fetch(`${API}/api/nodes/${encodeURIComponent(n.node_id)}`,{method:'DELETE'}); }catch{}
  }
  showToast('All nodes removed','ok'); await pull();
}
function renderManageTab(nodeList){
  const grid=$('mnNodeCards'),empty=$('mnEmpty'),count=$('mnCount');
  if(!grid) return;
  if(count) count.textContent=`${nodeList.length} node${nodeList.length!==1?'s':''}`;
  if(!nodeList.length){ grid.innerHTML=''; if(empty) empty.style.display='block'; return; }
  if(empty) empty.style.display='none';
  const existing=new Map([...grid.querySelectorAll('[data-mn]')].map(el=>[el.dataset.mn,el]));
  const seen=new Set();
  nodeList.forEach(n=>{
    seen.add(n.node_id);
    const bPct=battPct(n.battery??3.8),bCol=battCol(n.battery??3.8);
    const online=n.online,isAlert=n.vitals&&(n.vitals.spo2<92||n.vitals.temp>38.5);
    const lastSeen=n.last_seen?new Date(n.last_seen).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Never';
    let el=existing.get(n.node_id);
    if(!el){
      el=document.createElement('div'); el.className='node-card'; el.dataset.mn=n.node_id;
      el.innerHTML=`<div class="node-card-top"><div class="node-card-icon ${n.role}">${ROLE_ICON[n.role]||'📡'}</div><button class="node-card-remove" onclick="removeNode('${n.node_id}')">✕</button></div><div class="node-card-id">${n.node_id}</div><div class="node-card-role">${n.role}</div><div class="node-card-stats"><div class="nc-stat"><div class="nc-stat-val evt-c">—</div><div class="nc-stat-lbl">Events</div></div><div class="nc-stat"><div class="nc-stat-val nbr-c" style="color:var(--accent)">—</div><div class="nc-stat-lbl">Neighbors</div></div></div><div class="node-card-batt"><div class="node-card-batt-label"><span>Battery</span><span class="batt-pct-txt"></span></div><div class="node-card-batt-bar"><div class="node-card-batt-fill"></div></div></div><div class="node-card-status"><div class="status-dot"></div><span class="status-txt"></span><span style="margin-left:auto;font-size:9px;font-family:var(--font-mono)" class="last-seen-txt"></span></div>`;
      grid.appendChild(el);
    }
    el.classList.toggle('alert-card',!!isAlert);
    el.querySelector('.evt-c').textContent=n.event_count??'—';
    el.querySelector('.nbr-c').textContent=(n.neighbor_count??'—');
    el.querySelector('.batt-pct-txt').textContent=bPct+'%';
    el.querySelector('.node-card-batt-fill').style.cssText=`width:${bPct}%;background:${bCol}`;
    el.querySelector('.status-dot').style.background=online?'var(--ok)':'var(--muted)';
    el.querySelector('.status-txt').textContent=online?'Online':'Idle';
    el.querySelector('.last-seen-txt').textContent=lastSeen;
  });
  existing.forEach((el,id)=>{ if(!seen.has(id)) el.remove(); });
  nodeList.forEach(n=>{ const el=grid.querySelector(`[data-mn="${n.node_id}"]`); if(el) grid.appendChild(el); });
}
document.addEventListener('DOMContentLoaded',()=>{
  const inp=$('mnNodeId'); if(inp) inp.addEventListener('keydown',e=>{ if(e.key==='Enter') mnAddNode(); });
});

/* ── Mesh badge ── */
function updateMeshBadge(live){
  const b=$('meshBadge'); if(!b) return;
  b.className=live?'badge badge-ok':'badge badge-warn';
  b.innerHTML=live?'<span class="pulse"></span>Mesh Active':'<span class="pulse warn"></span>Fallback';
}

/* ── Main render ── */
function render(data,live,stats){
  lastData=data; lastStats=stats;
  updateMeshBadge(live);
  updateKPIs(data,stats);
  updateAlertBanner(data.events||[]);
  updateConsensus(data);
  renderNodeRoster(data.events||[]);
  renderEvents(data.events||[]);
  renderActivity(data.events||[]);
  checkPredictiveAlerts(data.events||[]);
  const el=$('lastUpdate'); if(el) el.textContent=new Date().toLocaleTimeString();
  // Update mesh tab if active
  if(document.querySelector('#tab-mesh.active')&&lastMesh) renderMeshTab(lastMesh);
}

/* ── rAF loops ── */
(function mapLoop(){ if(lastData) renderMap(lastData.events||[]); requestAnimationFrame(mapLoop); })();
(function meshLoop(){
  if(document.querySelector('#tab-mesh.active')&&lastMesh) renderMeshCanvas(lastMesh);
  requestAnimationFrame(meshLoop);
})();

/* ── WebSocket ── */
function connectWS(){
  try{
    wsConn=new WebSocket(WS_URL);
    wsConn.onopen=()=>{ wsRetries=0; };
    wsConn.onmessage=msg=>{
      try{
        const d=JSON.parse(msg.data);
        if(d.events) render(d,true,lastStats);
        if(d.mesh){ lastMesh=d.mesh; if(document.querySelector('#tab-mesh.active')) renderMeshTab(d.mesh); }
      }catch{}
    };
    wsConn.onclose=()=>{ wsConn=null; if(wsRetries<3){ wsRetries++; setTimeout(connectWS,3000); } };
    wsConn.onerror=()=>{ wsConn?.close(); };
  }catch{}
}

/* ── Poll ── */
async function pull(){
  // Each endpoint is fetched independently so one failure doesn't break the others
  let data = null, nodeList = null, stats = null, incData = null, mesh = null;

  try {
    const r = await fetch(`${API}/api/swarm`);
    data = await r.json();
  } catch(e) { showToast('Swarm endpoint unreachable','err'); }

  try {
    const r = await fetch(`${API}/api/nodes`);
    nodeList = await r.json();
  } catch(e) { showToast('Nodes endpoint unreachable','err'); }

  try {
    const r = await fetch(`${API}/api/stats`);
    stats = await r.json();
  } catch(e) { /* stats non-critical, no toast */ }

  try {
    const r = await fetch(`${API}/api/incidents`);
    incData = await r.json();
  } catch(e) { /* incidents non-critical */ }

  try {
    const r = await fetch(`${API}/api/mesh`);
    mesh = await r.json();
  } catch(e) { /* mesh non-critical */ }

  if (data) {
    if (mesh) lastMesh = mesh;
    render(data, true, stats);
  } else {
    render(FALLBACK, false, null);
  }
  if (nodeList) {
    renderNodeTable(nodeList);
    renderManageTab(nodeList);
  }
  if (stats && document.querySelector('#tab-vitals.active')) renderVitals(stats.vitals_history||{});
  if (incData && document.querySelector('#tab-incidents.active')) renderIncidents(incData);
  if (mesh && document.querySelector('#tab-mesh.active')) renderMeshTab(mesh);
}

/* ── Init ── */
buildScenarioGrid();
connectWS();
pull();
setInterval(pull,3000);
window.addEventListener('resize',()=>{ if(lastData){renderMap(lastData.events||[]);renderActivity(lastData.events||[]);} if(lastMesh) renderMeshCanvas(lastMesh); });
