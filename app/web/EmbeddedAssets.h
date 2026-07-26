#pragma once

// Single-file SPA served from the embedded WebServer. Mirrors desktop tabs:
// Player / Mixer / Builder (read) / Settings. Zero Node at runtime.

namespace resoset {
namespace embedded_assets {

inline constexpr const char* kIndexHtml = R"HTML(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<title>ResoStage</title>
<style>
:root{--bg:#0b0d10;--panel:#141820;--border:#243041;--text:#e8eef7;--muted:#8b9bb0;--accent:#5b8cff;--play:#3dd68c;--stop:#ff5c7a;--alarm:#ff3b30;--warn:#ffb020;--meter:#3dd68c;--meter-bg:#1c2430}
*{box-sizing:border-box}html,body{margin:0;padding:0;height:100%;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
body{display:flex;flex-direction:column;min-height:100%}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--panel);flex-wrap:wrap}
header h1{font-size:14px;margin:0;letter-spacing:.06em;text-transform:uppercase}
.tabs{display:flex;gap:6px;flex:1}
.tabs button{appearance:none;border:1px solid var(--border);background:#1a2230;color:var(--muted);border-radius:8px;padding:8px 12px;font-weight:600;font-size:13px;cursor:pointer}
.tabs button.active{background:var(--accent);color:#fff;border-color:transparent}
#conn{font-size:12px;color:var(--muted)}#conn.ok{color:var(--play)}#conn.bad{color:var(--stop)}
#alarm{display:none;background:var(--alarm);color:#fff;text-align:center;padding:8px;font-weight:700}
#alarm.show{display:block}
main{flex:1;padding:12px;max-width:1100px;width:100%;margin:0 auto}
.panel{display:none}.panel.active{display:block}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:12px}
.card h2{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
#playhead{font-variant-numeric:tabular-nums;font-size:36px;font-weight:700;margin:4px 0 8px}
#status-row{display:flex;flex-wrap:wrap;gap:8px 14px;color:var(--muted);font-size:13px}
#status-row .playing{color:var(--play);font-weight:700}#status-row .stopped{color:var(--stop);font-weight:700}
.transport{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}
button.act{appearance:none;border:1px solid var(--border);background:#1a2230;color:var(--text);border-radius:10px;padding:14px 8px;font-size:14px;font-weight:600;cursor:pointer}
button.act.primary{background:var(--play);color:#062416;border-color:transparent}
button.act.danger{background:#3a1820;color:var(--stop);border-color:#5a2430}
#songs{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}
#songs li{display:flex;justify-content:space-between;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;margin-bottom:4px;border:1px solid transparent}
#songs li:hover{background:#1a2230}#songs li.active{background:#1a2740;border-color:var(--accent)}
#songs .meta{color:var(--muted);font-size:12px;white-space:nowrap}
.meter-row{display:grid;grid-template-columns:100px 1fr 80px;gap:8px;align-items:center;margin-bottom:8px;font-size:13px}
.bar{height:12px;background:var(--meter-bg);border-radius:6px;overflow:hidden}
.bar>span{display:block;height:100%;width:0%;background:linear-gradient(90deg,#2f9e6b,var(--meter));transition:width 50ms linear}
.meter-val{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px}
.mix-grid{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}
.strip{min-width:88px;background:#10151d;border:1px solid var(--border);border-radius:10px;padding:8px;text-align:center}
.strip .name{font-size:12px;font-weight:700;margin-bottom:4px;word-break:break-word}
.strip .sub{font-size:10px;color:var(--muted);margin-bottom:6px}
.strip .fader{height:120px;width:14px;margin:0 auto 6px;background:var(--meter-bg);border-radius:4px;position:relative}
.strip .fader>i{position:absolute;left:0;right:0;bottom:0;background:var(--accent);border-radius:4px}
.badge{display:inline-block;font-size:10px;padding:2px 6px;border-radius:4px;background:#1a2230;color:var(--muted);margin:1px}
.badge.on{background:var(--warn);color:#000}
#health{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px}
#health .kv{background:#10151d;border-radius:8px;padding:10px}
#health .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
#health .v{font-size:16px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
.builder pre{white-space:pre-wrap;font-size:12px;color:var(--muted);margin:0;line-height:1.45}
footer{text-align:center;color:var(--muted);font-size:11px;padding:10px}
</style>
</head>
<body>
<header>
  <h1>ResoStage</h1>
  <div class="tabs">
    <button class="tab active" data-tab="player">Player</button>
    <button class="tab" data-tab="mixer">Mixer</button>
    <button class="tab" data-tab="builder">Builder</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>
  <div id="conn" class="bad">connecting…</div>
</header>
<div id="alarm">AUDIO DEVICE DISCONNECTED</div>
<main>
  <section id="panel-player" class="panel active">
    <div class="card">
      <h2 id="project-name">No project</h2>
      <div id="playhead">00:00.000</div>
      <div id="status-row">
        <span id="run-state" class="stopped">STOPPED</span>
        <span id="song-label">—</span>
        <span id="bpm-label"></span>
        <span id="drift-label"></span>
      </div>
      <div class="transport">
        <button class="act" id="btn-prev">Prev</button>
        <button class="act primary" id="btn-play">Play</button>
        <button class="act danger" id="btn-stop">Stop</button>
        <button class="act" id="btn-next">Next</button>
      </div>
    </div>
    <div class="card"><h2>Setlist</h2><ul id="songs"></ul></div>
    <div class="card"><h2>Bus meters</h2><div id="meters"></div></div>
  </section>
  <section id="panel-mixer" class="panel">
    <div class="card"><h2>Tracks</h2><div class="mix-grid" id="mix-tracks"></div></div>
    <div class="card"><h2>Busses</h2><div class="mix-grid" id="mix-busses"></div></div>
  </section>
  <section id="panel-builder" class="panel">
    <div class="card"><h2>Project structure (live read-only)</h2><pre id="builder-view">Load a project on the desktop app.</pre></div>
  </section>
  <section id="panel-settings" class="panel">
    <div class="card"><h2>System health</h2>
      <div id="health">
        <div class="kv"><div class="k">CPU</div><div class="v" id="h-cpu">—</div></div>
        <div class="kv"><div class="k">RAM (RSS)</div><div class="v" id="h-rss">—</div></div>
        <div class="kv"><div class="k">Free RAM</div><div class="v" id="h-free">—</div></div>
        <div class="kv"><div class="k">Underruns</div><div class="v" id="h-underruns">0</div></div>
        <div class="kv"><div class="k">Audio callbacks</div><div class="v" id="h-cb">0</div></div>
        <div class="kv"><div class="k">Web clients</div><div class="v" id="h-clients">0</div></div>
      </div>
    </div>
    <div class="card"><h2>Remote</h2>
      <p style="color:var(--muted);font-size:13px;margin:0">This page is the stage remote for the desktop ResoStage app. Transport, mixer meters, and project structure update live over WebSocket. Edit structure on the desktop Builder tab.</p>
    </div>
  </section>
</main>
<footer>ResoStage remote · mirrors desktop state</footer>
<script>
(function(){
const $=id=>document.getElementById(id);
let ws=null,reconnectMs=500,lastSongKey="",activeTab="player";
function fmtTime(sec){if(!isFinite(sec)||sec<0)sec=0;const m=Math.floor(sec/60);const s=sec-m*60;return String(m).padStart(2,"0")+":"+s.toFixed(3).padStart(6,"0")}
function fmtBytes(n){if(!n||n<=0)return"0 B";const u=["B","KB","MB","GB"];let i=0,v=n;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(i===0?0:1)+" "+u[i]}
function peakNorm(db){return Math.max(0,Math.min(1,(db+60)/60))}
async function post(path,body){try{await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):"{}"})}catch(e){}}
$("btn-play").onclick=()=>post("/api/v1/transport/play");
$("btn-stop").onclick=()=>post("/api/v1/transport/stop");
$("btn-next").onclick=()=>post("/api/v1/transport/next");
$("btn-prev").onclick=()=>post("/api/v1/transport/prev");
document.querySelectorAll(".tab").forEach(btn=>{
  btn.onclick=()=>{
    activeTab=btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("active",b===btn));
    document.querySelectorAll(".panel").forEach(p=>p.classList.toggle("active",p.id==="panel-"+activeTab));
  };
});
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))}
function renderSongs(state){
  const key=(state.songs||[]).map(s=>s.name+"|"+s.bpm).join(";")+"|"+state.songIndex;
  if(key===lastSongKey){
    $("songs").querySelectorAll("li").forEach((li,i)=>li.classList.toggle("active",i===state.songIndex));
    return;
  }
  lastSongKey=key;
  const ul=$("songs");ul.innerHTML="";
  (state.songs||[]).forEach((s,i)=>{
    const li=document.createElement("li");
    if(i===state.songIndex)li.classList.add("active");
    li.innerHTML="<span>"+(i+1)+". "+escapeHtml(s.name)+"</span><span class='meta'>"+(s.bpm||0).toFixed(1)+" bpm · "+(s.mode==="auto"?"auto":"wait")+"</span>";
    li.onclick=()=>post("/api/v1/transport/select",{index:i});
    ul.appendChild(li);
  });
}
function renderMeters(meters){
  const root=$("meters");
  if(!meters||!meters.length){root.innerHTML="<div style='color:var(--muted)'>No busses</div>";return}
  const ids=meters.map(m=>m.id).join(",");
  if(root.dataset.ids!==ids){
    root.dataset.ids=ids;
    root.innerHTML=meters.map((m,i)=>"<div class='meter-row' data-i='"+i+"'><div>"+escapeHtml(m.id)+"</div><div class='bar'><span></span></div><div class='meter-val'></div></div>").join("");
  }
  meters.forEach((m,i)=>{
    const row=root.querySelector("[data-i='"+i+"']");if(!row)return;
    row.querySelector("span").style.width=(peakNorm(m.peakDb)*100).toFixed(1)+"%";
    row.querySelector(".meter-val").textContent=(m.peakDb??-144).toFixed(1)+" dB";
  });
}
function faderH(db){return Math.max(4,Math.min(100,((db+60)/72)*100))}
function renderMix(state){
  const tracks=state.tracks||[];
  const busses=state.busses||[];
  const tr=$("mix-tracks");
  tr.innerHTML=tracks.length?tracks.map(t=>"<div class='strip'><div class='name'>"+escapeHtml(t.name||t.id)+"</div><div class='sub'>→ "+escapeHtml(t.busId||"")+"</div><div class='fader'><i style='height:"+faderH(t.gainDb||0)+"%'></i></div><div>"+(t.peakDb!=null?t.peakDb.toFixed(1):"—")+" dB</div><div>"+(t.mute?"<span class='badge on'>M</span>":"<span class='badge'>M</span>")+(t.solo?"<span class='badge on'>S</span>":"<span class='badge'>S</span>")+"</div><div class='sub'>"+(t.sends||0)+" send(s)</div></div>").join(""):"<div style='color:var(--muted)'>No tracks</div>";
  const bu=$("mix-busses");
  bu.innerHTML=busses.length?busses.map(b=>"<div class='strip'><div class='name'>"+escapeHtml(b.name||b.id)+"</div><div class='sub'>"+(b.isAux?"AUX · ":"")+"ch "+(b.startChannel??0)+"</div><div class='fader'><i style='height:"+faderH(b.gainDb||0)+"%'></i></div><div>"+(b.peakDb!=null?b.peakDb.toFixed(1):"—")+" dB</div><div>"+(b.mute?"<span class='badge on'>M</span>":"<span class='badge'>M</span>")+(b.solo?"<span class='badge on'>S</span>":"<span class='badge'>S</span>")+"</div></div>").join(""):"<div style='color:var(--muted)'>No busses</div>";
}
function renderBuilder(state){
  const lines=[];
  lines.push("Project: "+(state.projectName||"—"));
  lines.push("Songs: "+(state.songCount||0)+"   current: "+(state.songIndex??-1));
  (state.songs||[]).forEach((s,i)=>{
    lines.push((i===state.songIndex?"▶ ":"  ")+(i+1)+". "+s.name+"  "+(s.bpm||0).toFixed(1)+" bpm  "+(s.mode==="auto"?"auto":"wait"));
  });
  lines.push("");
  lines.push("Tracks ("+((state.tracks||[]).length)+"):");
  (state.tracks||[]).forEach(t=>{
    lines.push("  · "+(t.name||t.id)+" → "+(t.busId||"?")+"  "+(t.gainDb||0).toFixed(1)+" dB"+(t.mute?" [M]":"")+(t.solo?" [S]":"")+"  sends:"+(t.sends||0));
  });
  lines.push("");
  lines.push("Busses ("+((state.busses||[]).length)+"):");
  (state.busses||[]).forEach(b=>{
    lines.push("  · "+(b.name||b.id)+(b.isAux?" [AUX]":"")+"  out "+(b.startChannel??0)+"  "+(b.gainDb||0).toFixed(1)+" dB");
  });
  $("builder-view").textContent=lines.join("\n");
}
function applyState(state){
  $("project-name").textContent=state.projectName||"No project";
  $("playhead").textContent=fmtTime(state.playheadSeconds||0);
  const running=!!state.playing;
  const rs=$("run-state");rs.textContent=running?"PLAYING":"STOPPED";rs.className=running?"playing":"stopped";
  $("song-label").textContent=state.songName?("Song: "+state.songName):"No song selected";
  $("bpm-label").textContent=state.bpm?(state.bpm.toFixed(1)+" bpm"):"";
  $("drift-label").textContent=state.drift?("drift ×"+Number(state.drift).toFixed(5)):"";
  $("alarm").classList.toggle("show",!!state.hardwareAlarm);
  renderSongs(state);renderMeters(state.meters||[]);renderMix(state);renderBuilder(state);
  const h=state.health||{};
  $("h-cpu").textContent=(h.cpuPercent!=null?h.cpuPercent.toFixed(1):"—")+" %";
  $("h-rss").textContent=fmtBytes(h.rssBytes||0);
  $("h-free").textContent=fmtBytes(h.freeBytes||0);
  $("h-underruns").textContent=String(h.underrunCount||0);
  $("h-cb").textContent=String(h.audioCallbackCount||0);
  $("h-clients").textContent=String(h.webClientCount||0);
}
function connect(){
  const proto=location.protocol==="https:"?"wss:":"ws:";
  ws=new WebSocket(proto+"//"+location.host+"/ws","resoset");
  ws.onopen=()=>{reconnectMs=500;$("conn").textContent="live";$("conn").className="ok"};
  ws.onclose=()=>{$("conn").textContent="reconnecting…";$("conn").className="bad";setTimeout(connect,reconnectMs);reconnectMs=Math.min(reconnectMs*1.5,4000)};
  ws.onerror=()=>{try{ws.close()}catch(_){}};
  ws.onmessage=ev=>{try{applyState(JSON.parse(ev.data))}catch(_){}};
}
connect();
})();
</script>
</body>
</html>
)HTML";

inline constexpr const char* kIndexHtmlMime = "text/html; charset=utf-8";

} // namespace embedded_assets
} // namespace resoset
