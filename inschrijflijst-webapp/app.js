'use strict';

/* ============================================================
   Inschrijflijst Nieuwvliet — منطق التطبيق
   الداتا كلها بـ Supabase (جدول workers)
   أي تعديل من جهاز بيوصل فوراً للجهاز التاني عن طريق Supabase Realtime
   ============================================================ */

const sb = window.supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);

const LS_COMPOSE = "nieuwvliet_compose_v1";
const LS_WORKERS_COLLAPSED = "nieuwvliet_workers_collapsed_v1";

let workers = [];
let composeList = [];
let editingId = null;
let highlightIndex = 0;
let pendingDelete = null;
let importState = { headers: [], rows: [] };

/* ---------------- helpers ---------------- */

function $(id){ return document.getElementById(id); }
function escapeHtml(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
  });
}
function hasArabic(s){ return /[؀-ۿ]/.test(s || ""); }
function todayISO(){
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function daysUntil(iso){
  if (!iso) return null;
  const a = new Date(iso + "T00:00:00");
  const b = new Date(todayISO() + "T00:00:00");
  if (isNaN(a.getTime())) return null;
  return Math.round((a - b) / 86400000);
}
function expiryStatus(w){
  const d = daysUntil(w.geldig_tot);
  if (d === null) return "none";
  if (d < 0) return "expired";
  if (d <= 30) return "soon";
  return "ok";
}
function fmtDateDisplay(iso){
  if (!iso) return "—";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  return p[2] + "/" + p[1] + "/" + p[0];
}
function labelJaNee(v){ return v === "ja" ? "Ja" : "Nee"; }
function labelJaNeeNvt(v){ return v === "ja" ? "Ja" : (v === "nee" ? "Nee" : "N.v.t."); }
function fullName(w){ return [(w.voornaam||"").trim(), (w.achternaam||"").trim()].filter(Boolean).join(" "); }
function sortKey(w){ return [(w.voornaam||"").trim(), (w.achternaam||"").trim()].filter(Boolean).join(" ").toLocaleLowerCase("nl"); }
function applyTagToName(voornaam, achternaam, tag){
  voornaam = (voornaam || "").trim();
  achternaam = (achternaam || "").trim();
  if (!tag) return { voornaam, achternaam };
  if (achternaam) return { voornaam, achternaam: achternaam + " (" + tag + ")" };
  return { voornaam: voornaam + " (" + tag + ")", achternaam: "" };
}

let toastTimer = null;
function toast(msg){
  let t = document.querySelector(".toast");
  if (!t){ t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3800);
}

function saveComposeLocal(){ try { localStorage.setItem(LS_COMPOSE, JSON.stringify(composeList)); } catch(e){} }
function loadComposeLocal(){ try { return JSON.parse(localStorage.getItem(LS_COMPOSE)) || []; } catch(e){ return []; } }

/* ---------------- auth ---------------- */

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const errEl = $("loginError");
  errEl.textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) errEl.textContent = "تعذر الدخول — تأكد من الإيميل وكلمة السر";
});

document.getElementById("logoutBtn").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((_event, session) => {
  if (session) showApp(session);
  else showLogin();
});

function showLogin(){
  $("loginScreen").hidden = false;
  $("appScreen").hidden = true;
}

let bootedOnce = false;
async function showApp(session){
  $("loginScreen").hidden = true;
  $("appScreen").hidden = false;
  $("userChip").textContent = session.user.email;
  if (bootedOnce) return;
  bootedOnce = true;
  $("expDate").value = todayISO();
  composeList = loadComposeLocal();
  wireEvents();
  renderCompose();
  await loadWorkers();
  subscribeRealtime();
}

/* ---------------- data loading (Supabase) ---------------- */

async function loadWorkers(){
  const { data, error } = await sb.from("workers").select("*").order("achternaam").order("voornaam");
  if (error){
    toast("تعذّر تحميل بيانات العمّال: " + error.message);
    return;
  }
  workers = data || [];
  onWorkersChanged();
}

function subscribeRealtime(){
  const dot = $("syncDot");
  const lbl = $("syncLabel");
  sb.channel("workers-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "workers" }, () => { loadWorkers(); })
    .subscribe((status) => {
      const ok = status === "SUBSCRIBED";
      dot.classList.toggle("offline", !ok);
      lbl.textContent = ok ? "متصل — تحديث لحظي" : "جاري الاتصال...";
    });
}

async function addWorker(data){
  const { error } = await sb.from("workers").insert(data);
  if (error) throw error;
  await loadWorkers();
}
async function updateWorkerRecord(id, data){
  const { error } = await sb.from("workers").update(data).eq("id", id);
  if (error) throw error;
  await loadWorkers();
}
async function deleteWorkerRecord(id){
  const { error } = await sb.from("workers").delete().eq("id", id);
  if (error) throw error;
  await loadWorkers();
}

/* ---------------- rendering: stats + alerts ---------------- */

function onWorkersChanged(){
  renderStats();
  updateAlertsButton();
  renderWorkersTable();
  renderComposeSearch();
}

function renderStats(){
  $("statTotal").textContent = workers.length;
  $("statCompose").textContent = composeList.length;
}

function computeAlerts(){
  const byExpiry = (a,b) => (daysUntil(a.geldig_tot) ?? 0) - (daysUntil(b.geldig_tot) ?? 0);
  const byName = (a,b) => sortKey(a).localeCompare(sortKey(b), "nl");
  return {
    expired: workers.filter(w => expiryStatus(w) === "expired").sort(byExpiry),
    soon: workers.filter(w => expiryStatus(w) === "soon").sort(byExpiry),
    missingBsn: workers.filter(w => !w.bsn || !String(w.bsn).trim()).sort(byName),
  };
}

function updateAlertsButton(){
  const { expired, soon, missingBsn } = computeAlerts();
  const total = expired.length + soon.length + missingBsn.length;
  const badge = $("alertsBadge");
  badge.textContent = total;
  badge.className = "badge " + (expired.length ? "expired" : (soon.length || missingBsn.length ? "soon" : "none"));
}

function openAlertsModal(){
  const { expired, soon, missingBsn } = computeAlerts();
  if (!expired.length && !soon.length && !missingBsn.length){
    toast("ما في أي تنبيهات حالياً — كلشي تمام.");
    return;
  }

  function section(title, cls, list, detail){
    if (!list.length) return "";
    return "<h3 class=\"" + cls + "\">" + title + " (" + list.length + ")</h3><ul>" +
      list.map(w => "<li>" + escapeHtml(fullName(w)) + (detail ? " — " + escapeHtml(detail(w)) : "") + "</li>").join("") +
      "</ul>";
  }

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = "<div class=\"modal\">" +
    "<h3>التنبيهات</h3>" +
    "<p class=\"sub\" style=\"margin:0 0 4px;\">هويات منتهية أو قاربت الانتهاء، وعمّال بدون رقم BSN.</p>" +
    section("هويات منتهية", "alert-danger", expired, w => "منتهية منذ " + Math.abs(daysUntil(w.geldig_tot)) + " يوم (كانت سارية حتى " + fmtDateDisplay(w.geldig_tot) + ")") +
    section("هويات قاربت الانتهاء (خلال 30 يوم)", "alert-warn", soon, w => "متبقٍ " + daysUntil(w.geldig_tot) + " يوم (حتى " + fmtDateDisplay(w.geldig_tot) + ")") +
    section("بدون رقم BSN", "alert-warn", missingBsn) +
    "<div class=\"btnrow\"><button type=\"button\" class=\"btn btn-ghost\" id=\"btnCloseAlerts\">إغلاق</button></div>" +
  "</div>";
  document.body.appendChild(backdrop);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.querySelector("#btnCloseAlerts").addEventListener("click", () => backdrop.remove());
}

/* ---------------- database table ---------------- */

function filteredWorkers(){
  const q = ($("dbSearch").value || "").trim().toLowerCase();
  const list = workers.slice().sort((a,b) => sortKey(a).localeCompare(sortKey(b), "nl"));
  if (!q) return list;
  return list.filter(w =>
    [w.voornaam, w.achternaam, w.nationaliteit, w.type_legitimatie, w.documentnummer, w.bsn]
      .some(v => v && String(v).toLowerCase().indexOf(q) !== -1)
  );
}

function renderWorkersTable(){
  const list = filteredWorkers();
  const tbody = $("workersTbody");
  $("workersEmpty").hidden = workers.length !== 0;

  if (!list.length){ tbody.innerHTML = ""; return; }

  tbody.innerHTML = list.map(w => {
    const status = expiryStatus(w);
    const rowCls = status === "expired" ? "expired" : (status === "soon" ? "soon" : "");
    const dot = status === "expired" ? "<span class=\"status-dot expired\" title=\"منتهية\"></span>" :
                status === "soon" ? "<span class=\"status-dot soon\" title=\"قاربت الانتهاء\"></span>" : "";
    const nat = w.nationaliteit || "—";
    const type = w.type_legitimatie || "—";
    const doc = w.documentnummer || "—";
    const bsn = w.bsn || "—";
    const name = fullName(w);
    return "<tr class=\"" + rowCls + "\">" +
      "<td class=\"ltr name-cell truncate col-name\" title=\"" + escapeHtml(name) + "\">" + escapeHtml(name) + "</td>" +
      "<td class=\"ltr truncate col-nat\" title=\"" + escapeHtml(nat) + "\">" + escapeHtml(nat) + "</td>" +
      "<td class=\"ltr truncate col-type\" title=\"" + escapeHtml(type) + "\">" + escapeHtml(type) + "</td>" +
      "<td class=\"mono truncate col-doc\" title=\"" + escapeHtml(doc) + "\">" + escapeHtml(doc) + "</td>" +
      "<td class=\"mono\">" + escapeHtml(fmtDateDisplay(w.geldig_tot)) + dot + "</td>" +
      "<td class=\"mono truncate col-bsn\" title=\"" + escapeHtml(bsn) + "\">" + escapeHtml(bsn) + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(labelJaNee(w.kopie_id)) + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(labelJaNeeNvt(w.twv_kopie)) + "</td>" +
      "<td class=\"row-actions\">" +
        "<button class=\"btn small\" data-edit=\"" + w.id + "\">تعديل</button>" +
        "<button class=\"btn small btn-danger\" data-del=\"" + w.id + "\">حذف</button>" +
      "</td>" +
    "</tr>";
  }).join("");
}

/* ---------------- worker form ---------------- */

function openWorkerForm(worker){
  editingId = worker ? worker.id : null;
  $("workerFormTitle").textContent = worker ? "تعديل بيانات عامل" : "عامل جديد";
  $("fVoornaam").value = worker ? worker.voornaam || "" : "";
  $("fAchternaam").value = worker ? worker.achternaam || "" : "";
  $("fNationaliteit").value = worker ? worker.nationaliteit || "" : "";
  $("fTypeLegitimatie").value = worker ? worker.type_legitimatie || "" : "";
  $("fDocumentnummer").value = worker ? worker.documentnummer || "" : "";
  $("fBsn").value = worker ? worker.bsn || "" : "";
  $("fGeldigVan").value = worker ? worker.geldig_van || "" : "";
  $("fGeldigTot").value = worker ? worker.geldig_tot || "" : "";
  $("fKopieId").value = worker ? (worker.kopie_id || "ja") : "ja";
  $("fTwvKopie").value = worker ? (worker.twv_kopie || "ja") : "ja";
  $("workerFormWrap").hidden = false;
  $("fVoornaam").focus();
}
function closeWorkerForm(){
  $("workerFormWrap").hidden = true;
  editingId = null;
}

async function saveWorkerForm(){
  const voornaam = $("fVoornaam").value.trim();
  const achternaam = $("fAchternaam").value.trim();
  if (!voornaam){
    toast("الاسم الأول (Voornaam) إلزامي على الأقل.");
    return;
  }
  const data = {
    voornaam,
    achternaam,
    nationaliteit: $("fNationaliteit").value.trim(),
    type_legitimatie: $("fTypeLegitimatie").value.trim(),
    documentnummer: $("fDocumentnummer").value.trim(),
    bsn: $("fBsn").value.trim(),
    geldig_van: $("fGeldigVan").value || null,
    geldig_tot: $("fGeldigTot").value || null,
    kopie_id: $("fKopieId").value,
    twv_kopie: $("fTwvKopie").value,
  };

  const arabicFields = [];
  if (hasArabic(data.voornaam)) arabicFields.push("Voornaam");
  if (hasArabic(data.achternaam)) arabicFields.push("Achternaam");
  if (hasArabic(data.nationaliteit)) arabicFields.push("Nationaliteit");
  if (hasArabic(data.type_legitimatie)) arabicFields.push("Type Legitimatie");
  if (hasArabic(data.documentnummer)) arabicFields.push("Documentnummer");
  if (hasArabic(data.bsn)) arabicFields.push("BSN-nummer");
  if (arabicFields.length){
    toast("هاي الحقول لازم تُكتب بأحرف لاتينية/هولندية لأنها تُطبع مباشرة على الجدول المصدَّر: " + arabicFields.join("، "));
    return;
  }

  try {
    if (editingId){
      await updateWorkerRecord(editingId, data);
      toast("تم تحديث بيانات العامل.");
    } else {
      await addWorker(data);
      toast("تمت إضافة العامل.");
    }
    closeWorkerForm();
  } catch(e){
    toast("حدث خطأ أثناء الحفظ: " + (e && e.message ? e.message : "غير معروف"));
  }
}

async function handleDeleteClick(id, btn){
  if (pendingDelete === id){
    pendingDelete = null;
    try {
      await deleteWorkerRecord(id);
      composeList = composeList.filter(c => c.workerId !== id);
      saveComposeLocal();
      renderCompose();
      toast("تم حذف العامل.");
    } catch(e){
      toast("تعذّر الحذف: " + (e && e.message ? e.message : ""));
    }
    return;
  }
  pendingDelete = id;
  btn.textContent = "تأكيد الحذف؟";
  setTimeout(() => {
    if (pendingDelete === id){ pendingDelete = null; renderWorkersTable(); }
  }, 3000);
}

/* ---------------- compose: search + add ---------------- */

function currentTag(){
  const r = document.querySelector('input[name="tagChoice"]:checked');
  return r ? r.value : "";
}

function searchMatches(){
  const q = ($("composeSearch").value || "").trim().toLowerCase();
  const list = workers.slice().sort((a,b) => sortKey(a).localeCompare(sortKey(b), "nl"));
  if (!q) return list;
  return list.filter(w => fullName(w).toLowerCase().indexOf(q) !== -1);
}

function renderComposeSearch(){
  const matches = searchMatches();
  const ul = $("composeResults");
  if (highlightIndex >= matches.length) highlightIndex = 0;
  ul.innerHTML = matches.map((w, i) => {
    const already = composeList.some(c => c.workerId === w.id);
    return "<li data-id=\"" + w.id + "\" class=\"" + (i === highlightIndex ? "active" : "") + "\">" +
      "<span class=\"ltr\">" + escapeHtml(fullName(w)) + "</span>" +
      (already ? "<span class=\"muted\">مُضاف</span>" : "") +
    "</li>";
  }).join("");
}

function addWorkerToCompose(workerId){
  const w = workers.find(w => w.id === workerId);
  if (!w) return;
  if (composeList.some(c => c.workerId === workerId)){
    toast("هذا العامل مضاف مسبقاً إلى اللائحة.");
    return;
  }
  composeList.push({
    rowId: "row-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    workerId: w.id,
    voornaam: w.voornaam, achternaam: w.achternaam,
    nationaliteit: w.nationaliteit, type_legitimatie: w.type_legitimatie,
    documentnummer: w.documentnummer, geldig_van: w.geldig_van, geldig_tot: w.geldig_tot,
    bsn: w.bsn, kopie_id: w.kopie_id, twv_kopie: w.twv_kopie,
    tag: currentTag(),
    starttijd: $("defStart").value || "",
    pauze: $("defPause").value || "",
    eindtijd: $("defEnd").value || "",
  });
  saveComposeLocal();
  $("composeSearch").value = "";
  highlightIndex = 0;
  renderComposeSearch();
  renderCompose();
  $("composeSearch").focus();
}

/* ---------------- compose table ---------------- */

function sortedCompose(){
  return composeList.slice().sort((a,b) => sortKey(a).localeCompare(sortKey(b), "nl"));
}

function renderCompose(){
  renderStats();
  const rows = sortedCompose();
  const tbody = $("composeTbody");
  $("composeEmpty").hidden = rows.length !== 0;
  tbody.innerHTML = rows.map((r, idx) => {
    return "<tr>" +
      "<td class=\"mono\">" + (idx+1) + "</td>" +
      "<td class=\"name-cell ltr\">" + escapeHtml(fullName(r)) + "</td>" +
      "<td><input type=\"time\" data-row=\"" + r.rowId + "\" data-field=\"starttijd\" value=\"" + escapeHtml(r.starttijd) + "\"></td>" +
      "<td><input type=\"time\" data-row=\"" + r.rowId + "\" data-field=\"pauze\" value=\"" + escapeHtml(r.pauze) + "\"></td>" +
      "<td><input type=\"time\" data-row=\"" + r.rowId + "\" data-field=\"eindtijd\" value=\"" + escapeHtml(r.eindtijd) + "\"></td>" +
      "<td>" +
        "<select data-row=\"" + r.rowId + "\" data-field=\"tag\">" +
          "<option value=\"\"" + (r.tag===""?" selected":"") + ">بدون</option>" +
          "<option value=\"Ctr\"" + (r.tag==="Ctr"?" selected":"") + ">Ctr</option>" +
          "<option value=\"Lin\"" + (r.tag==="Lin"?" selected":"") + ">Lin</option>" +
        "</select>" +
      "</td>" +
      "<td><button class=\"btn small btn-danger\" data-remove=\"" + r.rowId + "\">حذف</button></td>" +
    "</tr>";
  }).join("");
  renderComposeSearch();
}

/* ---------------- import from Excel ---------------- */

const IMPORT_TARGET_FIELDS = [
  { key: "voornaam", label: "Voornaam" },
  { key: "achternaam", label: "Achternaam" },
  { key: "full_name", label: "— أو: عمود اسم كامل واحد (ينقسم تلقائياً) —" },
  { key: "nationaliteit", label: "Nationaliteit" },
  { key: "type_legitimatie", label: "Type Legitimatie" },
  { key: "documentnummer", label: "Documentnummer" },
  { key: "bsn", label: "BSN-nummer" },
  { key: "geldig_van", label: "Geldig van" },
  { key: "geldig_tot", label: "Geldig tot" },
  { key: "geldig_range", label: "— أو: عمود واحد فيه المدة كاملة (من تاريخ - إلى تاريخ) —" },
  { key: "kopie_id", label: "Kopie ID aangeleverd (Ja/Nee)" },
  { key: "twv_kopie", label: "TWV kopie (Ja/Nee/N.v.t.)" },
];
const IMPORT_GUESS_PATTERNS = {
  voornaam: /voornaam|first.?name/i,
  achternaam: /achternaam|last.?name|surname/i,
  full_name: /^naam$|full.?name|volledige naam/i,
  nationaliteit: /national/i,
  type_legitimatie: /legitimatie|type.?id/i,
  documentnummer: /document|paspoort.?(nr|nummer)|id.?(nr|nummer)/i,
  bsn: /bsn/i,
  geldig_van: /geldig.*van|start|begin/i,
  geldig_tot: /geldig.*tot|verval|expir/i,
  geldig_range: /^geldig(heid)?$|verblijf|iqama|residency/i,
  kopie_id: /kopie.?id|id.?kopie/i,
  twv_kopie: /twv/i,
};

function openImportPanel(){
  $("importPanelWrap").hidden = false;
  $("importMappingArea").hidden = true;
  $("importFile").value = "";
  $("btnRunImport").disabled = false;
  $("btnRunImport").textContent = "استيراد الآن";
}
function closeImportPanel(){
  $("importPanelWrap").hidden = true;
  importState = { headers: [], rows: [] };
}

async function parseImportFile(){
  const file = $("importFile").files[0];
  if (!file){ toast("اختر ملف Excel أولاً."); return; }
  if (typeof ExcelJS === "undefined"){ toast("تعذّر تحميل مكتبة قراءة الإكسل، أعد تحميل الصفحة."); return; }

  const headerRowNum = parseInt($("importHeaderRow").value, 10) || 1;
  try {
    const buf = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    if (!ws){ toast("ما لقيت ولا صفحة (sheet) بالملف."); return; }

    const headerRow = ws.getRow(headerRowNum);
    const headers = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const v = cell.value;
      headers[colNumber - 1] = v == null ? "" : (v.text || v.richText ? cellTextOf(v) : String(v)).trim();
    });
    while (headers.length && !headers[headers.length - 1]) headers.pop();
    if (!headers.length){ toast("ما لقيت أعمدة بالسطر رقم " + headerRowNum + " — جرب رقم سطر تاني."); return; }

    const rows = [];
    for (let r = headerRowNum + 1; r <= ws.rowCount; r++){
      const row = ws.getRow(r);
      const vals = [];
      let hasAny = false;
      for (let c = 1; c <= headers.length; c++){
        let v = row.getCell(c).value;
        if (v && typeof v === "object" && !(v instanceof Date)) v = cellTextOf(v);
        if (v !== null && v !== undefined && String(v).trim() !== "") hasAny = true;
        vals[c - 1] = v;
      }
      if (hasAny) rows.push(vals);
    }
    if (!rows.length){ toast("ما لقيت أي بيانات تحت سطر الأعمدة."); return; }

    importState = { headers, rows };
    renderImportMapping();
    renderImportPreview();
    $("importMappingArea").hidden = false;
    toast("تم تحليل الملف — لقيت " + rows.length + " سطر. اربط الأعمدة وبعدين اضغط استيراد.");
  } catch(e){
    console.error(e);
    toast("تعذّر قراءة الملف: " + (e && e.message ? e.message : "تأكد إنه بصيغة xlsx صحيحة"));
  }
}

function cellTextOf(v){
  if (v == null) return "";
  if (v.richText) return v.richText.map(p => p.text).join("");
  if (v.text != null) return String(v.text);
  if (v.result != null) return String(v.result);
  return String(v);
}

function guessColumnIndex(key){
  const pattern = IMPORT_GUESS_PATTERNS[key];
  if (!pattern) return -1;
  return importState.headers.findIndex(h => pattern.test(h || ""));
}

function renderImportMapping(){
  const wrap = $("importMappingList");
  wrap.innerHTML = "<table><tbody>" + IMPORT_TARGET_FIELDS.map(f => {
    const guess = guessColumnIndex(f.key);
    const options = ["<option value=\"-1\">— تجاهل —</option>"].concat(
      importState.headers.map((h, i) => "<option value=\"" + i + "\"" + (i === guess ? " selected" : "") + ">" + escapeHtml(h || ("عمود " + (i+1))) + "</option>")
    ).join("");
    return "<tr><td style=\"font-weight:600; white-space:nowrap;\" class=\"ltr\">" + escapeHtml(f.label) + "</td>" +
      "<td><select data-map=\"" + f.key + "\" style=\"width:100%;\">" + options + "</select></td></tr>";
  }).join("") + "</tbody></table>";

  wrap.querySelectorAll("select[data-map]").forEach(sel => {
    sel.addEventListener("change", renderImportPreview);
  });
}

function currentImportMapping(){
  const mapping = {};
  IMPORT_TARGET_FIELDS.forEach(f => {
    const sel = document.querySelector('#importMappingList select[data-map="' + f.key + '"]');
    mapping[f.key] = sel ? parseInt(sel.value, 10) : -1;
  });
  return mapping;
}

function importGet(vals, mapping, key){
  const idx = mapping[key];
  if (idx == null || idx < 0) return "";
  const v = vals[idx];
  if (v == null) return "";
  if (v instanceof Date) return v;
  return String(v).trim();
}

function importToISODate(v){
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/.exec(s);
  if (m){
    let [, d, mo, y] = m;
    if (y.length === 2) y = (+y < 50 ? "20" : "19") + y;
    const dn = +d, mn = +mo;
    if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
    return y + "-" + mo.padStart(2, "0") + "-" + d.padStart(2, "0");
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m){
    const mn = +m[2], dn = +m[3];
    if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return null;
    return s;
  }
  return null;
}

function extractDateTokens(s){
  const re = /(?<!\d)(?:\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})(?!\d)/g;
  return String(s || "").match(re) || [];
}

function splitGeldigRange(v){
  if (v == null) return { van: null, tot: null };
  if (v instanceof Date){ const iso = v.toISOString().slice(0,10); return { van: iso, tot: iso }; }
  const tokens = extractDateTokens(v);
  if (!tokens.length) return { van: null, tot: null };
  return {
    van: importToISODate(tokens[0]),
    tot: importToISODate(tokens[tokens.length - 1]),
  };
}

function importToJaNee(v, allowNvt){
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "ja";
  if (/^(ja|yes|y|true|1|x)$/.test(s)) return "ja";
  if (/^(nee|no|n|false|0)$/.test(s)) return "nee";
  if (allowNvt && /nvt|n\.v\.t|eu/.test(s)) return "nvt";
  return "ja";
}

function buildImportRow(vals, mapping){
  let voornaam = importGet(vals, mapping, "voornaam");
  let achternaam = importGet(vals, mapping, "achternaam");
  if ((!voornaam || !achternaam) && mapping.full_name >= 0){
    const full = String(importGet(vals, mapping, "full_name") || "").trim();
    if (full){
      const parts = full.split(/\s+/);
      voornaam = voornaam || parts[0] || "";
      achternaam = achternaam || parts.slice(1).join(" ");
    }
  }
  if (!voornaam && !achternaam) return null;
  if (!voornaam && achternaam){ voornaam = achternaam; achternaam = ""; }

  const rawVan = importGet(vals, mapping, "geldig_van");
  const rawTot = importGet(vals, mapping, "geldig_tot");
  const rawRange = mapping.geldig_range >= 0 ? importGet(vals, mapping, "geldig_range") : "";
  let geldig_van = importToISODate(rawVan);
  let geldig_tot = importToISODate(rawTot);
  if ((!geldig_van || !geldig_tot) && mapping.geldig_range >= 0){
    const range = splitGeldigRange(rawRange);
    geldig_van = geldig_van || range.van;
    geldig_tot = geldig_tot || range.tot;
  }
  const dateIssue = (!!String(rawVan||"").trim() && !geldig_van) ||
                     (!!String(rawTot||"").trim() && !geldig_tot) ||
                     (!!String(rawRange||"").trim() && (!geldig_van || !geldig_tot));

  return {
    voornaam, achternaam,
    nationaliteit: importGet(vals, mapping, "nationaliteit"),
    type_legitimatie: importGet(vals, mapping, "type_legitimatie"),
    documentnummer: importGet(vals, mapping, "documentnummer"),
    bsn: importGet(vals, mapping, "bsn"),
    geldig_van, geldig_tot,
    kopie_id: importToJaNee(importGet(vals, mapping, "kopie_id"), false),
    twv_kopie: importToJaNee(importGet(vals, mapping, "twv_kopie"), true),
    _dateIssue: dateIssue,
  };
}

function renderImportPreview(){
  const mapping = currentImportMapping();
  const body = $("importPreviewBody");
  const preview = importState.rows.slice(0, 5).map(vals => buildImportRow(vals, mapping)).filter(Boolean);
  if (!preview.length){
    body.innerHTML = "<tr><td colspan=\"6\" class=\"empty-state\">حدد عمود الاسم أولاً لتظهر المعاينة.</td></tr>";
    return;
  }
  body.innerHTML = preview.map(w => {
    let flag = (hasArabic(w.voornaam) || hasArabic(w.achternaam) || hasArabic(w.nationaliteit) || hasArabic(w.type_legitimatie) || hasArabic(w.documentnummer) || hasArabic(w.bsn))
      ? " <span class=\"badge expired\">فيه عربي</span>" : "";
    if (w._dateIssue) flag += " <span class=\"badge soon\">تاريخ إقامة غير مفهوم</span>";
    return "<tr>" +
      "<td class=\"ltr name-cell\">" + escapeHtml(fullName(w)) + flag + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(w.nationaliteit || "—") + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(w.type_legitimatie || "—") + "</td>" +
      "<td class=\"mono\">" + escapeHtml(w.documentnummer || "—") + "</td>" +
      "<td class=\"mono\">" + escapeHtml(w.bsn || "—") + "</td>" +
      "<td class=\"mono\">" + escapeHtml(geldigRangeText(w.geldig_van, w.geldig_tot) || "—") + "</td>" +
    "</tr>";
  }).join("");
}

async function runImport(){
  const mapping = currentImportMapping();
  if (mapping.voornaam < 0 && mapping.achternaam < 0 && mapping.full_name < 0){
    toast("لازم تحدد عمود الاسم (Voornaam/Achternaam أو الاسم الكامل) قبل الاستيراد.");
    return;
  }

  const toInsert = [];
  const arabicNames = [];
  const dateIssueNames = [];
  let skippedEmpty = 0;

  importState.rows.forEach(vals => {
    const w = buildImportRow(vals, mapping);
    if (!w){ skippedEmpty++; return; }
    if (hasArabic(w.voornaam) || hasArabic(w.achternaam) || hasArabic(w.nationaliteit) ||
        hasArabic(w.type_legitimatie) || hasArabic(w.documentnummer) || hasArabic(w.bsn)){
      arabicNames.push(fullName(w));
    }
    if (w._dateIssue) dateIssueNames.push(fullName(w));
    const { _dateIssue, ...record } = w;
    toInsert.push(record);
  });

  if (!toInsert.length){ toast("ما في أي سطر صالح للاستيراد."); return; }

  $("btnRunImport").disabled = true;
  $("btnRunImport").textContent = "جاري الاستيراد...";
  const CHUNK = 200;
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += CHUNK){
    const chunk = toInsert.slice(i, i + CHUNK);
    const { error } = await sb.from("workers").insert(chunk);
    if (error){
      await loadWorkers();
      closeImportPanel();
      toast("توقف الاستيراد بسبب خطأ بعد " + inserted + " عامل: " + error.message);
      return;
    }
    inserted += chunk.length;
  }

  await loadWorkers();
  closeImportPanel();
  let msg = "تم استيراد " + inserted + " عامل بنجاح.";
  if (skippedEmpty) msg += " تجاهلنا " + skippedEmpty + " سطر فارغ.";
  if (arabicNames.length) msg += " تنبيه: " + arabicNames.length + " عامل فيهم نص عربي (" + arabicNames.slice(0,4).join("، ") + (arabicNames.length>4?"...":"") + ") — راجعهم من زر تعديل قبل التصدير.";
  if (dateIssueNames.length) msg += " تنبيه: ما قدرنا نقرأ تاريخ إقامة " + dateIssueNames.length + " عامل (" + dateIssueNames.slice(0,4).join("، ") + (dateIssueNames.length>4?"...":"") + ") — راجعهم وصحح التاريخ يدوياً.";
  toast(msg);
}

/* ---------------- export ---------------- */

function parseISODateParts(iso){
  const p = (iso||"").split("-");
  return { y: +p[0], m: +p[1], d: +p[2] };
}
function timeToDate(hhmm){
  const p = (hhmm||"00:00").split(":");
  return new Date(Date.UTC(1970,0,1, +p[0]||0, +p[1]||0, 0));
}
function geldigRangeText(van, tot){
  if (!van && !tot) return "";
  return fmtDateDisplay(van) + " - " + fmtDateDisplay(tot);
}

async function exportExcel(){
  if (!composeList.length){
    toast("أضف عاملاً واحداً على الأقل قبل التصدير.");
    return;
  }
  const dateVal = $("expDate").value;
  if (!dateVal){
    toast("يرجى تحديد تاريخ النزلة (Datum) أولاً.");
    return;
  }
  if (typeof ExcelJS === "undefined"){
    toast("تعذّر تحميل مكتبة توليد الإكسل، أعد تحميل الصفحة وحاول مجدداً.");
    return;
  }

  const rows = sortedCompose();
  const dp = parseISODateParts(dateVal);
  const dateDisplay = fmtDateDisplay(dateVal);

  const headers = [null,"Voornaam","Achternaam","Datum","Starttijd","Pauze","Eindtijd","Handtekening",
                   "Nationaliteit","Type Legitimatie","Documentnummer","Geldig van-tot","BSN-nummer",
                   "Kopie ID aangeleverd","TWV kopie aangeleverd indien vereist"];

  const wb = new ExcelJS.Workbook();
  wb.creator = "Nieuwvliet";
  wb.created = new Date();
  const ws = wb.addWorksheet("Blad1");

  ws.getRow(1).height = 15.75;

  // NOTE: these four header groups are NOT real merged cells. ExcelJS shares one
  // underlying style object across every cell inside an actual merge, which silently
  // clobbers the distinct left/right edge borders each group needs (verified: setting
  // different borders on two cells of the same merge, whichever is written last wins
  // for the whole range). "centerContinuous" alignment gives the identical visual
  // (text centered across the blank cells that follow it) without that shared-style bug.
  const groups = [
    { name:"NAAM", start:1, end:3 },
    { name:"WERKTIJD", start:4, end:8 },
    { name:"IDENTIFICATIE", start:9, end:13 },
    { name:"INDIEN GEEN EUR", start:14, end:15 },
  ];
  const leftEdgeCols = [1, 4, 9, 14];
  const rightEdgeCols = [3, 8, 13, 15];

  for (let c=1; c<=15; c++){
    const cell = ws.getCell(2, c);
    const group = groups.find(g => c >= g.start && c <= g.end);
    if (group){
      if (c === group.start) cell.value = group.name;
      cell.font = { name:"Aptos Narrow", size:14, bold:true };
      cell.alignment = { horizontal:"centerContinuous", vertical:"middle" };
      cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFB4E5A2" } };
    }
    cell.border = {
      top: { style:"medium" },
      left: leftEdgeCols.includes(c) ? { style:"medium" } : undefined,
      right: rightEdgeCols.includes(c) ? { style:"medium" } : undefined,
      bottom: (c===1 || c===2 || c===3) ? { style:"medium" } : undefined,
    };
  }
  ws.getRow(2).height = 31.5;

  for (let c=1; c<=15; c++){
    const cell = ws.getCell(3, c);
    if (c > 1) cell.value = headers[c-1];
    cell.font = { name:"Aptos Narrow", size:11, bold: c > 1 };
    cell.border = {
      bottom: { style:"thin" },
      left: c===1 ? { style:"medium" } : { style:"thin" },
      right: c===15 ? undefined : { style:"thin" },
    };
  }

  const lastRow = 3 + rows.length;
  const displayRows = [];
  rows.forEach((r, idx) => {
    const rn = 4 + idx;
    const isLastRow = rn === lastRow;
    const tagged = applyTagToName(r.voornaam, r.achternaam, r.tag);
    const values = {
      1: idx+1,
      2: tagged.voornaam,
      3: tagged.achternaam,
      4: new Date(Date.UTC(dp.y, dp.m-1, dp.d)),
      5: r.starttijd ? timeToDate(r.starttijd) : null,
      6: r.pauze ? timeToDate(r.pauze) : null,
      7: r.eindtijd ? timeToDate(r.eindtijd) : null,
      8: null,
      9: r.nationaliteit || "",
      10: r.type_legitimatie || "",
      11: r.documentnummer || "",
      12: geldigRangeText(r.geldig_van, r.geldig_tot),
      13: r.bsn || "",
      14: labelJaNee(r.kopie_id),
      15: labelJaNeeNvt(r.twv_kopie),
    };
    const display = [idx+1, tagged.voornaam, tagged.achternaam, dateDisplay, r.starttijd, r.pauze, r.eindtijd,
                     "", r.nationaliteit||"", r.type_legitimatie||"", r.documentnummer||"",
                     geldigRangeText(r.geldig_van,r.geldig_tot), r.bsn||"", labelJaNee(r.kopie_id), labelJaNeeNvt(r.twv_kopie)];
    displayRows.push(display);

    ws.getRow(rn).height = 20.1;
    for (let c=1;c<=15;c++){
      const cc = ws.getCell(rn, c);
      cc.value = values[c] === undefined ? null : values[c];
      cc.font = { name:"Aptos Narrow", size:11, bold: c===1 };
      cc.border = {
        top: { style:"thin" },
        bottom: isLastRow ? (c===1 ? { style:"medium" } : undefined) : { style:"thin" },
        left: c===1 ? { style:"medium" } : { style:"thin" },
        right: c===15 ? undefined : { style:"thin" },
      };
      if (c>=5 && c<=7) cc.alignment = { horizontal:"center" };
      else if (c!==1) cc.alignment = { horizontal:"left" };
      if (c===4) cc.numFmt = "dd-mm-yyyy";
      if (c>=5 && c<=7 && cc.value) cc.numFmt = "h:mm;@";
    }
  });

  const baseWidths = {1:8.43,2:12.14,3:13.86,4:11.71,5:12,6:15.14,7:17.71,8:15.71,9:14.43,10:18,11:20.14,12:15.86,13:15.14,14:22.14,15:36.86};
  for (let col=1; col<=15; col++){
    let maxLen = String(headers[col-1] || "").length;
    displayRows.forEach(dr => {
      const s = dr[col-1] == null ? "" : String(dr[col-1]);
      if (s.length > maxLen) maxLen = s.length;
    });
    let w = Math.max(baseWidths[col], maxLen * 1.15 + 2);
    w = Math.min(w, 45);
    ws.getColumn(col).width = w;
  }

  try {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const fname = "Inschrijflijst_" + dateDisplay + ".xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("تم تنزيل الملف.");
  } catch(e){
    console.error(e);
    toast("تعذّر توليد ملف الإكسل: " + (e && e.message ? e.message : "خطأ غير معروف"));
  }
}

/* ---------------- collapsible workers panel ---------------- */

function setWorkersCollapsed(collapsed){
  $("workersPanelBody").hidden = collapsed;
  $("btnToggleWorkers").textContent = collapsed ? "▸" : "▾";
  $("btnToggleWorkers").setAttribute("aria-expanded", collapsed ? "false" : "true");
  try { localStorage.setItem(LS_WORKERS_COLLAPSED, collapsed ? "1" : "0"); } catch(e){}
}

/* ---------------- wiring ---------------- */

function wireEvents(){
  $("dbSearch").addEventListener("input", renderWorkersTable);

  $("btnToggleWorkers").addEventListener("click", () => {
    setWorkersCollapsed(!$("workersPanelBody").hidden);
  });
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem(LS_WORKERS_COLLAPSED) === "1"; } catch(e){}
  setWorkersCollapsed(startCollapsed);

  $("btnOpenAdd").addEventListener("click", () => openWorkerForm(null));
  $("btnCancelWorker").addEventListener("click", closeWorkerForm);
  $("btnSaveWorker").addEventListener("click", saveWorkerForm);

  $("btnAlerts").addEventListener("click", openAlertsModal);

  $("btnOpenImport").addEventListener("click", openImportPanel);
  $("btnParseImport").addEventListener("click", parseImportFile);
  $("btnRunImport").addEventListener("click", runImport);
  $("btnCancelImport").addEventListener("click", closeImportPanel);

  $("workersTbody").addEventListener("click", (e) => {
    const editId = e.target.getAttribute("data-edit");
    const delId = e.target.getAttribute("data-del");
    if (editId){
      const w = workers.find(w => w.id === editId);
      if (w) openWorkerForm(w);
    } else if (delId){
      handleDeleteClick(delId, e.target);
    }
  });

  $("composeSearch").addEventListener("input", () => { highlightIndex = 0; renderComposeSearch(); });
  $("composeSearch").addEventListener("keydown", (e) => {
    const matches = searchMatches();
    if (e.key === "ArrowDown"){
      e.preventDefault();
      highlightIndex = Math.min(highlightIndex+1, matches.length-1);
      renderComposeSearch();
    } else if (e.key === "ArrowUp"){
      e.preventDefault();
      highlightIndex = Math.max(highlightIndex-1, 0);
      renderComposeSearch();
    } else if (e.key === "Enter"){
      e.preventDefault();
      if (matches[highlightIndex]) addWorkerToCompose(matches[highlightIndex].id);
    }
  });
  $("composeResults").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) addWorkerToCompose(li.getAttribute("data-id"));
  });

  $("composeTbody").addEventListener("input", (e) => {
    const rowId = e.target.getAttribute("data-row");
    const field = e.target.getAttribute("data-field");
    if (!rowId || !field) return;
    const row = composeList.find(c => c.rowId === rowId);
    if (!row) return;
    row[field] = e.target.value;
    saveComposeLocal();
    if (field === "tag") renderCompose();
  });
  $("composeTbody").addEventListener("click", (e) => {
    const rem = e.target.getAttribute("data-remove");
    if (rem){
      composeList = composeList.filter(c => c.rowId !== rem);
      saveComposeLocal();
      renderCompose();
    }
  });

  $("btnClearCompose").addEventListener("click", () => {
    composeList = [];
    saveComposeLocal();
    renderCompose();
  });

  $("btnExport").addEventListener("click", exportExcel);
}
