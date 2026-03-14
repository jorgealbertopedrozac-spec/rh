import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Supabase (fijo para GitHub Pages)
const SUPABASE_URL = 'https://rbtpusdauvnaszyluptt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJidHB1c2RhdXZuYXN6eWx1cHR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMDc2ODYsImV4cCI6MjA4ODY4MzY4Nn0.Tt9TNXvFtVmo3hdmskKg7PhVn5uDk12ulVSBKLpMHtw';

// ---------------------------
// Globals / State
// ---------------------------
const LS_LOGO_MODE = 'limsa_logo_mode'; // full | icon
const LS_LOGO_BG = 'limsa_logo_bg';     // white | none

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let connected = false;
let currentSession = null;
let currentUserEmail = '';

let empleados = [];
let selectedEmpleado = null;
let gratificacionesGlobal = [];
let tiempoExtraGlobal = [];

// Mobile navigation context: when opening an employee from another tab,
// remember where we came from so "← Volver" returns the user there.
let empNavContext = null; // { fromTab: string, scrollY: number }

const MOBILE_BREAKPOINT = 520; // iPhone 16 normal (393px) comfortably fits

function isMobileNarrow(){
  return window.matchMedia(`(max-width:${MOBILE_BREAKPOINT}px)`).matches;
}

function openEmpOverlay(title='Detalle'){
  const ov = document.getElementById('empOverlay');
  if(!ov) return;
  document.getElementById('empOverlayTitle').textContent = title;
  ov.classList.add('show');
  ov.setAttribute('aria-hidden','false');
  document.body.classList.add('no-scroll');

  // Enable browser back to close overlay (mobile UX).
  try{
    if(history.state?.empOverlay !== true){
      history.pushState({ ...(history.state||{}), empOverlay:true }, '');
    }
  }catch(_){/* ignore */}
}

function closeEmpOverlay(){
  const ov = document.getElementById('empOverlay');
  if(!ov) return;
  ov.classList.remove('show');
  ov.setAttribute('aria-hidden','true');
  document.body.classList.remove('no-scroll');
}

function closeEmpOverlayAndReturn({ viaHistory=false } = {}){
  closeEmpOverlay();

  // Return user to the originating tab on mobile (Gratificaciones / Tiempo Extra)
  // and restore scroll position.
  if(empNavContext?.fromTab && empNavContext.fromTab !== 'personal'){
    const { fromTab, scrollY } = empNavContext;
    empNavContext = null;
    setTimeout(()=>{
      goToTab(fromTab);
      setTimeout(()=> window.scrollTo(0, scrollY || 0), 40);
    }, 0);
  } else {
    empNavContext = null;
  }

  // If the overlay was opened with a pushed history state, let browser back close it.
  if(!viaHistory){
    try{
      if(history.state?.empOverlay === true) history.back();
    }catch(_){/* ignore */}
  }
}

function requestCloseEmpOverlay(){
  // Prefer history-back so iOS Safari back gesture behaves naturally.
  try{
    if(history.state?.empOverlay === true){
      history.back();
      return;
    }
  }catch(_){/* ignore */}
  closeEmpOverlayAndReturn({ viaHistory:false });
}

function getActiveTab(){
  return document.querySelector('.tab.active')?.dataset?.tab || 'personal';
}

function goToTab(tab){
  const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
  if(btn) btn.click();
}

const BODS = ["AI","AC","AS","AT","AM","AL","AB","AG","AA","AD","AH","AJ","CI","CR","CC","CS","CT","CM","CL","CB","CG","CD","CH","CJ"];
const PUESTOS = ["1er SUPERVISOR","2DO SUPERVISOR","AUXILIAR","AUXILIAR M","CHOFER"];
const LOCALIZA = ["AGS","FORANEO"];
const ESTATUS = ["Activo","Baja","Incapacidad"];
const PROGRAMAS = [
  { value:'unicaViernes', label:'Única (viernes de esa semana)' },
  { value:'segundaSemanaViernes', label:'2ª semana del mes (viernes)' },
  { value:'cadaSemanaViernes', label:'Cada semana (viernes)' },
];

function programaFromLabel(label){
  const t = (label||'').trim();
  const hit = PROGRAMAS.find(p => p.label === t || p.value === t);
  if(hit) return hit.value;
  // tolerancia
  const low = t.toLowerCase();
  if(low.includes('única') || low.includes('unica')) return 'unicaViernes';
  if(low.includes('2') && low.includes('semana')) return 'segundaSemanaViernes';
  if(low.includes('cada') && low.includes('semana')) return 'cadaSemanaViernes';
  return 'segundaSemanaViernes';
}

function normalizeName(s=''){
  return String(s)
    .trim()
    .replace(/\s+/g,' ')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();
}

// ---------------------------
// DOM helpers
// ---------------------------
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str=''){
  return String(str)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

function fmtMoney(n){
  const v = Number(n||0);
  return v.toLocaleString('es-MX', { style:'currency', currency:'MXN' });
}

// IMPORTANT: Supabase `date` columns are returned as 'YYYY-MM-DD'.
// In browsers, `new Date('YYYY-MM-DD')` is parsed as UTC midnight, which in
// America/Mexico_City becomes the previous day evening, breaking reports.
// Always parse date-only strings as *local* dates.
function parseDateLocal(d){
  if(!d) return null;
  if(d instanceof Date) return d;
  if(typeof d === 'string'){
    const s = d.trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(s)){
      const [y,m,day] = s.split('-').map(Number);
      return new Date(y, m-1, day);
    }
  }
  const dt = new Date(d);
  return isNaN(dt) ? null : dt;
}

function fmtDateISO(d){
  if(!d) return '';
  const dt = parseDateLocal(d);
  if(!dt) return '';
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const day = String(dt.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function fmtDateDMY(d){
  const dt = parseDateLocal(d);
  if(!dt) return '';
  const dd = String(dt.getDate()).padStart(2,'0');
  const mm = String(dt.getMonth()+1).padStart(2,'0');
  const yy = dt.getFullYear();
  return `${dd}-${mm}-${yy}`;
}

function fmtDateHuman(d){
  if(!d) return '—';
  const dt = parseDateLocal(d);
  if(!dt) return '—';
  return dt.toLocaleDateString('es-MX', { year:'numeric', month:'short', day:'2-digit' });
}

function empOf(row){
  // Prefer locally cached empleados (works even if no FK join exists)
  const id = row?.empleado_id;
  if(id && Array.isArray(empleados)){
    const hit = empleados.find(e=>e.id===id);
    if(hit) return hit;
  }
  // Backward compatibility if some queries used embedded joins
  return row?.empleados || {};
}


function toast(msg, kind='ok'){
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  Object.assign(el.style, {
    position:'fixed', bottom:'16px', left:'50%', transform:'translateX(-50%)',
    background:'rgba(15,22,32,.92)', border:'1px solid rgba(255,255,255,.12)',
    color:'white', padding:'10px 12px', borderRadius:'12px', zIndex:9999,
    boxShadow:'0 12px 40px rgba(0,0,0,.35)'
  });
  document.body.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s'; }, 2000);
  setTimeout(()=> el.remove(), 2400);
}

// ---------------------------
// Employee picker (for creating Gratificaciones / TE from global tabs)
// ---------------------------
async function pickEmpleado({ title='Selecciona empleado', onPick } = {}){
  if(!connected){ toast('Inicia sesión', 'bad'); return; }
  if(!empleados || empleados.length===0){
    try{ empleados = await fetchEmpleados(); }catch(err){ toast('No se pudo cargar empleados', 'bad'); return; }
  }

  const dlg = $('#dlg');
  dlg.innerHTML = `
    <form method="dialog" class="modalContent">
      <div class="modalHeader">
        <h3>${escapeHtml(title)}</h3>
        <button class="iconBtn" value="cancel" aria-label="Cerrar">✕</button>
      </div>
      <div class="field">
        <label>Buscar</label>
        <input id="pickEmpQ" class="input" placeholder="Nombre o nómina…" />
      </div>
      <div id="pickEmpList" class="list" style="max-height:55vh;overflow:auto"></div>
      <div class="hint">Tip: escribe parte del nombre o la nómina.</div>
    </form>
  `;
  dlg.showModal();

  const qEl = $('#pickEmpQ', dlg);
  const listEl = $('#pickEmpList', dlg);

  function render(){
    const q = (qEl.value||'').trim().toLowerCase();
    let list = empleados;
    if(q){
      list = list.filter(e=>{
        const hay = `${e.nomina||''} ${e.nombre||''} ${e.bod||''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    listEl.innerHTML = '';
    for(const e of list.slice(0, 200)){
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div class="meta">
          <div class="name">#${escapeHtml(e.nomina)} — ${escapeHtml(e.nombre)}</div>
          <div class="sub">BOD ${escapeHtml(e.bod||'—')} • ${escapeHtml(e.puesto||'—')} • ${escapeHtml(e.estatus||'—')}</div>
        </div>
        <div class="badges"><span class="badge">Elegir</span></div>
      `;
      row.addEventListener('click', ()=>{
        dlg.close();
        onPick?.(e);
      });
      listEl.appendChild(row);
    }
    if(list.length===0){
      listEl.innerHTML = `<div class="emptyState"><div class="emoji">👤</div><div><div class="emptyTitle">Sin resultados</div><div class="emptySub">Prueba otro texto.</div></div></div>`;
    }
  }

  qEl.addEventListener('input', render);
  render();
}

// ---------------------------
// Supabase init
// ---------------------------
function setConnStatus(){
  const pill = $('#connStatus');
  const email = $('#userEmail');
  const btnLogout = $('#btnLogout');

  if(connected){
    pill.textContent = 'Sesión activa';
    pill.classList.add('ok');
    pill.classList.remove('bad');
    if(email) email.textContent = currentUserEmail || '';
    if(btnLogout) btnLogout.classList.remove('hidden');
  } else {
    pill.textContent = 'Sin sesión';
    pill.classList.remove('ok');
    pill.classList.add('bad');
    if(email) email.textContent = '';
    if(btnLogout) btnLogout.classList.add('hidden');
  }
}

function loadLogoFromStorage(){
  const mode = localStorage.getItem(LS_LOGO_MODE) || 'full';
  const bg = localStorage.getItem(LS_LOGO_BG) || 'white';
  const modeSel = document.getElementById('logoMode');
  const bgSel = document.getElementById('logoBg');
  if(modeSel) modeSel.value = mode;
  if(bgSel) bgSel.value = bg;
  applyLogoPrefs(mode, bg);
}

function applyLogoPrefs(mode, bg){
  const box = document.getElementById('logoBox');
  if(!box) return;
  box.classList.toggle('mode-icon', mode === 'icon');
  box.classList.toggle('bg-none', bg === 'none');
}

async function connect(){
  // En web, “conexión” significa: hay sesión autenticada
  const { data: { session }, error } = await supabase.auth.getSession();
  if(error) console.error(error);

  currentSession = session;
  connected = !!session;
  currentUserEmail = session?.user?.email || '';
  setConnStatus();

  if(connected){
    try{
      // Quick ping (RLS + schema)
      const { error: pingErr } = await supabase.from('empleados').select('id', { count:'exact', head:true });
      if(pingErr) throw pingErr;
      await refreshAll();
    } catch(err){
      console.error(err);
      toast('Sesión OK, pero no hay acceso a datos (revisa RLS/policies o schema).', 'bad');
    }
  }
}

// ---------------------------
// Tabs
// ---------------------------
function setupTabs(){
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      $$('.panel').forEach(p => p.classList.remove('active'));
      $(`#tab-${btn.dataset.tab}`).classList.add('active');

      // Lazy refresh per tab
      if(!connected) return;
      if(btn.dataset.tab === 'gratificaciones') await refreshGratificacionesGlobal();
      if(btn.dataset.tab === 'tiempoextra') await refreshTiempoExtraGlobal();
      if(btn.dataset.tab === 'reportes') await refreshReport();
      if(btn.dataset.tab === 'permanencia') await refreshPermanencia();
    });
  });
}

// ---------------------------
// Fetch helpers
// ---------------------------
async function fetchEmpleados(){
  const { data, error } = await supabase
    .from('empleados')
    .select('*')
    .order('bod', { ascending:true })
    .order('nombre', { ascending:true });
  if(error) throw error;
  return data || [];
}

async function fetchGratificacionesGlobal(){
  // NOTE: Some Supabase schemas don't define a FK relationship from
  // gratificaciones.empleado_id -> empleados.id. The iOS app doesn't rely on joins.
  // To keep the web app compatible, fetch raw rows and resolve employee locally.
  const { data, error } = await supabase
    .from('gratificaciones')
    .select('*')
    .order('creada_en', { ascending:false });
  if(error) throw error;
  return data || [];
}

async function fetchTiempoExtraGlobal(){
  // See note in fetchGratificacionesGlobal() about FK joins.
  const { data, error } = await supabase
    .from('tiempo_extra')
    .select('*')
    .order('creada_en', { ascending:false });
  if(error) throw error;
  return data || [];
}

async function fetchEmpleadoDetail(empId){
  const { data: emp, error: e1 } = await supabase
    .from('empleados')
    .select('*')
    .eq('id', empId)
    .single();
  if(e1) throw e1;

  const { data: grat, error: e2 } = await supabase
    .from('gratificaciones')
    .select('*')
    .eq('empleado_id', empId)
    .order('creada_en', { ascending:false });
  if(e2) throw e2;

  const { data: te, error: e3 } = await supabase
    .from('tiempo_extra')
    .select('*')
    .eq('empleado_id', empId)
    .order('creada_en', { ascending:false });
  if(e3) throw e3;

  return { emp, grat: grat||[], te: te||[] };
}

// ---------------------------
// Render: Personal list
// ---------------------------
function renderBodSelects(){
  for(const id of ['empBod','permBod']){
    const sel = document.getElementById(id);
    if(!sel) continue;
    // keep first option
    BODS.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      sel.appendChild(opt);
    });
  }
}

function empleadoBadges(e){
  const badges = [];
  if(e.estatus === 'Baja') badges.push(`<span class="badge danger">Baja</span>`);
  else if(e.estatus === 'Incapacidad') badges.push(`<span class="badge warn">Incapacidad</span>`);
  else badges.push(`<span class="badge ok">Activo</span>`);

  if(e.es_vacante) badges.push(`<span class="badge warn">VAC</span>`);
  if(e.es_extra) badges.push(`<span class="badge">EXTRA</span>`);
  badges.push(`<span class="badge">BOD ${escapeHtml(e.bod||'—')}</span>`);
  return badges.join('');
}

function renderEmpleados(){
  const q = ($('#empSearch').value || '').trim().toLowerCase();
  const bod = $('#empBod').value;
  const est = $('#empEstatus').value;

  let list = empleados;
  if(bod) list = list.filter(e => e.bod === bod);
  if(est) list = list.filter(e => e.estatus === est);
  if(q){
    list = list.filter(e => {
      const hay = `${e.nomina||''} ${e.nombre||''} ${e.departamento||''} ${e.puesto||''} ${e.bod||''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const root = $('#empList');
  root.innerHTML = '';

  if(!connected){
    root.innerHTML = `<div class="emptyState"><div class="emoji">🔌</div><div><div class="emptyTitle">Conecta Supabase</div><div class="emptySub">En “Conexión” pega tu URL y anon key.</div></div></div>`;
    return;
  }

  if(list.length === 0){
    root.innerHTML = `<div class="emptyState"><div class="emoji">🗂️</div><div><div class="emptyTitle">Sin resultados</div><div class="emptySub">Prueba otros filtros o revisa la importación.</div></div></div>`;
    return;
  }

  list.forEach(e => {
    const div = document.createElement('div');
    div.className = 'item' + (selectedEmpleado?.id === e.id ? ' active' : '');
    div.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(e.nombre || '—')}</div>
        <div class="sub">#${escapeHtml(e.nomina)} • ${escapeHtml(e.puesto||'—')} • ${escapeHtml(e.departamento||'—')}</div>
        <div class="sub">Ingreso: ${fmtDateHuman(e.fecha_ingreso)}</div>
      </div>
      <div class="badges">${empleadoBadges(e)}</div>
    `;
    div.addEventListener('click', () => {
      // If user is already in Personal, back should stay in Personal.
      empNavContext = null;
      selectEmpleado(e.id);
    });
    root.appendChild(div);
  });
}

// ---------------------------
// Employee detail
// ---------------------------
async function selectEmpleado(empId, opts={}){
  if(!connected) return;
  selectedEmpleado = empleados.find(e => e.id === empId) || null;
  renderEmpleados();

  // On narrow screens (mobile), show a full-screen detail view like iOS.
  // IMPORTANT: render detail only once to avoid duplicate element IDs.
  if(isMobileNarrow()){
    // keep card minimal (no duplicated IDs)
    const card = document.getElementById('empDetail');
    if(card){
      card.innerHTML = `<div class="emptyState"><div class="emoji">📱</div><div><div class="emptyTitle">Detalle en pantalla completa</div><div class="emptySub">Selecciona un empleado para abrir el detalle.</div></div></div>`;
    }
    await renderEmpleadoDetail(document.getElementById('empOverlayBody'));
    openEmpOverlay(selectedEmpleado?.nombre || 'Detalle');
    const body = document.getElementById('empOverlayBody');
    if(body) body.scrollTop = 0;
    return;
  }

  // Desktop/tablet: render into the card area.
  await renderEmpleadoDetail(document.getElementById('empDetail'));

  // Tablet/desktop UX: when jumping here from Gratificaciones/Tiempo Extra,
  // auto-scroll to the detail card so the user doesn't have to go "hasta abajo".
  if(opts?.scrollToDetail){
    const isNarrow = window.matchMedia('(max-width: 980px)').matches;
    if(isNarrow){
      const el = document.getElementById('empDetail');
      setTimeout(()=> el?.scrollIntoView({ behavior:'smooth', block:'start' }), 50);
    }
  }
}

function programaLabel(p){
  return PROGRAMAS.find(x=>x.value===p)?.label || p || '—';
}

function describePrograma(record){
  const p = record.programa;
  if(p === 'unicaViernes'){
    const f = record.fecha_objetivo;
    if(!f) return 'Única — (sin fecha objetivo)';
    const v = fridayOfWeek(parseDateLocal(f) || new Date(f));
    return `Única — se paga el viernes ${fmtDateHuman(v)}`;
  }
  if(p === 'segundaSemanaViernes'){
    if(record.sin_vigencia) return '2ª semana de cada mes — sin vigencia';
    if(record.vigencia_hasta_mes){
      const fin = lastDayOfMonth(new Date(record.vigencia_hasta_mes));
      const mes = fin.toLocaleDateString('es-MX', { month:'long', year:'numeric' });
      return `2ª semana de cada mes — vigente hasta ${mes}`;
    }
    return '2ª semana de cada mes';
  }
  if(p === 'cadaSemanaViernes') return 'Cada semana — se paga todos los viernes';
  return p || '';
}

async function renderEmpleadoDetail(root){
  // root: element where the detail UI is rendered (card or overlay body)
  if(!root) root = $('#empDetail');
  if(!selectedEmpleado){
    root.innerHTML = `
      <div class="emptyState">
        <div class="emoji">👤</div>
        <div>
          <div class="emptyTitle">Selecciona un empleado</div>
          <div class="emptySub">Aquí verás su detalle, gratificaciones y tiempo extra.</div>
        </div>
      </div>`;
    return;
  }

  const { emp, grat, te } = await fetchEmpleadoDetail(selectedEmpleado.id);
  selectedEmpleado = emp;

  root.innerHTML = `
    <div class="row" style="justify-content:space-between;gap:10px;align-items:flex-start;">
      <div>
        <div style="font-weight:900;font-size:18px">${escapeHtml(emp.nombre||'—')}</div>
        <div class="small">#${escapeHtml(emp.nomina)} • BOD ${escapeHtml(emp.bod||'—')} • ${escapeHtml(emp.puesto||'—')}</div>
        <div class="small">Ingreso: <b>${fmtDateHuman(emp.fecha_ingreso)}</b> • ${escapeHtml(emp.departamento||'—')}</div>
      </div>
      <div class="right">
        <button class="btn secondary" id="btnEditEmp">Editar</button>
        <button class="btn danger" id="btnDelEmp">Borrar</button>
      </div>
    </div>
    <hr />

    <div class="split">
      <div>
        <h3 style="margin:0 0 6px 0">Gratificaciones</h3>
        <div class="small">Se pagan por programa (única / 2ª semana / cada semana).</div>
        <div class="right" style="margin-top:10px">
          <button class="btn primary" id="btnNewGrat">Nueva gratificación</button>
        </div>
        <div class="list" id="empGratList"></div>
      </div>

      <div>
        <h3 style="margin:0 0 6px 0">Tiempo extra</h3>
        <div class="small">Mismo esquema de programa. Horas (no $).</div>
        <div class="right" style="margin-top:10px">
          <button class="btn primary" id="btnNewTE">Nuevo tiempo extra</button>
        </div>
        <div class="list" id="empTEList"></div>
      </div>
    </div>
  `;

  // buttons
  $('#btnEditEmp').addEventListener('click', () => openEmpleadoForm(emp));
  $('#btnDelEmp').addEventListener('click', () => confirmDeleteEmpleado(emp));
  $('#btnNewGrat').addEventListener('click', () => openGratForm({ empleado_id: emp.id }));
  $('#btnNewTE').addEventListener('click', () => openTEForm({ empleado_id: emp.id }));

  // list grat
  const gl = $('#empGratList');
  if(grat.length===0){
    gl.innerHTML = `<div class="emptyState"><div class="emoji">🎁</div><div><div class="emptyTitle">Sin gratificaciones</div><div class="emptySub">Agrega la primera.</div></div></div>`;
  } else {
    gl.innerHTML = '';
    for(const g of grat){
      const div = document.createElement('div');
      div.className = 'item';
      const act = g.activa ? '<span class="badge ok">Activa</span>' : '<span class="badge danger">Inactiva</span>';
      div.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(g.motivo||'—')}</div>
          <div class="sub">${programaLabel(g.programa)} • ${describePrograma(g)}</div>
          <div class="sub">Creada: ${fmtDateHuman(g.creada_en)}</div>
        </div>
        <div class="badges">
          ${act}
          <span class="badge">${fmtMoney(g.monto)}</span>
        </div>
      `;
      div.addEventListener('click', ()=> openGratForm(g));
      gl.appendChild(div);
    }
  }

  // list te
  const tl = $('#empTEList');
  if(te.length===0){
    tl.innerHTML = `<div class="emptyState"><div class="emoji">⏱️</div><div><div class="emptyTitle">Sin tiempo extra</div><div class="emptySub">Agrega el primero.</div></div></div>`;
  } else {
    tl.innerHTML = '';
    for(const t of te){
      const div = document.createElement('div');
      div.className = 'item';
      const act = t.activa ? '<span class="badge ok">Activa</span>' : '<span class="badge danger">Inactiva</span>';
      div.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(t.motivo||'—')}</div>
          <div class="sub">${programaLabel(t.programa)} • ${describePrograma(t)}</div>
          <div class="sub">Creado: ${fmtDateHuman(t.creada_en)}</div>
        </div>
        <div class="badges">
          ${act}
          <span class="badge">${Number(t.horas||0)} h</span>
        </div>
      `;
      div.addEventListener('click', ()=> openTEForm(t));
      tl.appendChild(div);
    }
  }
}

// ---------------------------
// CRUD: Empleado
// ---------------------------
function openEmpleadoForm(emp=null){
  const isEdit = !!emp?.id;
  const dlg = $('#dlg');
  dlg.innerHTML = `
    <form method="dialog" class="modalContent">
      <div class="modalHeader">
        <h3>${isEdit ? 'Editar empleado' : 'Alta de empleado'}</h3>
        <button class="iconBtn" value="cancel" aria-label="Cerrar">✕</button>
      </div>

      <div class="split">
        <div class="field">
          <label>Nómina</label>
          <input id="f_nomina" class="input" ${isEdit?'disabled':''} value="${escapeHtml(emp?.nomina||'')}" placeholder="000000" />
        </div>
        <div class="field">
          <label>Nombre</label>
          <input id="f_nombre" class="input" value="${escapeHtml(emp?.nombre||'')}" placeholder="Nombre completo" />
        </div>
      </div>

      <div class="split">
        <div class="field">
          <label>Fecha ingreso</label>
          <input id="f_ingreso" type="date" class="input" value="${emp?.fecha_ingreso ? fmtDateISO(emp.fecha_ingreso) : ''}" />
        </div>
        <div class="field">
          <label>Departamento</label>
          <input id="f_depa" class="input" value="${escapeHtml(emp?.departamento||'')}" placeholder="Departamento" />
        </div>
      </div>

      <div class="split">
        <div class="field">
          <label>Puesto</label>
          <select id="f_puesto" class="input">
            ${PUESTOS.map(p=>`<option ${emp?.puesto===p?'selected':''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>BOD</label>
          <select id="f_bod" class="input">
            ${BODS.map(b=>`<option value="${b}" ${emp?.bod===b?'selected':''}>${b}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="split">
        <div class="field">
          <label>Localiza</label>
          <select id="f_loc" class="input">
            ${LOCALIZA.map(x=>`<option value="${x}" ${emp?.localiza===x?'selected':''}>${x}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Estatus</label>
          <select id="f_est" class="input">
            ${ESTATUS.map(x=>`<option value="${x}" ${emp?.estatus===x?'selected':''}>${x}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="split">
        <label class="inline"><input id="f_vac" type="checkbox" ${emp?.es_vacante?'checked':''} /> VACANTE</label>
        <label class="inline"><input id="f_extra" type="checkbox" ${emp?.es_extra?'checked':''} /> EXTRA</label>
      </div>

      <hr />
      <div class="right">
        ${isEdit ? '<button id="btnEmpSave" class="btn primary" value="default">Guardar</button>' : '<button id="btnEmpCreate" class="btn primary" value="default">Crear</button>'}
      </div>
      <div class="footnote">Nota: para marcar VAC automáticamente en importación, el nombre debe contener “VAC” o “VACANTE”.</div>
    </form>
  `;

  dlg.showModal();

  const saveBtn = isEdit ? $('#btnEmpSave', dlg) : $('#btnEmpCreate', dlg);
  saveBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try{
      const payload = {
        nomina: ($('#f_nomina', dlg).value||'').trim(),
        nombre: ($('#f_nombre', dlg).value||'').trim(),
        fecha_ingreso: $('#f_ingreso', dlg).value || null,
        departamento: ($('#f_depa', dlg).value||'').trim(),
        puesto: $('#f_puesto', dlg).value,
        bod: $('#f_bod', dlg).value,
        localiza: $('#f_loc', dlg).value,
        estatus: $('#f_est', dlg).value,
        es_vacante: $('#f_vac', dlg).checked,
        es_extra: $('#f_extra', dlg).checked,
      };
      if(!payload.nomina) throw new Error('Falta nómina');
      if(!payload.nombre) throw new Error('Falta nombre');

      if(isEdit){
        const { error } = await supabase.from('empleados').update(payload).eq('id', emp.id);
        if(error) throw error;
        toast('Empleado actualizado');
      } else {
        const { error } = await supabase.from('empleados').insert(payload);
        if(error) throw error;
        toast('Empleado creado');
      }

      dlg.close();
      await refreshEmpleados();

      // reselect
      if(isEdit) await selectEmpleado(emp.id);

    } catch(err){
      console.error(err);
      toast(err.message || 'Error guardando', 'bad');
    }
  });
}

async function confirmDeleteEmpleado(emp){
  const ok = confirm(`¿Borrar empleado #${emp.nomina} — ${emp.nombre}?\n\nEsto también borrará sus gratificaciones/tiempo extra (si el FK está en cascade).`);
  if(!ok) return;
  try{
    const { error } = await supabase.from('empleados').delete().eq('id', emp.id);
    if(error) throw error;
    toast('Empleado borrado');
    selectedEmpleado = null;
    await refreshEmpleados();
    await renderEmpleadoDetail();
  } catch(err){
    console.error(err);
    toast('No se pudo borrar (RLS/relaciones).', 'bad');
  }
}

// ---------------------------
// CRUD: Gratificaciones
// ---------------------------
function openGratForm(g){
  const isEdit = !!g?.id;
  const dlg = $('#dlg');

  const exclusiones = Array.isArray(g?.exclusiones) ? g.exclusiones : [];
  const exTxt = exclusiones.map(d=>fmtDateISO(d)).filter(Boolean).join(', ');

  dlg.innerHTML = `
    <form method="dialog" class="modalContent">
      <div class="modalHeader">
        <h3>${isEdit ? 'Editar gratificación' : 'Nueva gratificación'}</h3>
        <button class="iconBtn" value="cancel" aria-label="Cerrar">✕</button>
      </div>

      <div class="field">
        <label>Motivo</label>
        <input id="g_motivo" class="input" value="${escapeHtml(g?.motivo||'')}" placeholder="Ej: Bono productividad" />
      </div>

      <div class="split">
        <div class="field">
          <label>Monto (MXN)</label>
          <input id="g_monto" type="number" step="0.01" class="input" value="${g?.monto ?? ''}" />
        </div>
        <div class="field">
          <label>Programa</label>
          <select id="g_prog" class="input">
            ${PROGRAMAS.map(p=>`<option value="${p.value}" ${(g?.programa||'segundaSemanaViernes')===p.value?'selected':''}>${escapeHtml(p.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="split">
        <div class="field">
          <label>Fecha objetivo (solo Única)</label>
          <input id="g_fecha" type="date" class="input" value="${g?.fecha_objetivo ? fmtDateISO(g.fecha_objetivo) : ''}" />
        </div>
        <div class="field" id="g_vig_wrap">
          <label>Vigencia hasta (mes) (si aplica)</label>
          <input id="g_vig" type="date" class="input" value="${g?.vigencia_hasta_mes ? fmtDateISO(g.vigencia_hasta_mes) : ''}" />
        </div>
      </div>

      <div class="split">
        <label class="inline" id="g_sinv_wrap"><input id="g_sinv" type="checkbox" ${g?.sin_vigencia ?? true ? 'checked':''} /> Sin vigencia</label>
        <label class="inline"><input id="g_act" type="checkbox" ${g?.activa ?? true ? 'checked':''} /> Activa</label>
      </div>

      <div class="field">
        <label>Exclusiones (fechas YYYY-MM-DD separadas por coma) — útil para 2ª semana / cada semana</label>
        <input id="g_ex" class="input" value="${escapeHtml(exTxt)}" placeholder="2026-02-13, 2026-03-13" />
      </div>

      <hr />
      <div class="right">
        ${isEdit ? '<button id="btnGSave" class="btn primary" value="default">Guardar</button>' : '<button id="btnGCreate" class="btn primary" value="default">Crear</button>'}
        ${isEdit ? '<button id="btnGDelete" class="btn danger" value="default" type="button">Borrar</button>' : ''}
      </div>
      <div class="footnote">Regla: “Única” se paga el viernes de la semana de la fecha objetivo. “2ª semana” se paga el segundo viernes del mes (con exclusiones). “Cada semana” se paga todos los viernes.</div>
    </form>
  `;

  dlg.showModal();

  const btn = isEdit ? $('#btnGSave', dlg) : $('#btnGCreate', dlg);
  // Si el programa es Única, 'Sin vigencia' y 'Vigencia hasta' no aplican (evita confusión)
  const applyGProgUI = () => {
    const sel = $('#g_prog', dlg);
    const isUnica = (sel?.value === 'unicaViernes');
    const w1 = $('#g_sinv_wrap', dlg);
    const w2 = $('#g_vig_wrap', dlg);
    if(w1) w1.style.display = isUnica ? 'none' : '';
    if(w2) w2.style.display = isUnica ? 'none' : '';
    if(isUnica){
      const sinv = $('#g_sinv', dlg);
      const vig = $('#g_vig', dlg);
      if(sinv) sinv.checked = false;
      if(vig) vig.value = '';
    }
  };
  $('#g_prog', dlg)?.addEventListener('change', applyGProgUI);
  applyGProgUI();

  btn.addEventListener('click', async (ev)=>{
    ev.preventDefault();
    try{
      const payload = {
        empleado_id: g.empleado_id,
        motivo: ($('#g_motivo', dlg).value||'').trim(),
        monto: Number($('#g_monto', dlg).value||0),
        programa: $('#g_prog', dlg).value,
        fecha_objetivo: $('#g_fecha', dlg).value || null,
        sin_vigencia: $('#g_sinv', dlg).checked,
        vigencia_hasta_mes: $('#g_vig', dlg).value || null,
        activa: $('#g_act', dlg).checked,
        exclusiones: parseExclusiones($('#g_ex', dlg).value),
      };
      // Normaliza: en programa Única la vigencia NO aplica
      if(payload.programa === 'unicaViernes'){
        payload.sin_vigencia = false;
        payload.vigencia_hasta_mes = null;
      }

      if(!payload.motivo) throw new Error('Falta motivo');
      if(!(payload.monto >= 0)) throw new Error('Monto inválido');

      if(isEdit){
        const { error } = await supabase.from('gratificaciones').update(payload).eq('id', g.id);
        if(error) throw error;
        toast('Gratificación actualizada');
      } else {
        const { error } = await supabase.from('gratificaciones').insert(payload);
        if(error) throw error;
        toast('Gratificación creada');
      }

      dlg.close();
      await refreshAll();
      if(selectedEmpleado?.id === g.empleado_id) await selectEmpleado(g.empleado_id);

    }catch(err){
      console.error(err);
      toast(err.message || 'Error', 'bad');
    }
  });

  if(isEdit){
    $('#btnGDelete', dlg).addEventListener('click', async ()=>{
      const ok = confirm('¿Borrar esta gratificación?');
      if(!ok) return;
      try{
        const { error } = await supabase.from('gratificaciones').delete().eq('id', g.id);
        if(error) throw error;
        toast('Gratificación borrada');
        dlg.close();
        await refreshAll();
        if(selectedEmpleado?.id === g.empleado_id) await selectEmpleado(g.empleado_id);
      }catch(err){
        console.error(err);
        toast('No se pudo borrar', 'bad');
      }
    });
  }
}

// ---------------------------
// CRUD: Tiempo Extra
// ---------------------------
function openTEForm(t){
  const isEdit = !!t?.id;
  const dlg = $('#dlg');

  const exclusiones = Array.isArray(t?.exclusiones) ? t.exclusiones : [];
  const exTxt = exclusiones.map(d=>fmtDateISO(d)).filter(Boolean).join(', ');

  dlg.innerHTML = `
    <form method="dialog" class="modalContent">
      <div class="modalHeader">
        <h3>${isEdit ? 'Editar tiempo extra' : 'Nuevo tiempo extra'}</h3>
        <button class="iconBtn" value="cancel" aria-label="Cerrar">✕</button>
      </div>

      <div class="field">
        <label>Motivo</label>
        <input id="t_motivo" class="input" value="${escapeHtml(t?.motivo||'')}" placeholder="Ej: Carga/descarga" />
      </div>

      <div class="split">
        <div class="field">
          <label>Horas</label>
          <input id="t_horas" type="number" step="0.5" class="input" value="${t?.horas ?? ''}" />
        </div>
        <div class="field">
          <label>Programa</label>
          <select id="t_prog" class="input">
            ${PROGRAMAS.map(p=>`<option value="${p.value}" ${(t?.programa||'segundaSemanaViernes')===p.value?'selected':''}>${escapeHtml(p.label)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="split">
        <div class="field">
          <label>Fecha objetivo (solo Única)</label>
          <input id="t_fecha" type="date" class="input" value="${t?.fecha_objetivo ? fmtDateISO(t.fecha_objetivo) : ''}" />
        </div>
        <div class="field" id="g_vig_wrap">
          <label>Vigencia hasta (mes) (si aplica)</label>
          <input id="t_vig" type="date" class="input" value="${t?.vigencia_hasta_mes ? fmtDateISO(t.vigencia_hasta_mes) : ''}" />
        </div>
      </div>

      <div class="split">
        <label class="inline" id="t_sinv_wrap"><input id="t_sinv" type="checkbox" ${t?.sin_vigencia ?? true ? 'checked':''} /> Sin vigencia</label>
        <label class="inline"><input id="t_act" type="checkbox" ${t?.activa ?? true ? 'checked':''} /> Activo</label>
      </div>

      <div class="field">
        <label>Exclusiones (fechas YYYY-MM-DD separadas por coma) — aplica sobre todo en “cada semana”</label>
        <input id="t_ex" class="input" value="${escapeHtml(exTxt)}" placeholder="2026-02-20" />
      </div>

      <hr />
      <div class="right">
        ${isEdit ? '<button id="btnTSave" class="btn primary" value="default">Guardar</button>' : '<button id="btnTCreate" class="btn primary" value="default">Crear</button>'}
        ${isEdit ? '<button id="btnTDelete" class="btn danger" value="default" type="button">Borrar</button>' : ''}
      </div>
    </form>
  `;

  dlg.showModal();

  const btn = isEdit ? $('#btnTSave', dlg) : $('#btnTCreate', dlg);
  // Si el programa es Única, 'Sin vigencia' y 'Vigencia hasta' no aplican (evita confusión)
  const applyTProgUI = () => {
    const sel = $('#t_prog', dlg);
    const isUnica = (sel?.value === 'unicaViernes');
    const w1 = $('#t_sinv_wrap', dlg);
    const w2 = $('#t_vig_wrap', dlg);
    if(w1) w1.style.display = isUnica ? 'none' : '';
    if(w2) w2.style.display = isUnica ? 'none' : '';
    if(isUnica){
      const sinv = $('#t_sinv', dlg);
      const vig = $('#t_vig', dlg);
      if(sinv) sinv.checked = false;
      if(vig) vig.value = '';
    }
  };
  $('#t_prog', dlg)?.addEventListener('change', applyTProgUI);
  applyTProgUI();

  btn.addEventListener('click', async (ev)=>{
    ev.preventDefault();
    try{
      const payload = {
        empleado_id: t.empleado_id,
        motivo: ($('#t_motivo', dlg).value||'').trim(),
        horas: Number($('#t_horas', dlg).value||0),
        programa: $('#t_prog', dlg).value,
        fecha_objetivo: $('#t_fecha', dlg).value || null,
        sin_vigencia: $('#t_sinv', dlg).checked,
        vigencia_hasta_mes: $('#t_vig', dlg).value || null,
        activa: $('#t_act', dlg).checked,
        exclusiones: parseExclusiones($('#t_ex', dlg).value),
      };
      // Normaliza: en programa Única la vigencia NO aplica
      if(payload.programa === 'unicaViernes'){
        payload.sin_vigencia = false;
        payload.vigencia_hasta_mes = null;
      }

      // Normaliza: en programa Única la vigencia NO aplica
      if(payload.programa === 'unicaViernes'){
        payload.sin_vigencia = false;
        payload.vigencia_hasta_mes = null;
      }

      if(!payload.motivo) throw new Error('Falta motivo');
      if(!(payload.horas >= 0)) throw new Error('Horas inválidas');

      if(isEdit){
        const { error } = await supabase.from('tiempo_extra').update(payload).eq('id', t.id);
        if(error) throw error;
        toast('Tiempo extra actualizado');
      } else {
        const { error } = await supabase.from('tiempo_extra').insert(payload);
        if(error) throw error;
        toast('Tiempo extra creado');
      }

      dlg.close();
      await refreshAll();
      if(selectedEmpleado?.id === t.empleado_id) await selectEmpleado(t.empleado_id);

    }catch(err){
      console.error(err);
      toast(err.message || 'Error', 'bad');
    }
  });

  if(isEdit){
    $('#btnTDelete', dlg).addEventListener('click', async ()=>{
      const ok = confirm('¿Borrar este tiempo extra?');
      if(!ok) return;
      try{
        const { error } = await supabase.from('tiempo_extra').delete().eq('id', t.id);
        if(error) throw error;
        toast('Tiempo extra borrado');
        dlg.close();
        await refreshAll();
        if(selectedEmpleado?.id === t.empleado_id) await selectEmpleado(t.empleado_id);
      }catch(err){
        console.error(err);
        toast('No se pudo borrar', 'bad');
      }
    });
  }
}

function parseExclusiones(txt){
  const parts = (txt||'')
    .split(',')
    .map(s=>s.trim())
    .filter(Boolean);
  const out = [];
  for(const p of parts){
    const d = new Date(p);
    if(!isNaN(d.getTime())) out.push(fmtDateISO(d));
  }
  // unique
  return Array.from(new Set(out));
}

// ---------------------------
// Global lists (tabs)
// ---------------------------
function renderGratificacionesGlobal(){
  const q = ($('#gratSearch').value||'').trim().toLowerCase();
  const prog = $('#gratPrograma').value;
  const estado = $('#gratEstado')?.value || '';
  let list = gratificacionesGlobal;
  if(prog) list = list.filter(g=>g.programa === prog);
  if(estado === 'activas') list = list.filter(g=> !!g.activa);
  if(estado === 'inactivas') list = list.filter(g=> !g.activa);

  // Resolve employee locally (avoid depending on FK joins)
  const empById = new Map((empleados||[]).map(e=>[e.id, e]));

  if(q){
    list = list.filter(g=>{
      const emp = empById.get(g.empleado_id);
      const hay = `${emp?.nombre||''} ${g.motivo||''} ${emp?.bod||''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const root = $('#gratList');
  root.innerHTML = '';
  if(list.length===0){
    root.innerHTML = `<div class="emptyState"><div class="emoji">🎁</div><div><div class="emptyTitle">Sin resultados</div><div class="emptySub">Agrega desde el detalle de un empleado.</div></div></div>`;
    return;
  }

  for(const g of list){
    const emp = empById.get(g.empleado_id);
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(emp?.nombre||'—')} — ${escapeHtml(g.motivo||'—')}</div>
        <div class="sub">BOD ${escapeHtml(emp?.bod||'—')} • ${escapeHtml(emp?.puesto||'—')} • ${describePrograma(g)}</div>
      </div>
      <div class="badges">
        <span class="badge">${fmtMoney(g.monto)}</span>
        ${g.activa ? '<span class="badge ok">Activa</span>' : '<span class="badge danger">Inactiva</span>'}
      </div>
    `;

    // Click = editar (como en iOS)
    div.addEventListener('click', async ()=>{
      await openGratForm(g, { fromGlobal:true });
    });

    // Quick jump to employee
    const btn = document.createElement('button');
    btn.className = 'miniBtn';
    btn.type = 'button';
    btn.textContent = '👤';
    btn.title = 'Ver empleado';
    btn.addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const empId = emp?.id || g.empleado_id;
      if(!empId) return;
      empNavContext = { fromTab: getActiveTab(), scrollY: window.scrollY || 0 };
      goToTab('personal');
      await selectEmpleado(empId, { scrollToDetail:true, openedFromTab: empNavContext.fromTab });
    });
    div.querySelector('.badges')?.prepend(btn);

    root.appendChild(div);
  }
}

function renderTiempoExtraGlobal(){
  const q = ($('#teSearch').value||'').trim().toLowerCase();
  const prog = $('#tePrograma').value;
  const estado = $('#teEstado')?.value || '';
  let list = tiempoExtraGlobal;
  if(prog) list = list.filter(t=>t.programa === prog);
  if(estado === 'activas') list = list.filter(t=> !!t.activa);
  if(estado === 'inactivas') list = list.filter(t=> !t.activa);

  const empById = new Map((empleados||[]).map(e=>[e.id, e]));

  if(q){
    list = list.filter(t=>{
      const emp = empById.get(t.empleado_id);
      const hay = `${emp?.nombre||''} ${t.motivo||''} ${emp?.bod||''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const root = $('#teList');
  root.innerHTML = '';
  if(list.length===0){
    root.innerHTML = `<div class="emptyState"><div class="emoji">⏱️</div><div><div class="emptyTitle">Sin resultados</div><div class="emptySub">Agrega desde el detalle de un empleado.</div></div></div>`;
    return;
  }

  for(const t of list){
    const emp = empById.get(t.empleado_id);
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(emp?.nombre||'—')} — ${escapeHtml(t.motivo||'—')}</div>
        <div class="sub">BOD ${escapeHtml(emp?.bod||'—')} • ${escapeHtml(emp?.puesto||'—')} • ${describePrograma(t)}</div>
      </div>
      <div class="badges">
        <span class="badge">${Number(t.horas||0)} h</span>
        ${t.activa ? '<span class="badge ok">Activo</span>' : '<span class="badge danger">Inactivo</span>'}
      </div>
    `;

    div.addEventListener('click', async ()=>{
      await openTEForm(t);
    });

    const btn = document.createElement('button');
    btn.className = 'miniBtn';
    btn.type = 'button';
    btn.textContent = '👤';
    btn.title = 'Ver empleado';
    btn.addEventListener('click', async (ev)=>{
      ev.stopPropagation();
      const empId = emp?.id || t.empleado_id;
      if(!empId) return;
      empNavContext = { fromTab: getActiveTab(), scrollY: window.scrollY || 0 };
      goToTab('personal');
      await selectEmpleado(empId, { scrollToDetail:true, openedFromTab: empNavContext.fromTab });
    });
    div.querySelector('.badges')?.prepend(btn);

    root.appendChild(div);
  }
}

// ---------------------------
// Reportes: pagos por viernes
// ---------------------------
function isFriday(d){ return d.getDay() === 5; } // 0=Sun

function startOfWeekSunday(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  const dow = x.getDay();
  x.setDate(x.getDate() - dow);
  return x;
}

function fridayOfWeek(d){
  const s = startOfWeekSunday(d);
  const v = new Date(s);
  v.setDate(v.getDate() + 5);
  return v;
}

function secondFridayOfMonth(d){
  const y = d.getFullYear();
  const m = d.getMonth();
  const fridays = [];
  for(let day=1; day<=31; day++){
    const x = new Date(y,m,day);
    if(x.getMonth() !== m) break;
    if(isFriday(x)) fridays.push(new Date(x));
  }
  return fridays[1] || fridays[0] || null;
}

function lastDayOfMonth(d){
  const y = d.getFullYear();
  const m = d.getMonth();
  return new Date(y, m+1, 0);
}

function nextFriday(from=new Date()){
  const d = new Date(from);
  d.setHours(0,0,0,0);
  const diff = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d;
}

function isSameDay(a,b){
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function isExcluded(record, friday){
  const ex = Array.isArray(record.exclusiones) ? record.exclusiones : [];
  const fIso = fmtDateISO(friday);
  return ex.some(x => (String(x).slice(0,10) === fIso));
}

function dueGratificacion(g, friday){
  if(!g.activa) return false;
  const p = g.programa;

  if(p === 'unicaViernes'){
    if(!g.fecha_objetivo) return false;
    const v = fridayOfWeek(parseDateLocal(g.fecha_objetivo) || new Date(g.fecha_objetivo));
    return isSameDay(v, friday);
  }

  if(p === 'segundaSemanaViernes'){
    if(!isFriday(friday)) return false;
    const sf = secondFridayOfMonth(friday);
    if(!sf || !isSameDay(sf, friday)) return false;
    if(isExcluded(g, friday)) return false;
    if(g.sin_vigencia) return true;
    if(!g.vigencia_hasta_mes) return true;
    const fin = lastDayOfMonth(parseDateLocal(g.vigencia_hasta_mes) || new Date(g.vigencia_hasta_mes));
    return friday <= fin;
  }

  if(p === 'cadaSemanaViernes'){
    if(!isFriday(friday)) return false;
    return !isExcluded(g, friday);
  }

  return false;
}

function dueTiempoExtra(t, friday){
  if(!t.activa) return false;
  const p = t.programa;

  if(p === 'unicaViernes'){
    if(!t.fecha_objetivo) return false;
    const v = fridayOfWeek(parseDateLocal(t.fecha_objetivo) || new Date(t.fecha_objetivo));
    return isSameDay(v, friday);
  }

  if(p === 'segundaSemanaViernes'){
    if(!isFriday(friday)) return false;
    const sf = secondFridayOfMonth(friday);
    if(!sf || !isSameDay(sf, friday)) return false;
    if(isExcluded(t, friday)) return false;
    if(t.sin_vigencia) return true;
    if(!t.vigencia_hasta_mes) return true;
    const fin = lastDayOfMonth(parseDateLocal(t.vigencia_hasta_mes) || new Date(t.vigencia_hasta_mes));
    return friday <= fin;
  }

  if(p === 'cadaSemanaViernes'){
    if(!isFriday(friday)) return false;
    return !isExcluded(t, friday);
  }

  return false;
}

function shouldShowExcludedInReport(record, friday){
  if(!record?.activa) return false;
  if(!isExcluded(record, friday)) return false;
  if(record.programa === 'cadaSemanaViernes') return isFriday(friday);
  if(record.programa === 'segundaSemanaViernes'){
    if(!isFriday(friday)) return false;
    const sf = secondFridayOfMonth(friday);
    if(!sf || !isSameDay(sf, friday)) return false;
    if(record.sin_vigencia) return true;
    if(!record.vigencia_hasta_mes) return true;
    const fin = lastDayOfMonth(parseDateLocal(record.vigencia_hasta_mes) || new Date(record.vigencia_hasta_mes));
    return friday <= fin;
  }
  return false;
}

function matchesReportSearch(row, q){
  if(!q) return true;
  const emp = empOf(row);
  const hay = `${emp?.nombre||''} ${row?.motivo||''} ${emp?.bod||''} ${emp?.puesto||''}`.toLowerCase();
  return hay.includes(q);
}

async function refreshReport(){
  if(!connected) return;
  // Ensure we have global lists
  if(gratificacionesGlobal.length===0) gratificacionesGlobal = await fetchGratificacionesGlobal();
  if(tiempoExtraGlobal.length===0) tiempoExtraGlobal = await fetchTiempoExtraGlobal();

  const dateStr = $('#repFriday').value;
  const rawDate = dateStr ? parseDateLocal(dateStr) : nextFriday(new Date());
  rawDate.setHours(0,0,0,0);

  // Permite elegir cualquier fecha; el reporte siempre calcula con el viernes
  // de la semana correspondiente para que 2026-03-09 encuentre el pago del 2026-03-13.
  const friday = isFriday(rawDate) ? rawDate : fridayOfWeek(rawDate);
  friday.setHours(0,0,0,0);

  // Refleja la fecha normalizada en el input para evitar confusión visual.
  $('#repFriday').value = fmtDateISO(friday);

  const q = ($('#repSearch')?.value || '').trim().toLowerCase();

  const dueG = gratificacionesGlobal.filter(g=> dueGratificacion(g, friday));
  const dueT = tiempoExtraGlobal.filter(t=> dueTiempoExtra(t, friday));
  const excludedG = gratificacionesGlobal.filter(g=> shouldShowExcludedInReport(g, friday) && !dueG.some(x=>x.id===g.id));
  const excludedT = tiempoExtraGlobal.filter(t=> shouldShowExcludedInReport(t, friday) && !dueT.some(x=>x.id===t.id));

  const visibleG = [...dueG, ...excludedG].filter(x=>matchesReportSearch(x, q));
  const visibleT = [...dueT, ...excludedT].filter(x=>matchesReportSearch(x, q));

  // Render
  renderReportList('repGrat', visibleG, friday, 'gratificaciones');
  renderReportList('repTE', visibleT, friday, 'tiempo_extra');

  const totalG = dueG.reduce((s,g)=> s + Number(g.monto||0), 0);
  $('#repGratTotal').innerHTML = `<div>Total pagable</div><div><b>${fmtMoney(totalG)}</b> • ${dueG.length} item(s)</div>`;

  const totalH = dueT.reduce((s,t)=> s + Number(t.horas||0), 0);
  $('#repTETotal').innerHTML = `<div>Total pagable</div><div><b>${totalH} h</b> • ${dueT.length} item(s)</div>`;

  // cache for export
  window.__lastReport = { friday, dueG, dueT, visibleG, visibleT, excludedG, excludedT };
}

function renderReportList(containerId, list, friday, tableName){
  const root = $(`#${containerId}`);
  root.innerHTML = '';

  if(list.length===0){
    root.innerHTML = `<div class="emptyState"><div class="emoji">📆</div><div><div class="emptyTitle">Sin resultados</div><div class="emptySub">No hay registros para ${fmtDateHuman(friday)} con el filtro actual.</div></div></div>`;
    return;
  }

  // group by programa
  const groups = {
    unicaViernes: [],
    segundaSemanaViernes: [],
    cadaSemanaViernes: [],
  };
  list.forEach(x => groups[x.programa]?.push(x));

  for(const [prog, items] of Object.entries(groups)){
    if(items.length===0) continue;

    const header = document.createElement('div');
    header.className = 'small';
    header.style.marginTop = '6px';
    header.style.opacity = '.95';
    header.innerHTML = `<b>${programaLabel(prog)}</b> — ${items.length} item(s)`;
    root.appendChild(header);

    items.forEach(x => {
      const emp = empOf(x);
      const div = document.createElement('div');
      div.className = 'item';
      const right = (tableName==='gratificaciones')
        ? `<span class="badge">${fmtMoney(x.monto)}</span>`
        : `<span class="badge">${Number(x.horas||0)} h</span>`;

      const excluded = isExcluded(x, friday);
      const exBadge = excluded ? `<span class="badge warn">EXCLUIDO</span>` : '';
      const actionBadge = (prog==='segundaSemanaViernes' || prog==='cadaSemanaViernes')
        ? `<span class="badge">${excluded ? 'Click: volver a incluir' : 'Click: excluir/revertir'}</span>`
        : '';

      div.innerHTML = `
        <div class="meta">
          <div class="name">${escapeHtml(emp?.nombre||'—')}</div>
          <div class="sub">BOD ${escapeHtml(emp?.bod||'—')} • ${escapeHtml(emp?.puesto||'—')}</div>
          <div class="sub">${escapeHtml(x.motivo||'—')} • ${describePrograma(x)}</div>
        </div>
        <div class="badges">
          ${right}
          ${x.activa ? '<span class="badge ok">Activa</span>' : '<span class="badge danger">Inactiva</span>'}
          ${exBadge}
          ${actionBadge}
        </div>
      `;

      if(prog==='segundaSemanaViernes' || prog==='cadaSemanaViernes'){
        div.addEventListener('click', async ()=>{
          await toggleExclusion(tableName, x, friday);
        });
      } else {
        div.addEventListener('click', async ()=>{
          const empId = emp?.id;
          if(empId){
            $('[data-tab="personal"]').click();
            await selectEmpleado(empId);
          }
        });
      }

      root.appendChild(div);
    });
  }
}

async function toggleExclusion(tableName, record, friday){
  try{
    const iso = fmtDateISO(friday);
    const ex = Array.isArray(record.exclusiones) ? [...record.exclusiones] : [];
    const idx = ex.findIndex(d => String(d).slice(0,10) === iso);
    if(idx >= 0) ex.splice(idx, 1);
    else ex.push(iso);

    const { error } = await supabase.from(tableName).update({ exclusiones: ex }).eq('id', record.id);
    if(error) throw error;

    // update local cache
    record.exclusiones = ex;

    toast(idx>=0 ? 'Exclusión revertida' : 'Viernes excluido');
    await refreshAll();
    await refreshReport();

  } catch(err){
    console.error(err);
    toast('No se pudo cambiar exclusión (RLS?)', 'bad');
  }
}

function exportReportCSV(){
  const rep = window.__lastReport;
  if(!rep) return;
  const { friday, dueG, dueT } = rep;

  const lines = [];
  lines.push(['Tipo','Nomina','Nombre','BOD','Puesto','Motivo','Programa','Monto','Horas'].join(','));

  for(const g of dueG){
    const e = empOf(g) || {};
    lines.push([
      'Gratificacion',
      safeCSV(e.nomina),
      safeCSV(e.nombre),
      safeCSV(e.bod),
      safeCSV(e.puesto),
      safeCSV(g.motivo),
      safeCSV(programaLabel(g.programa)),
      g.monto ?? '',
      ''
    ].join(','));
  }
  for(const t of dueT){
    const e = empOf(t) || {};
    lines.push([
      'TiempoExtra',
      safeCSV(e.nomina),
      safeCSV(e.nombre),
      safeCSV(e.bod),
      safeCSV(e.puesto),
      safeCSV(t.motivo),
      safeCSV(programaLabel(t.programa)),
      '',
      t.horas ?? ''
    ].join(','));
  }

  const csv = lines.join('\n');
  downloadText(csv, `reporte_${fmtDateISO(friday)}.csv`, 'text/csv;charset=utf-8');
}

function safeCSV(v){
  const s = String(v ?? '');
  if(/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}

function downloadText(text, filename, mime){
  const blob = new Blob([text], { type:mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------
// PDF (Print) — Memorándum estilo iOS
// Nota: aquí usamos window.print() y el usuario guarda como PDF.
// ---------------------------

function openPrintWindow(html){
  const w = window.open('', '_blank');
  if(!w){
    toast('Tu navegador bloqueó la ventana emergente. Permite popups para imprimir.', 'bad');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function fmtMesAnioES(date){
  const s = date.toLocaleDateString('es-MX', { month:'long', year:'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtDiaDeMesES(date){
  // "07 de noviembre" (minúsculas)
  const day = String(date.getDate()).padStart(2,'0');
  const month = date.toLocaleDateString('es-MX', { month:'long' }).toLowerCase();
  return `${day} de ${month}`;
}

function sortByBodNombre(a,b){
  const ea = empOf(a) || {};
  const eb = empOf(b) || {};
  const ba = (ea.bod||'').toString();
  const bb = (eb.bod||'').toString();
  if(ba === bb){
    return (ea.nombre||'').localeCompare((eb.nombre||''), 'es', { sensitivity:'base' });
  }
  return ba.localeCompare(bb, 'es', { sensitivity:'base' });
}

function memoShell({ docTitle, visibleTitle, headerLines, introHtml, tableHtml }){
  const css = `
    @page{ size: letter; margin: 14mm; }
    body{ font-family: Arial, sans-serif; color:#111; }
    .top{ display:flex; align-items:flex-start; gap:12px; }
    .logo{ width:120px; height:auto; }
    .title{ flex:1; text-align:center; font-weight:700; font-size:20px; margin-top:24px; }
    .meta{ margin-top:10px; font-size:13px; line-height:1.5; }
    .meta div{ margin:2px 0; }
    .intro{ margin-top:14px; font-size:13px; line-height:1.6; white-space:pre-line; }
    table{ width:100%; border-collapse:collapse; margin-top:14px; font-size:12px; }
    th,td{ border:1px solid #bbb; padding:6px 8px; vertical-align:top; }
    th{ background:#f3f3f3; font-weight:700; font-size:13px; }
    .right{ text-align:right; white-space:nowrap; }
    .footer{ margin-top:18px; font-size:13px; line-height:1.6; }
    .sig{ margin-top:26px; font-weight:700; }
    .pagebreak{ break-before: page; }
    @media print{
      .noprint{ display:none !important; }
    }

    /* Vista cómoda en celular (sin afectar impresión) */
    @media screen and (max-width: 520px){
      @page{ margin: 10mm; }
      .top{ gap:10px; }
      .logo{ width:92px; }
      .title{ font-size:18px; margin-top:18px; }
      table{ border:0; }
      thead{ display:none; }
      tr{ display:block; border:1px solid #bbb; border-radius:10px; margin-top:10px; overflow:hidden; }
      td{ display:flex; gap:10px; border:0; border-top:1px solid #ddd; }
      td:first-child{ border-top:0; }
      td::before{ content: attr(data-label); font-weight:700; width:40%; flex: 0 0 40%; }
      .right{ justify-content:space-between; }
    }
  `;

  const header = headerLines.map(l=>`<div>${escapeHtml(l)}</div>`).join('');

  return `
    <html><head><meta charset="utf-8" />
      <title>${escapeHtml(docTitle || visibleTitle || '')}</title>
      <style>${css}</style>
    </head><body>
      <div class="top">
        <img class="logo" src="LogoLimsa.png" alt="LIMSA" />
        <div class="title">${escapeHtml(visibleTitle || '')}</div>
      </div>

      <div class="meta">${header}</div>
      <div class="intro">${introHtml}</div>
      ${tableHtml}

      <div class="footer">
        <div>Sin más por el momento y agradeciendo de antemano su apoyo.</div>
        <div class="sig">Ing. Jorge Alberto Pedroza Cepeda</div>
      </div>

      <script>window.print();</script>
    </body></html>
  `;
}

function printGratMemo(){
  const rep = window.__lastReport;
  if(!rep) return;
  const { friday, dueG } = rep;

  const hoy = new Date();
  const fechaHoy = hoy.toLocaleDateString('es-MX');
  const mesAnio = fmtMesAnioES(friday);
  const fechaPagoTexto = fmtDiaDeMesES(friday);

  // iOS: en el PDF solo van los pagables (programadas excluidas se omiten)
  const visibles = (dueG||[])
    .filter(g=> !isExcluded(g, friday))
    .slice()
    .sort(sortByBodNombre);

  const intro = `Por medio del presente solicito se otorguen las siguientes gratificaciones\ncorrespondientes a ${mesAnio} para pagar el ${fechaPagoTexto}`;

  const table = buildMemoTableGrat(visibles);
  const html = memoShell({
    docTitle: `memo_gratificaciones_${fmtDateDMY(friday)}`,
    visibleTitle: 'MEMORÁNDUM Gratificaciones',
    headerLines: [
      `FECHA: ${fechaHoy}`,
      'PARA: Departamento Recursos Humanos',
      'ASUNTO: Pago de gratificaciones'
    ],
    introHtml: escapeHtml(intro).replaceAll('\n','<br>'),
    tableHtml: table
  });

  openPrintWindow(html);
}

function printTEMemo(){
  const rep = window.__lastReport;
  if(!rep) return;
  const { friday, dueT } = rep;

  const hoy = new Date();
  const fechaHoy = hoy.toLocaleDateString('es-MX');
  const fechaPagoTexto = fmtDiaDeMesES(friday);

  // Rango Lun–Sáb de la semana anterior (igual que iOS)
  const { inicio, fin } = rangoSemanaAnterior_LunSab(friday);
  const intro = `Por medio del presente solicito pago de tiempo extra correspondiente del día ${fmtDateHuman(inicio)} al ${fmtDateHuman(fin)} para pagar el ${fechaPagoTexto}.`;

  // iOS: PDF imprime SOLO lo que se paga este viernes (no incluye semanales excluidos)
  const pagables = (dueT||[])
    .filter(t=> !isExcluded(t, friday))
    .slice()
    .sort(sortByBodNombre);

  const table = buildMemoTableTE(pagables);
  const html = memoShell({
    docTitle: `memo_tiempo_extra_${fmtDateDMY(friday)}`,
    visibleTitle: 'MEMORÁNDUM Tiempo extra',
    headerLines: [
      `FECHA: ${fechaHoy}`,
      'PARA: Departamento Recursos Humanos',
      'ASUNTO: Pago de tiempo extra'
    ],
    introHtml: escapeHtml(intro),
    tableHtml: table
  });

  openPrintWindow(html);
}

function buildMemoTableGrat(list){
  const rows = list.map(g=>{
    const e = empOf(g) || {};
    return `
      <tr>
        <td data-label="Empleado" style="width:45%">${escapeHtml(e.nombre||'—')}</td>
        <td data-label="Monto" class="right" style="width:15%">${escapeHtml(fmtMoney(g.monto))}</td>
        <td data-label="Motivo" style="width:40%">${escapeHtml(g.motivo||'—')}</td>
      </tr>
    `;
  }).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Nombre del empleado</th>
          <th class="right">Monto $</th>
          <th>Motivo</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildMemoTableTE(list){
  const rows = list.map(t=>{
    const e = empOf(t) || {};
    const horasTxt = Number(t.horas||0).toFixed(2);
    return `
      <tr>
        <td data-label="Empleado" style="width:45%">${escapeHtml(e.nombre||'—')}</td>
        <td data-label="Horas" class="right" style="width:12%">${escapeHtml(horasTxt)}</td>
        <td data-label="Motivo" style="width:43%">${escapeHtml(t.motivo||'—')}</td>
      </tr>
    `;
  }).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Nombre del empleado</th>
          <th class="right">Horas</th>
          <th>Motivo</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function rangoSemanaAnterior_LunSab(viernesDePago){
  const cal = new Date(viernesDePago);
  cal.setHours(0,0,0,0);
  // weekday: 0=Dom ... 5=Vie ... 6=Sáb
  const weekday = cal.getDay();
  // delta hasta lunes (1)
  const deltaHastaLunes = (weekday - 1 + 7) % 7;
  const lunesSemanaActual = addDays(cal, -deltaHastaLunes);
  const lunesSemanaAnterior = addDays(lunesSemanaActual, -7);
  const sabadoSemanaAnterior = addDays(lunesSemanaAnterior, 5);
  return { inicio: lunesSemanaAnterior, fin: sabadoSemanaAnterior };
}

function addDays(date, days){
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  d.setHours(0,0,0,0);
  return d;
}

function printReport(){
  const rep = window.__lastReport;
  if(!rep) return;
  const { friday, dueG, dueT } = rep;

  const html = `
    <html><head><title>Reporte ${fmtDateISO(friday)}</title>
      <style>
        body{font-family:Arial, sans-serif; padding:24px}
        h1{margin:0 0 6px 0}
        h2{margin:18px 0 8px 0}
        table{width:100%; border-collapse:collapse}
        th,td{border:1px solid #ddd; padding:8px; font-size:12px}
        th{background:#f6f6f6}
      </style>
    </head><body>
      <h1>Pagos por viernes</h1>
      <div>Viernes: <b>${friday.toLocaleDateString('es-MX',{weekday:'long', year:'numeric',month:'long',day:'2-digit'})}</b></div>

      <h2>Gratificaciones (${dueG.length})</h2>
      ${printTable(dueG, 'grat')}

      <h2>Tiempo extra (${dueT.length})</h2>
      ${printTable(dueT, 'te')}

      <script>window.print();</script>
    </body></html>
  `;

  const w = window.open('', '_blank');
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function printTable(list, kind){
  const rows = list.map(x=>{
    const e = empOf(x) || {};
    const val = kind==='grat' ? fmtMoney(x.monto) : `${Number(x.horas||0)} h`;
    return `<tr>
      <td>${escapeHtml(e.nomina||'')}</td>
      <td>${escapeHtml(e.nombre||'')}</td>
      <td>${escapeHtml(e.bod||'')}</td>
      <td>${escapeHtml(e.puesto||'')}</td>
      <td>${escapeHtml(x.motivo||'')}</td>
      <td>${escapeHtml(programaLabel(x.programa))}</td>
      <td style="text-align:right">${val}</td>
    </tr>`;
  }).join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Nómina</th><th>Nombre</th><th>BOD</th><th>Puesto</th><th>Motivo</th><th>Programa</th><th>${kind==='grat'?'Monto':'Horas'}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------------------------
// Permanencia
// ---------------------------
function yearsMonthsDays(from, to){
  // rough but stable for display
  const a = new Date(from); a.setHours(0,0,0,0);
  const b = new Date(to); b.setHours(0,0,0,0);

  let years = b.getFullYear() - a.getFullYear();
  let months = b.getMonth() - a.getMonth();
  let days = b.getDate() - a.getDate();

  if(days < 0){
    months -= 1;
    const prevMonth = new Date(b.getFullYear(), b.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if(months < 0){
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}

function nextAnniversary(date){
  const d = new Date(date);
  const now = new Date();
  let y = now.getFullYear();
  const cand = new Date(y, d.getMonth(), d.getDate());
  cand.setHours(0,0,0,0);
  if(cand < new Date(now.getFullYear(), now.getMonth(), now.getDate())){
    y += 1;
  }
  const out = new Date(y, d.getMonth(), d.getDate());
  out.setHours(0,0,0,0);
  return out;
}

async function refreshPermanencia(){
  if(!connected) return;
  if(empleados.length===0) empleados = await fetchEmpleados();

  const bod = $('#permBod').value;
  const now = new Date();
  const list = empleados
    .filter(e=> e.fecha_ingreso)
    .filter(e=> !bod || e.bod===bod)
    .filter(e=> e.estatus !== 'Baja')
    .map(e=>{
      const antig = yearsMonthsDays(new Date(e.fecha_ingreso), now);
      const ann = nextAnniversary(new Date(e.fecha_ingreso));
      const daysLeft = Math.round((ann - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / (1000*60*60*24));
      return { e, antig, ann, daysLeft };
    })
    .sort((a,b)=> a.daysLeft - b.daysLeft);

  const root = $('#permList');
  root.innerHTML = '';
  if(list.length===0){
    root.innerHTML = `<div class="emptyState"><div class="emoji">🕰️</div><div><div class="emptyTitle">Sin datos</div><div class="emptySub">Asegúrate de tener fecha de ingreso.</div></div></div>`;
    return;
  }

  for(const it of list){
    const e = it.e;
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(e.nombre||'—')}</div>
        <div class="sub">#${escapeHtml(e.nomina)} • BOD ${escapeHtml(e.bod||'—')} • ${escapeHtml(e.puesto||'—')}</div>
        <div class="sub">Antigüedad: <b>${it.antig.years}a ${it.antig.months}m ${it.antig.days}d</b> • Ingreso: ${fmtDateHuman(e.fecha_ingreso)}</div>
      </div>
      <div class="badges">
        <span class="badge">Aniversario: ${fmtDateHuman(it.ann)}</span>
        <span class="badge ${it.daysLeft<=30?'warn':''}">Faltan ${it.daysLeft} días</span>
      </div>
    `;
    div.addEventListener('click', async ()=>{
      $('[data-tab="personal"]').click();
      await selectEmpleado(e.id);
    });
    root.appendChild(div);
  }
}

// ---------------------------
// CSV import/export (empleados)
// ---------------------------
function splitCSVLine(line){
  const out=[];
  let cur='';
  let inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(c==='"'){
      if(inQ && i+1<line.length && line[i+1]==='"'){
        cur+='"';
        i++;
      } else {
        inQ=!inQ;
      }
    } else if(c===',' && !inQ){
      out.push(cur);
      cur='';
    } else {
      cur+=c;
    }
  }
  out.push(cur);
  return out;
}

function idx(headers, name){
  const n = name.toLowerCase();
  return headers.findIndex(h => String(h).trim().toLowerCase() === n);
}

function parseDateTryMany(s){
  const t = (s||'').trim();
  if(!t) return null;
  // Accept ISO
  if(/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0,10);
  // dd/MM/yyyy
  const m1 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m1){
    const dd = String(m1[1]).padStart(2,'0');
    const mm = String(m1[2]).padStart(2,'0');
    const yy = m1[3];
    return `${yy}-${mm}-${dd}`;
  }
  // dd-MM-yyyy
  const m2 = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if(m2){
    const dd = String(m2[1]).padStart(2,'0');
    const mm = String(m2[2]).padStart(2,'0');
    const yy = m2[3];
    return `${yy}-${mm}-${dd}`;
  }
  // MM/dd/yyyy
  const m3 = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(m3){
    const mm = String(m3[1]).padStart(2,'0');
    const dd = String(m3[2]).padStart(2,'0');
    const yy = m3[3];
    return `${yy}-${mm}-${dd}`;
  }
  return null;
}

async function importCSVFile(file){
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if(lines.length<2) throw new Error('CSV vacío');
  const headers = splitCSVLine(lines[0]);

  const iNom = Math.max(idx(headers, '# NOMINA'), idx(headers,'NOMINA'));
  const iNomina = iNom >= 0 ? iNom : 0;
  const iNombre = (idx(headers,'NOMBRE')>=0 ? idx(headers,'NOMBRE') : 1);
  const iFecha = (idx(headers,'fecha de ingreso')>=0 ? idx(headers,'fecha de ingreso') : 2);
  const iDepa = (idx(headers,'DEPARTAMENTO')>=0 ? idx(headers,'DEPARTAMENTO') : 3);
  const iPuesto = (idx(headers,'PUESTO')>=0 ? idx(headers,'PUESTO') : 4);
  const iBod = (idx(headers,'BOD')>=0 ? idx(headers,'BOD') : 5);
  const iLoc = (idx(headers,'localiza')>=0 ? idx(headers,'localiza') : 6);
  const iEst = (idx(headers,'EstatusActual')>=0 ? idx(headers,'EstatusActual') : -1);
  const iObs = (idx(headers,'Observaciones')>=0 ? idx(headers,'Observaciones') : -1);

  const upserts = [];
  for(const line of lines.slice(1)){
    const p = splitCSVLine(line);
    if(p.length <= iBod) continue;

    const nomina = (p[iNomina]||'').trim();
    if(!nomina) continue;

    const nombre = (p[iNombre]||'').trim();
    const nombreUpper = nombre.toUpperCase();
    const esVac = nombreUpper.includes('VAC') || nombreUpper.includes('VACANTE');
    const obs = iObs>=0 && iObs<p.length ? String(p[iObs]||'') : '';
    const esExtra = obs.toUpperCase().includes('EXTRA');

    const bod = (p[iBod]||'').trim().toUpperCase();
    const puesto = (p[iPuesto]||'').trim();
    const loc = (p[iLoc]||'').trim().toUpperCase();
    const est = iEst>=0 && iEst<p.length ? (p[iEst]||'Activo').trim() : 'Activo';

    upserts.push({
      nomina,
      nombre,
      fecha_ingreso: parseDateTryMany(p[iFecha]||'') || null,
      departamento: (p[iDepa]||'').trim(),
      puesto: PUESTOS.includes(puesto) ? puesto : 'AUXILIAR',
      bod: BODS.includes(bod) ? bod : 'AC',
      localiza: LOCALIZA.includes(loc) ? loc : 'AGS',
      estatus: ESTATUS.includes(est) ? est : 'Activo',
      es_vacante: esVac,
      es_extra: esExtra,
    });
  }

  // upsert by unique nomina
  const chunkSize = 500;
  for(let i=0;i<upserts.length;i+=chunkSize){
    const chunk = upserts.slice(i,i+chunkSize);
    const { error } = await supabase.from('empleados').upsert(chunk, { onConflict:'nomina' });
    if(error) throw error;
  }

  toast(`Importados/actualizados: ${upserts.length}`);
}

// ---------------------------
// CSV import (gratificaciones / tiempo extra)
// ---------------------------
function parseBoolSi(s){
  const t = (s||'').trim().toLowerCase();
  if(!t) return false;
  return t === 'sí' || t === 'si' || t.startsWith('s');
}

function parseActivaFromEstado(s){
  const t = (s||'').trim().toLowerCase();
  if(!t) return true;
  // En el backup iOS: "Vigente" vs "Pagada"
  if(t.includes('pagad')) return false;
  return true;
}

async function buildEmpleadoNameMap(){
  // usa la lista en memoria si existe, si no, recarga
  if(!empleados?.length) empleados = await fetchEmpleados();
  const map = new Map();
  for(const e of empleados){
    const k = normalizeName(e.nombre||'');
    if(!k) continue;
    if(!map.has(k)) map.set(k, e.id);
  }
  return map;
}

async function importGratificacionesCSV(file){
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if(lines.length<2) throw new Error('CSV vacío');
  const headers = splitCSVLine(lines[0]);

  const iNombre = idx(headers,'Nombre');
  const iMotivo = idx(headers,'Motivo');
  const iMonto  = idx(headers,'Monto');
  const iProg   = idx(headers,'Programa');
  const iFObj   = idx(headers,'FechaObjetivo');
  const iSV     = idx(headers,'SinVigencia');
  const iVig    = idx(headers,'VigenciaHastaMes');
  const iEst    = idx(headers,'Estado');

  if(iNombre<0 || iMotivo<0 || iMonto<0) throw new Error('CSV de gratificaciones no reconocido');

  const nameMap = await buildEmpleadoNameMap();
  const inserts = [];
  const noMatch = [];

  for(const line of lines.slice(1)){
    const p = splitCSVLine(line);
    if(!p.length) continue;
    const nombre = (p[iNombre]||'').trim();
    if(!nombre) continue;
    const empId = nameMap.get(normalizeName(nombre));
    if(!empId){
      noMatch.push(nombre);
      continue;
    }
    const motivo = (p[iMotivo]||'').trim();
    const monto = Number((p[iMonto]||'0').replace(/[^0-9.\-]/g,'')) || 0;
    const programa = programaFromLabel(p[iProg]||'');
    const fecha_objetivo = parseDateTryMany(p[iFObj]||'') || null;
    const sin_vigencia = parseBoolSi(p[iSV]||'');
    const vigencia_hasta_mes = parseDateTryMany(p[iVig]||'') || null;
    const activa = parseActivaFromEstado(p[iEst]||'');

    inserts.push({
      empleado_id: empId,
      motivo: motivo || '(sin motivo)',
      monto,
      programa,
      fecha_objetivo,
      sin_vigencia,
      vigencia_hasta_mes,
      activa,
    });
  }

  const chunkSize = 500;
  for(let i=0;i<inserts.length;i+=chunkSize){
    const chunk = inserts.slice(i,i+chunkSize);
    const { error } = await supabase.from('gratificaciones').insert(chunk);
    if(error) throw error;
  }

  if(noMatch.length){
    console.warn('No se encontraron empleados para:', noMatch);
  }

  toast(`Gratificaciones importadas: ${inserts.length}${noMatch.length ? ` • Sin match: ${noMatch.length}`:''}`);
}

async function importTiempoExtraCSV(file){
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
  if(lines.length<2) throw new Error('CSV vacío');
  const headers = splitCSVLine(lines[0]);

  const iNombre = idx(headers,'Nombre');
  const iMotivo = idx(headers,'Motivo');
  const iHoras  = idx(headers,'Horas');
  const iProg   = idx(headers,'Programa');
  const iFObj   = idx(headers,'FechaObjetivo');
  const iSV     = idx(headers,'SinVigencia');
  const iVig    = idx(headers,'VigenciaHastaMes');
  const iEst    = idx(headers,'Estado');

  if(iNombre<0 || iMotivo<0 || iHoras<0) throw new Error('CSV de tiempo extra no reconocido');

  const nameMap = await buildEmpleadoNameMap();
  const inserts = [];
  const noMatch = [];

  for(const line of lines.slice(1)){
    const p = splitCSVLine(line);
    if(!p.length) continue;
    const nombre = (p[iNombre]||'').trim();
    if(!nombre) continue;
    const empId = nameMap.get(normalizeName(nombre));
    if(!empId){
      noMatch.push(nombre);
      continue;
    }
    const motivo = (p[iMotivo]||'').trim();
    const horas = Number((p[iHoras]||'0').replace(/[^0-9.\-]/g,'')) || 0;
    const programa = programaFromLabel(p[iProg]||'');
    const fecha_objetivo = parseDateTryMany(p[iFObj]||'') || null;
    const sin_vigencia = parseBoolSi(p[iSV]||'');
    const vigencia_hasta_mes = parseDateTryMany(p[iVig]||'') || null;
    const activa = parseActivaFromEstado(p[iEst]||'');

    inserts.push({
      empleado_id: empId,
      motivo: motivo || '(sin motivo)',
      horas,
      programa,
      fecha_objetivo,
      sin_vigencia,
      vigencia_hasta_mes,
      activa,
    });
  }

  const chunkSize = 500;
  for(let i=0;i<inserts.length;i+=chunkSize){
    const chunk = inserts.slice(i,i+chunkSize);
    const { error } = await supabase.from('tiempo_extra').insert(chunk);
    if(error) throw error;
  }

  if(noMatch.length){
    console.warn('No se encontraron empleados para:', noMatch);
  }

  toast(`Tiempo extra importado: ${inserts.length}${noMatch.length ? ` • Sin match: ${noMatch.length}`:''}`);
}

async function exportEmpleadosCSV(){
  const list = await fetchEmpleados();
  const headers = ['# NOMINA','NOMBRE','fecha de ingreso','DEPARTAMENTO','PUESTO','BOD','localiza','EstatusActual','Observaciones'];
  const lines = [headers.join(',')];

  for(const e of list){
    const nombreFinal = e.es_vacante ? 'VACANTE' : (e.nombre||'');
    const obs = e.es_extra ? 'EXTRA' : '';
    const row = [
      safeCSV(e.nomina),
      safeCSV(nombreFinal),
      safeCSV(e.fecha_ingreso ? fmtDateISO(e.fecha_ingreso) : ''),
      safeCSV(e.departamento||''),
      safeCSV(e.puesto||''),
      safeCSV(e.bod||''),
      safeCSV(e.localiza||''),
      safeCSV(e.estatus||''),
      safeCSV(obs)
    ];
    lines.push(row.join(','));
  }

  downloadText(lines.join('\n'), 'plantilla_personal_export.csv', 'text/csv;charset=utf-8');
}

function estadoTri(record){
  // Solo 3 estados para export (compat con backups): Vigente | Pagada | Cancelada
  if(!record?.activa) return 'Cancelada';
  if(record.programa === 'unicaViernes' && record.fecha_objetivo){
    const f = fridayOfWeek(parseDateLocal(record.fecha_objetivo) || new Date(record.fecha_objetivo));
    const today = new Date(); today.setHours(0,0,0,0);
    if(f && f.getTime() < today.getTime()) return 'Pagada';
  }
  return 'Vigente';
}

function fechaPagoTri(record){
  if(estadoTri(record) !== 'Pagada') return '';
  const f = fridayOfWeek(parseDateLocal(record.fecha_objetivo) || new Date(record.fecha_objetivo));
  return f ? fmtDateISO(f) : '';
}

function exportGratificacionesCSV(){
  const q = ($('#gratSearch')?.value||'').trim().toLowerCase();
  const prog = $('#gratPrograma')?.value || '';
  let list = gratificacionesGlobal || [];
  if(prog) list = list.filter(g=>g.programa === prog);

  const empById = new Map((empleados||[]).map(e=>[e.id, e]));
  if(q){
    list = list.filter(g=>{
      const emp = empById.get(g.empleado_id);
      const hay = `${emp?.nombre||''} ${g.motivo||''} ${emp?.bod||''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const headers = ['Nombre','Motivo','Monto','Programa','FechaObjetivo','SinVigencia','VigenciaHastaMes','Estado','FechaPago'];
  const lines = [headers.join(',')];

  for(const g of list){
    const emp = empById.get(g.empleado_id);
    const estado = estadoTri(g);
    const row = [
      safeCSV(emp?.nombre || ''),
      safeCSV(g.motivo || ''),
      safeCSV(Number(g.monto||0).toFixed(2)),
      safeCSV(g.programa || ''),
      safeCSV(g.fecha_objetivo ? fmtDateISO(g.fecha_objetivo) : ''),
      safeCSV(g.sin_vigencia ? 'Si' : 'No'),
      safeCSV(g.vigencia_hasta_mes ? fmtDateISO(g.vigencia_hasta_mes) : ''),
      safeCSV(estado),
      safeCSV(fechaPagoTri(g)),
    ];
    lines.push(row.join(','));
  }

  downloadText(lines.join('\n'), `gratificaciones_export_${fmtDateDMY(new Date())}.csv`, 'text/csv;charset=utf-8');
}

function exportTiempoExtraCSV(){
  const q = ($('#teSearch')?.value||'').trim().toLowerCase();
  const prog = $('#tePrograma')?.value || '';
  let list = tiempoExtraGlobal || [];
  if(prog) list = list.filter(t=>t.programa === prog);

  const empById = new Map((empleados||[]).map(e=>[e.id, e]));
  if(q){
    list = list.filter(t=>{
      const emp = empById.get(t.empleado_id);
      const hay = `${emp?.nombre||''} ${t.motivo||''} ${emp?.bod||''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  const headers = ['Nombre','Motivo','Horas','Programa','FechaObjetivo','SinVigencia','VigenciaHastaMes','Estado','FechaPago'];
  const lines = [headers.join(',')];

  for(const t of list){
    const emp = empById.get(t.empleado_id);
    const estado = estadoTri(t);
    const row = [
      safeCSV(emp?.nombre || ''),
      safeCSV(t.motivo || ''),
      safeCSV(String(Number(t.horas||0))),
      safeCSV(t.programa || ''),
      safeCSV(t.fecha_objetivo ? fmtDateISO(t.fecha_objetivo) : ''),
      safeCSV(t.sin_vigencia ? 'Si' : 'No'),
      safeCSV(t.vigencia_hasta_mes ? fmtDateISO(t.vigencia_hasta_mes) : ''),
      safeCSV(estado),
      safeCSV(fechaPagoTri(t)),
    ];
    lines.push(row.join(','));
  }

  downloadText(lines.join('\n'), `tiempo_extra_export_${fmtDateDMY(new Date())}.csv`, 'text/csv;charset=utf-8');
}

// ---------------------------
// Refresh orchestrators
// ---------------------------
async function refreshEmpleados(){
  empleados = await fetchEmpleados();
  renderEmpleados();
}

async function refreshGratificacionesGlobal(){
  if(!empleados || empleados.length===0){
    try{ empleados = await fetchEmpleados(); }catch(_){/* ignore */}
  }
  gratificacionesGlobal = await fetchGratificacionesGlobal();
  renderGratificacionesGlobal();
}

async function refreshTiempoExtraGlobal(){
  if(!empleados || empleados.length===0){
    try{ empleados = await fetchEmpleados(); }catch(_){/* ignore */}
  }
  tiempoExtraGlobal = await fetchTiempoExtraGlobal();
  renderTiempoExtraGlobal();
}

async function refreshAll(){
  if(!connected) return;
  await refreshEmpleados();
  // don't always load globals unless tab is active, but keep report stable
  gratificacionesGlobal = await fetchGratificacionesGlobal();
  tiempoExtraGlobal = await fetchTiempoExtraGlobal();

  if($('#tab-gratificaciones').classList.contains('active')) renderGratificacionesGlobal();
  if($('#tab-tiempoextra').classList.contains('active')) renderTiempoExtraGlobal();
  if($('#tab-reportes').classList.contains('active')) await refreshReport();
  if($('#tab-permanencia').classList.contains('active')) await refreshPermanencia();
}

// ---------------------------
// Wire UI events
// ---------------------------
function setupUI(){
  renderBodSelects();
  // Auth (login/logout)
  const dlgLogin = document.getElementById('dlgLogin');
  const btnLogin = document.getElementById('btnLogin');
  const btnLogout = document.getElementById('btnLogout');
  if(btnLogin){
    btnLogin.addEventListener('click', async ()=>{
      const email = (document.getElementById('loginEmail')?.value || '').trim();
      const pass = (document.getElementById('loginPass')?.value || '').trim();
      if(!email || !pass){ toast('Captura correo y contraseña', 'bad'); return; }
      const { error } = await supabase.auth.signInWithPassword({ email, password: pass });
      if(error){ toast(error.message || 'No se pudo iniciar sesión', 'bad'); return; }
      if(dlgLogin?.open) dlgLogin.close();
      await connect();
  if(!connected){
    document.getElementById('dlgLogin')?.showModal();
  }
    });
  }
  if(btnLogout){
    btnLogout.addEventListener('click', async ()=>{
      await supabase.auth.signOut();
      connected = false;
      currentSession = null;
      currentUserEmail = '';
      setConnStatus();
      // Limpia listas en UI
      empleados = []; gratificacionesGlobal = []; tiempoExtraGlobal = [];
      renderEmpleados(); renderGratificacionesGlobal(); renderTiempoExtraGlobal();
      toast('Sesión cerrada');
      dlgLogin?.showModal();
    });
  }

  supabase.auth.onAuthStateChange((_event, session)=>{
    currentSession = session;
    connected = !!session;
    currentUserEmail = session?.user?.email || '';
    setConnStatus();
    if(!session){ dlgLogin?.showModal(); }
  });


  // Logo prefs (live preview)
  document.getElementById('logoMode')?.addEventListener('change', (e)=>{
    const mode = e.target.value;
    const bg = document.getElementById('logoBg')?.value || 'white';
    applyLogoPrefs(mode, bg);
  });
  document.getElementById('logoBg')?.addEventListener('change', (e)=>{
    const bg = e.target.value;
    const mode = document.getElementById('logoMode')?.value || 'full';
    applyLogoPrefs(mode, bg);
  });

  // Quick toggle by tapping the logo (handy on mobile)
  document.getElementById('btnLogo')?.addEventListener('click', ()=>{
    const cur = localStorage.getItem(LS_LOGO_MODE) || 'full';
    const next = cur === 'full' ? 'icon' : 'full';
    localStorage.setItem(LS_LOGO_MODE, next);
    const bg = localStorage.getItem(LS_LOGO_BG) || 'white';
    applyLogoPrefs(next, bg);
    // keep settings fields in sync if modal is open
    const modeSel = document.getElementById('logoMode');
    if(modeSel) modeSel.value = next;
  });

  // Personal filters
  ['empSearch','empBod','empEstatus'].forEach(id=>{
    $(`#${id}`).addEventListener('input', renderEmpleados);
    $(`#${id}`).addEventListener('change', renderEmpleados);
  });

  // Crear desde tabs globales (como iOS)
  $('#btnNewGrat')?.addEventListener('click', async ()=>{
    await pickEmpleado({
      title: 'Nueva gratificación — elige empleado',
      onPick: (e)=> openGratForm({ empleado_id: e.id, activa: true, sin_vigencia: true, programa:'segundaSemanaViernes' })
    });
  });
  $('#btnNewTE')?.addEventListener('click', async ()=>{
    await pickEmpleado({
      title: 'Nuevo tiempo extra — elige empleado',
      onPick: (e)=> openTEForm({ empleado_id: e.id, activa: true, programa:'cadaSemanaViernes' })
    });
  });

  // New employee
  $('#btnNewEmpleado').addEventListener('click', ()=> openEmpleadoForm(null));

  // Import
  const fileInput = $('#fileInput');
  $('#btnImportCSV').addEventListener('click', ()=> fileInput.click());
  fileInput.addEventListener('change', async ()=>{
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if(!file) return;
    try{
      await importCSVFile(file);
      await refreshEmpleados();
    }catch(err){
      console.error(err);
      toast(err.message || 'Error importando', 'bad');
    }
  });

  // Import gratificaciones
  const fileInputGrat = $('#fileInputGrat');
  $('#btnImportGratCSV').addEventListener('click', ()=> fileInputGrat.click());
  fileInputGrat.addEventListener('change', async ()=>{
    const file = fileInputGrat.files?.[0];
    fileInputGrat.value = '';
    if(!file) return;
    try{
      await importGratificacionesCSV(file);
      await refreshGratificacionesGlobal();
      // reportes se alimentan de globals
      if($('#tab-reportes').classList.contains('active')) await refreshReport();
    }catch(err){
      console.error(err);
      toast(err.message || 'Error importando gratificaciones', 'bad');
    }
  });

  // Import tiempo extra
  const fileInputTE = $('#fileInputTE');
  $('#btnImportTECSV').addEventListener('click', ()=> fileInputTE.click());
  fileInputTE.addEventListener('change', async ()=>{
    const file = fileInputTE.files?.[0];
    fileInputTE.value = '';
    if(!file) return;
    try{
      await importTiempoExtraCSV(file);
      await refreshTiempoExtraGlobal();
      if($('#tab-reportes').classList.contains('active')) await refreshReport();
    }catch(err){
      console.error(err);
      toast(err.message || 'Error importando tiempo extra', 'bad');
    }
  });

  // Export
  $('#btnExportCSV').addEventListener('click', async ()=>{
    try{ await exportEmpleadosCSV(); }catch(e){ toast('No se pudo exportar', 'bad'); }
  });

  // Export Gratificaciones / Tiempo Extra
  $('#btnExportGratCSV')?.addEventListener('click', ()=>{
    try{ exportGratificacionesCSV(); }catch(e){ console.error(e); toast('No se pudo exportar gratificaciones', 'bad'); }
  });
  $('#btnExportTECSV')?.addEventListener('click', ()=>{
    try{ exportTiempoExtraCSV(); }catch(e){ console.error(e); toast('No se pudo exportar tiempo extra', 'bad'); }
  });

  // Global searches
  $('#gratSearch').addEventListener('input', renderGratificacionesGlobal);
  $('#gratPrograma').addEventListener('change', renderGratificacionesGlobal);
  $('#gratEstado')?.addEventListener('change', renderGratificacionesGlobal);
  $('#teSearch').addEventListener('input', renderTiempoExtraGlobal);
  $('#tePrograma').addEventListener('change', renderTiempoExtraGlobal);
  $('#teEstado')?.addEventListener('change', renderTiempoExtraGlobal);

  // Reportes
  $('#btnRefreshReport').addEventListener('click', refreshReport);
  $('#repFriday').addEventListener('change', refreshReport);
  $('#repSearch')?.addEventListener('input', refreshReport);
  $('#btnExportReportCSV').addEventListener('click', exportReportCSV);
  $('#btnPrintGratMemo').addEventListener('click', printGratMemo);
  $('#btnPrintTEMemo').addEventListener('click', printTEMemo);

  // Permanencia
  $('#btnRefreshPerm').addEventListener('click', refreshPermanencia);
  $('#permBod').addEventListener('change', refreshPermanencia);

  // Mobile employee overlay
  const back = document.getElementById('empOverlayBack');
  if(back) back.addEventListener('click', requestCloseEmpOverlay);
  const ov = document.getElementById('empOverlay');
  if(ov){
    // tap the dimmed area to close (but not when tapping inside card)
    ov.addEventListener('click', (e)=>{
      if(e.target === ov) requestCloseEmpOverlay();
    });

    // Swipe-back gesture (like iOS): swipe right from the left edge to close.
    let tsX = 0, tsY = 0, tracking = false;
    ov.addEventListener('touchstart', (e)=>{
      const t = e.touches?.[0];
      if(!t) return;
      // Only if starting near the left edge (avoid accidental closes while scrolling).
      tracking = (t.clientX <= 24);
      tsX = t.clientX; tsY = t.clientY;
    }, { passive:true });
    ov.addEventListener('touchmove', (e)=>{
      if(!tracking) return;
      const t = e.touches?.[0];
      if(!t) return;
      const dx = t.clientX - tsX;
      const dy = t.clientY - tsY;
      if(dx > 70 && Math.abs(dy) < 40){
        tracking = false;
        requestCloseEmpOverlay();
      }
    }, { passive:true });
  }
}

// ---------------------------
// Boot
// ---------------------------
(async function main(){
  setupTabs();
  setupUI();
  setConnStatus();
  loadLogoFromStorage();

  // default friday
  $('#repFriday').value = fmtDateISO(nextFriday(new Date()));

  await connect();
  if(!connected){
    document.getElementById('dlgLogin')?.showModal();
  }

  // keyboard help
  window.addEventListener('keydown', (e)=>{
    if(e.key==='Escape'){
      const dlg = $('#dlg');
      if(dlg.open) dlg.close();
      requestCloseEmpOverlay();
    }
  });

  // If the user hits browser back while the overlay is open, close it and return.
  window.addEventListener('popstate', ()=>{
    const ov = document.getElementById('empOverlay');
    if(ov?.classList.contains('show')){
      closeEmpOverlayAndReturn({ viaHistory:true });
    }
  });
})();