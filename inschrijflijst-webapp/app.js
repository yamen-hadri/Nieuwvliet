'use strict';

/* ============================================================
   Inschrijflijst Nieuwvliet — منطق التطبيق
   الداتا كلها بـ Supabase (جدول workers)
   أي تعديل من جهاز بيوصل فوراً للجهاز التاني عن طريق Supabase Realtime
   ============================================================ */

const sb = window.supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);

const LS_COMPOSE = "nieuwvliet_compose_v1";

let workers = [];
let composeList = [];
let editingId = null;
let highlightIndex = 0;
let pendingDelete = null;

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
  return p[2] + "-" + p[1] + "-" + p[0];
}
function labelJaNee(v){ return v === "ja" ? "Ja" : "Nee"; }
function labelJaNeeNvt(v){ return v === "ja" ? "Ja" : (v === "nee" ? "Nee" : "N.v.t."); }
function fullName(w){ return (w.voornaam || "") + " " + (w.achternaam || ""); }
function sortKey(w){ return ((w.achternaam || "") + " " + (w.voornaam || "")).toLocaleLowerCase("nl"); }

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

/* ---------------- rendering: stats + banner ---------------- */

function onWorkersChanged(){
  renderStats();
  renderExpiryBanner();
  renderWorkersTable();
  renderComposeSearch();
}

function renderStats(){
  $("statTotal").textContent = workers.length;
  $("statCompose").textContent = composeList.length;
  const soon = workers.filter(w => expiryStatus(w) === "soon").length;
  const expired = workers.filter(w => expiryStatus(w) === "expired").length;
  $("statSoon").hidden = soon === 0;
  $("statSoonNum").textContent = soon;
  $("statExpired").hidden = expired === 0;
  $("statExpiredNum").textContent = expired;
}

function renderExpiryBanner(){
  const flagged = workers.filter(w => {
    const s = expiryStatus(w);
    return s === "expired" || s === "soon";
  }).sort((a,b) => daysUntil(a.geldig_tot) - daysUntil(b.geldig_tot));

  const banner = $("expiryBanner");
  if (!flagged.length){ banner.hidden = true; return; }
  banner.hidden = false;
  $("expiryBannerList").innerHTML = flagged.map(w => {
    const s = expiryStatus(w);
    const d = daysUntil(w.geldig_tot);
    const tagCls = s === "expired" ? "expired" : "soon";
    const tagTxt = s === "expired" ? ("منتهية منذ " + Math.abs(d) + " يوم") : ("متبقٍ " + d + " يوم");
    return "<li>" + escapeHtml(fullName(w)) + " — صالحة حتى " + escapeHtml(fmtDateDisplay(w.geldig_tot)) +
           "<span class=\"tag " + tagCls + "\">" + tagTxt + "</span></li>";
  }).join("");
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
    const badge = status === "none" ? "<span class=\"badge none\">—</span>" :
                  status === "ok" ? "<span class=\"badge ok\">سارية</span>" :
                  status === "soon" ? "<span class=\"badge soon\">قاربت الانتهاء</span>" :
                  "<span class=\"badge expired\">منتهية</span>";
    return "<tr class=\"" + rowCls + "\">" +
      "<td class=\"ltr name-cell\">" + escapeHtml((w.voornaam||"") + " " + (w.achternaam||"")) + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(w.nationaliteit || "—") + "</td>" +
      "<td class=\"ltr\">" + escapeHtml(w.type_legitimatie || "—") + "</td>" +
      "<td class=\"mono\">" + escapeHtml(w.documentnummer || "—") + "</td>" +
      "<td class=\"mono\">" + escapeHtml(fmtDateDisplay(w.geldig_tot)) + " " + badge + "</td>" +
      "<td class=\"mono\">" + escapeHtml(w.bsn || "—") + "</td>" +
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
  if (!voornaam || !achternaam){
    toast("الاسم الأول والكنية إلزاميان.");
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
  return composeList.slice().sort((a,b) => {
    const ak = ((a.achternaam||"") + " " + (a.voornaam||"")).toLocaleLowerCase("nl");
    const bk = ((b.achternaam||"") + " " + (b.voornaam||"")).toLocaleLowerCase("nl");
    return ak.localeCompare(bk, "nl");
  });
}

function renderCompose(){
  renderStats();
  const rows = sortedCompose();
  const tbody = $("composeTbody");
  $("composeEmpty").hidden = rows.length !== 0;
  tbody.innerHTML = rows.map((r, idx) => {
    return "<tr>" +
      "<td class=\"mono\">" + (idx+1) + "</td>" +
      "<td class=\"name-cell ltr\">" + escapeHtml(r.voornaam + " " + r.achternaam) + "</td>" +
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

/* ---------------- export ---------------- */

function parseISODateParts(iso){
  const p = (iso||"").split("-");
  return { y: +p[0], m: +p[1], d: +p[2] };
}
function timeToDate(hhmm){
  const p = (hhmm||"00:00").split(":");
  return new Date(1970,0,1, +p[0]||0, +p[1]||0, 0);
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

  ws.mergeCells("A2:C2"); ws.mergeCells("D2:H2"); ws.mergeCells("I2:M2"); ws.mergeCells("N2:O2");
  [["A2","NAAM"],["D2","WERKTIJD"],["I2","IDENTIFICATIE"],["N2","INDIEN GEEN EUR"]].forEach(pair => {
    const c = ws.getCell(pair[0]);
    c.value = pair[1];
    c.font = { name:"Aptos Narrow", size:14, bold:true };
    c.alignment = { horizontal:"center", vertical:"middle" };
  });
  ws.getCell("A2").border = { bottom:{ style:"medium" } };
  ws.getRow(2).height = 31.5;

  for (let i=1;i<=14;i++){
    const cell = ws.getCell(3, i+1);
    cell.value = headers[i];
    cell.font = { name:"Aptos Narrow", size:11, bold:true };
    cell.border = { bottom:{ style:"thin" } };
  }
  ws.getRow(3).height = 18;

  const displayRows = [];
  rows.forEach((r, idx) => {
    const rn = 4 + idx;
    const tagSuffix = r.tag ? (" (" + r.tag + ")") : "";
    const values = {
      1: idx+1,
      2: r.voornaam || "",
      3: (r.achternaam || "") + tagSuffix,
      4: new Date(dp.y, dp.m-1, dp.d),
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
    const display = [idx+1, r.voornaam||"", (r.achternaam||"")+tagSuffix, dateDisplay, r.starttijd, r.pauze, r.eindtijd,
                     "", r.nationaliteit||"", r.type_legitimatie||"", r.documentnummer||"",
                     geldigRangeText(r.geldig_van,r.geldig_tot), r.bsn||"", labelJaNee(r.kopie_id), labelJaNeeNvt(r.twv_kopie)];
    displayRows.push(display);

    ws.getRow(rn).height = 20.1;
    for (let c=1;c<=15;c++){
      const cc = ws.getCell(rn, c);
      cc.value = values[c] === undefined ? null : values[c];
      cc.font = { name:"Aptos Narrow", size:11, bold: c===1 };
      cc.border = { bottom:{ style:"thin" } };
      if (c===1) cc.alignment = { horizontal:"center" };
      else if (c>=5 && c<=7) cc.alignment = { horizontal:"center" };
      else cc.alignment = { horizontal:"left" };
      if (c===4) cc.numFmt = "dd-mm-yyyy";
      if (c>=5 && c<=7 && cc.value) cc.numFmt = "hh:mm";
    }
  });

  const baseWidths = {1:6,2:12.14,3:13.86,4:11.71,5:12,6:15.14,7:17.71,8:15.71,9:14.43,10:18,11:20.14,12:15.86,13:15.14,14:22.14,15:36.86};
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

/* ---------------- wiring ---------------- */

function wireEvents(){
  $("dbSearch").addEventListener("input", renderWorkersTable);

  $("btnOpenAdd").addEventListener("click", () => openWorkerForm(null));
  $("btnCancelWorker").addEventListener("click", closeWorkerForm);
  $("btnSaveWorker").addEventListener("click", saveWorkerForm);

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
