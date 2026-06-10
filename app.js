// ============================================================
// TIMESHEETS — Penthouse Promotions
// Vanilla JS + Supabase
// Update 1: pay periods (1–14 / 15–end), submit & lock
// ============================================================

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ───────────────────────────────────────────────────
let currentUser = null;
let currentProfile = null;
let sheetMonth = startOfMonth(new Date());
let payMonth = startOfMonth(new Date());
let saveTimers = {};
let membersCache = [];
let memberSheetTarget = null; // profile being edited by admin in payroll

// ── Helpers ─────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function monthLabel(d) {
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function daysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function isoDate(year, monthIdx, day) {
  const m = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${m}-${dd}`;
}

function monthRange(d) {
  const first = isoDate(d.getFullYear(), d.getMonth(), 1);
  const last = isoDate(d.getFullYear(), d.getMonth(), daysInMonth(d));
  return { first, last };
}

// 'YYYY-MM-H1' or 'YYYY-MM-H2'
function periodKey(monthDate, half) {
  const m = String(monthDate.getMonth() + 1).padStart(2, "0");
  return `${monthDate.getFullYear()}-${m}-H${half}`;
}

function halfLabel(monthDate, half) {
  const name = monthDate.toLocaleDateString("en-US", { month: "long" });
  return half === 1
    ? `${name} 1st – 14th`
    : `${name} 15th – ${daysInMonth(monthDate)}th`;
}

function fmt(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add("hidden"), 3500);
}

function setSaveStatus(state, text) {
  const el = $("save-status");
  el.className = "save-status " + (state || "");
  el.textContent = text || "";
}

// ── Row math ────────────────────────────────────────────────
function calcRow(row, profile) {
  const ofNet = num(row.of_gross) * NET_RATES.of;
  const fvNet = num(row.fv_gross) * NET_RATES.fv;
  const slushyNet = num(row.slushy_gross) * NET_RATES.slushy;
  const fanslyNet = num(row.fansly_gross) * NET_RATES.fansly;
  const total = ofNet + fvNet + slushyNet + fanslyNet;
  const commission = total * num(profile.commission_rate);
  const hoursPay = num(row.hours) * num(profile.hourly_rate);
  return { ofNet, fvNet, slushyNet, fanslyNet, total, commission, hoursPay };
}

// ════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════
function showAuthError(msg) {
  const el = $("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function clearAuthError() {
  $("auth-error").classList.add("hidden");
}

$("tab-login").addEventListener("click", () => {
  $("tab-login").classList.add("active");
  $("tab-signup").classList.remove("active");
  $("login-form").classList.remove("hidden");
  $("signup-form").classList.add("hidden");
  clearAuthError();
});

$("tab-signup").addEventListener("click", () => {
  $("tab-signup").classList.add("active");
  $("tab-login").classList.remove("active");
  $("signup-form").classList.remove("hidden");
  $("login-form").classList.add("hidden");
  clearAuthError();
});

$("btn-login").addEventListener("click", async () => {
  clearAuthError();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  if (!email || !password) { showAuthError("Enter your email and password."); return; }

  $("btn-login").disabled = true;
  const { error } = await db.auth.signInWithPassword({ email, password });
  $("btn-login").disabled = false;

  if (error) { showAuthError(error.message); return; }
  init();
});

$("btn-signup").addEventListener("click", async () => {
  clearAuthError();
  const name = $("signup-name").value.trim();
  const email = $("signup-email").value.trim();
  const password = $("signup-password").value;
  if (!name || !email || !password) { showAuthError("Fill in all fields."); return; }
  if (password.length < 6) { showAuthError("Password must be at least 6 characters."); return; }

  $("btn-signup").disabled = true;
  const { error } = await db.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
  $("btn-signup").disabled = false;

  if (error) {
    if (error.message.toLowerCase().includes("invite")) {
      showAuthError("No invite found for this email. Ask an admin to invite you first.");
    } else {
      showAuthError(error.message);
    }
    return;
  }
  init();
});

$("btn-logout").addEventListener("click", async () => {
  await db.auth.signOut();
  location.reload();
});

$("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});
$("signup-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-signup").click();
});

// ════════════════════════════════════════════════════════════
// INIT / ROUTING
// ════════════════════════════════════════════════════════════
async function init() {
  const { data: { session } } = await db.auth.getSession();

  if (!session) {
    $("auth-view").classList.remove("hidden");
    $("app-view").classList.add("hidden");
    return;
  }

  currentUser = session.user;

  const { data: profile, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", currentUser.id)
    .single();

  if (error || !profile) {
    showAuthError("Could not load your profile. Contact an admin.");
    await db.auth.signOut();
    return;
  }

  currentProfile = profile;
  $("user-name").textContent = profile.name || profile.email;

  if (profile.role === "admin") {
    document.querySelectorAll(".admin-only").forEach((el) => el.classList.remove("hidden"));
  }

  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");

  renderMySheet();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    ["my-timesheet", "team", "payroll"].forEach((v) => {
      $("view-" + v).classList.toggle("hidden", v !== view);
    });
    if (view === "my-timesheet") renderMySheet();
    if (view === "team") renderTeam();
    if (view === "payroll") renderPayroll();
  });
});

// ════════════════════════════════════════════════════════════
// DATA LOADERS
// ════════════════════════════════════════════════════════════
async function loadMonthRows(userId, monthDate) {
  const { first, last } = monthRange(monthDate);
  const { data, error } = await db
    .from("timesheets")
    .select("*")
    .eq("user_id", userId)
    .gte("entry_date", first)
    .lte("entry_date", last);
  if (error) { toast("Failed to load timesheets: " + error.message, true); return {}; }
  const map = {};
  (data || []).forEach((r) => { map[r.entry_date] = r; });
  return map;
}

// returns { 'YYYY-MM-H1': submitted_at, 'YYYY-MM-H2': submitted_at }
async function loadSubmissions(userId, monthDate) {
  const keys = [periodKey(monthDate, 1), periodKey(monthDate, 2)];
  const { data, error } = await db
    .from("submissions")
    .select("*")
    .eq("user_id", userId)
    .in("period", keys);
  if (error) { toast("Failed to load submissions: " + error.message, true); return {}; }
  const map = {};
  (data || []).forEach((s) => { map[s.period] = s.submitted_at; });
  return map;
}

// ════════════════════════════════════════════════════════════
// SHARED SHEET RENDERER
// Renders two half-month sections into a container.
// mode: "self" (member's own sheet) | "admin" (admin editing a member)
// ════════════════════════════════════════════════════════════
const SHEET_HEAD = `
  <tr>
    <th class="col-date">Date</th>
    <th class="col-num th-hours">Hours</th>
    <th class="col-num th-of">OF Gross $</th>
    <th class="col-num th-of net">OF Net $</th>
    <th class="col-num th-fv">FV Gross $</th>
    <th class="col-num th-fv net">FV Net $</th>
    <th class="col-num th-slushy">Slushy Gross $</th>
    <th class="col-num th-slushy net">Slushy Net $</th>
    <th class="col-num th-fansly">Fansly Gross $</th>
    <th class="col-num th-fansly net">Fansly Net $</th>
    <th class="col-num th-total">Total Sales</th>
    <th class="col-num th-comm">Commission $</th>
    <th class="col-num th-pay">Hours $</th>
  </tr>
`;

async function renderUserSheet(container, profile, monthDate, mode) {
  container.dataset.userId = profile.id;
  container.dataset.mode = mode;
  container.innerHTML = "";

  const [rows, subs] = await Promise.all([
    loadMonthRows(profile.id, monthDate),
    loadSubmissions(profile.id, monthDate),
  ]);

  const year = monthDate.getFullYear();
  const monthIdx = monthDate.getMonth();
  const lastDay = daysInMonth(monthDate);

  [1, 2].forEach((half) => {
    const pKey = periodKey(monthDate, half);
    const submittedAt = subs[pKey] || null;
    const isAdmin = currentProfile.role === "admin";
    // members can't edit a submitted period; admins always can
    const editable = isAdmin || !submittedAt;

    const firstDay = half === 1 ? 1 : 15;
    const endDay = half === 1 ? 14 : lastDay;

    const section = document.createElement("section");
    section.className = "panel sheet-section" + (submittedAt && !isAdmin ? " locked" : "");
    section.dataset.period = pKey;
    section.dataset.half = String(half);

    // header
    const head = document.createElement("div");
    head.className = "section-head";
    const statusHtml = submittedAt
      ? `<span class="status-pill submitted">Submitted ${new Date(submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>`
      : `<span class="status-pill open">Not submitted</span>`;
    head.innerHTML = `<h3>${halfLabel(monthDate, half)}</h3>${statusHtml}`;
    section.appendChild(head);

    // table
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "sheet";
    table.innerHTML = `<thead>${SHEET_HEAD}</thead>`;
    const tbody = document.createElement("tbody");
    tbody.className = "half-body";

    for (let day = firstDay; day <= endDay; day++) {
      const date = isoDate(year, monthIdx, day);
      const row = rows[date] || { hours: "", of_gross: "", fv_gross: "", slushy_gross: "", fansly_gross: "" };
      const dateObj = new Date(year, monthIdx, day);
      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
      const dis = editable ? "" : "disabled";

      const tr = document.createElement("tr");
      tr.dataset.date = date;
      if (isWeekend) tr.classList.add("weekend");

      const label = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });

      tr.innerHTML = `
        <td class="col-date">${label}</td>
        <td class="col-num"><input class="cell hours" data-field="hours" type="number" min="0" step="0.5" value="${row.hours || ""}" placeholder="–" ${dis}></td>
        <td class="col-num"><input class="cell" data-field="of_gross" type="number" min="0" step="0.01" value="${row.of_gross || ""}" placeholder="–" ${dis}></td>
        <td class="col-num net-of" data-cell="of-net"></td>
        <td class="col-num"><input class="cell" data-field="fv_gross" type="number" min="0" step="0.01" value="${row.fv_gross || ""}" placeholder="–" ${dis}></td>
        <td class="col-num net-fv" data-cell="fv-net"></td>
        <td class="col-num"><input class="cell" data-field="slushy_gross" type="number" min="0" step="0.01" value="${row.slushy_gross || ""}" placeholder="–" ${dis}></td>
        <td class="col-num net-slushy" data-cell="slushy-net"></td>
        <td class="col-num"><input class="cell" data-field="fansly_gross" type="number" min="0" step="0.01" value="${row.fansly_gross || ""}" placeholder="–" ${dis}></td>
        <td class="col-num net-fansly" data-cell="fansly-net"></td>
        <td class="col-num cell-total" data-cell="total"></td>
        <td class="col-num cell-comm" data-cell="comm"></td>
        <td class="col-num cell-pay" data-cell="pay"></td>
      `;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    const tfoot = document.createElement("tfoot");
    tfoot.className = "half-foot";
    table.appendChild(tfoot);
    scroll.appendChild(table);
    section.appendChild(scroll);

    // recalc all rows + totals
    tbody.querySelectorAll("tr").forEach((tr) => recalcDisplayRow(tr, profile));
    recalcHalfTotals(section, profile);

    // submit / lock controls
    const bar = document.createElement("div");
    bar.className = "submit-bar";

    if (mode === "self") {
      if (submittedAt) {
        bar.innerHTML = `<span class="hint">This period is locked. Contact an admin if something needs changing.</span>`;
      } else {
        const btn = document.createElement("button");
        btn.className = "btn btn-primary";
        btn.type = "button";
        btn.textContent = `Submit ${halfLabel(monthDate, half)}`;
        btn.addEventListener("click", () => submitPeriod(profile.id, pKey, btn));
        bar.appendChild(btn);
        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = "Submitting locks these figures — only an admin can change them after.";
        bar.appendChild(note);
      }
    } else {
      // admin controls on member sheets
      if (submittedAt) {
        const btn = document.createElement("button");
        btn.className = "btn btn-danger";
        btn.type = "button";
        btn.textContent = "Unlock period";
        btn.addEventListener("click", () => unlockPeriod(profile.id, pKey));
        bar.appendChild(btn);
        const note = document.createElement("span");
        note.className = "hint";
        note.textContent = "Unlocking lets the member edit this period again.";
        bar.appendChild(note);
      } else {
        const btn = document.createElement("button");
        btn.className = "btn btn-ghost";
        btn.type = "button";
        btn.textContent = "Mark as submitted";
        btn.addEventListener("click", () => submitPeriod(profile.id, pKey, btn, true));
        bar.appendChild(btn);
      }
    }
    section.appendChild(bar);

    container.appendChild(section);
  });
}

function recalcDisplayRow(tr, profile) {
  const get = (field) => {
    const input = tr.querySelector(`input[data-field="${field}"]`);
    return input ? input.value : 0;
  };
  const calc = calcRow(
    {
      hours: get("hours"),
      of_gross: get("of_gross"),
      fv_gross: get("fv_gross"),
      slushy_gross: get("slushy_gross"),
      fansly_gross: get("fansly_gross"),
    },
    profile
  );
  tr.querySelector('[data-cell="of-net"]').textContent = fmt(calc.ofNet);
  tr.querySelector('[data-cell="fv-net"]').textContent = fmt(calc.fvNet);
  tr.querySelector('[data-cell="slushy-net"]').textContent = fmt(calc.slushyNet);
  tr.querySelector('[data-cell="fansly-net"]').textContent = fmt(calc.fanslyNet);
  tr.querySelector('[data-cell="total"]').textContent = fmt(calc.total);
  tr.querySelector('[data-cell="comm"]').textContent = fmt(calc.commission);
  tr.querySelector('[data-cell="pay"]').textContent = fmt(calc.hoursPay);
}

function recalcHalfTotals(section, profile) {
  const tbody = section.querySelector(".half-body");
  const tfoot = section.querySelector(".half-foot");
  const sums = { hours: 0, of: 0, fv: 0, slushy: 0, fansly: 0, ofNet: 0, fvNet: 0, slushyNet: 0, fanslyNet: 0, total: 0, comm: 0, pay: 0 };

  tbody.querySelectorAll("tr").forEach((tr) => {
    const get = (field) => num(tr.querySelector(`input[data-field="${field}"]`).value);
    const row = {
      hours: get("hours"),
      of_gross: get("of_gross"),
      fv_gross: get("fv_gross"),
      slushy_gross: get("slushy_gross"),
      fansly_gross: get("fansly_gross"),
    };
    const calc = calcRow(row, profile);
    sums.hours += row.hours;
    sums.of += row.of_gross;
    sums.fv += row.fv_gross;
    sums.slushy += row.slushy_gross;
    sums.fansly += row.fansly_gross;
    sums.ofNet += calc.ofNet;
    sums.fvNet += calc.fvNet;
    sums.slushyNet += calc.slushyNet;
    sums.fanslyNet += calc.fanslyNet;
    sums.total += calc.total;
    sums.comm += calc.commission;
    sums.pay += calc.hoursPay;
  });

  tfoot.innerHTML = `
    <tr>
      <td>TOTAL</td>
      <td class="col-num">${sums.hours}</td>
      <td class="col-num">${fmt(sums.of)}</td>
      <td class="col-num net-of">${fmt(sums.ofNet)}</td>
      <td class="col-num">${fmt(sums.fv)}</td>
      <td class="col-num net-fv">${fmt(sums.fvNet)}</td>
      <td class="col-num">${fmt(sums.slushy)}</td>
      <td class="col-num net-slushy">${fmt(sums.slushyNet)}</td>
      <td class="col-num">${fmt(sums.fansly)}</td>
      <td class="col-num net-fansly">${fmt(sums.fanslyNet)}</td>
      <td class="col-num cell-total">${fmt(sums.total)}</td>
      <td class="col-num cell-comm">${fmt(sums.comm)}</td>
      <td class="col-num cell-pay">${fmt(sums.pay)}</td>
    </tr>
  `;
}

// shared delegated input handler for both sheet containers
function handleSheetInput(e) {
  const input = e.target;
  if (!input.classList.contains("cell") || input.disabled) return;

  const container = e.currentTarget;
  const tr = input.closest("tr");
  const section = input.closest(".sheet-section");
  const targetUserId = container.dataset.userId;
  const profile = targetUserId === currentUser.id
    ? currentProfile
    : (membersCache.find((m) => m.id === targetUserId) || currentProfile);

  recalcDisplayRow(tr, profile);
  recalcHalfTotals(section, profile);

  const date = tr.dataset.date;
  const timerKey = targetUserId + ":" + date;
  setSaveStatus("saving", "Saving…");

  clearTimeout(saveTimers[timerKey]);
  saveTimers[timerKey] = setTimeout(() => saveSheetRow(tr, targetUserId, date), 700);
}

async function saveSheetRow(tr, targetUserId, date) {
  const get = (field) => num(tr.querySelector(`input[data-field="${field}"]`).value);

  const payload = {
    user_id: targetUserId,
    entry_date: date,
    hours: get("hours"),
    of_gross: get("of_gross"),
    fv_gross: get("fv_gross"),
    slushy_gross: get("slushy_gross"),
    fansly_gross: get("fansly_gross"),
    updated_at: new Date().toISOString(),
  };

  const { error } = await db
    .from("timesheets")
    .upsert(payload, { onConflict: "user_id,entry_date" });

  if (error) {
    setSaveStatus("error", "Save failed — " + error.message);
    toast("Save failed: " + error.message, true);
    return;
  }
  setSaveStatus("saved", "All changes saved");
}

// submit / unlock
async function submitPeriod(userId, pKey, btn, byAdmin = false) {
  const confirmMsg = byAdmin
    ? "Mark this period as submitted? The member won't be able to edit it."
    : "Submit this timesheet period? You won't be able to edit it after — only an admin can.";
  if (!confirm(confirmMsg)) return;

  if (btn) btn.disabled = true;
  const { error } = await db.from("submissions").insert({ user_id: userId, period: pKey });
  if (btn) btn.disabled = false;

  if (error) {
    if (error.code === "23505") {
      toast("This period was already submitted.");
    } else {
      toast("Submit failed: " + error.message, true);
      return;
    }
  } else {
    toast("Period submitted and locked ✓");
  }

  // re-render whichever sheet is on screen
  if (memberSheetTarget && userId === memberSheetTarget.id) {
    renderUserSheet($("member-sheet-sections"), memberSheetTarget, payMonth, "admin");
  }
  if (userId === currentUser.id) renderMySheet();
}

async function unlockPeriod(userId, pKey) {
  if (!confirm("Unlock this period so the member can edit it again?")) return;

  const { error } = await db
    .from("submissions")
    .delete()
    .eq("user_id", userId)
    .eq("period", pKey);

  if (error) { toast("Unlock failed: " + error.message, true); return; }
  toast("Period unlocked");

  if (memberSheetTarget && userId === memberSheetTarget.id) {
    renderUserSheet($("member-sheet-sections"), memberSheetTarget, payMonth, "admin");
  }
  if (userId === currentUser.id) renderMySheet();
}

// ════════════════════════════════════════════════════════════
// MY TIMESHEET
// ════════════════════════════════════════════════════════════
$("month-prev").addEventListener("click", () => {
  sheetMonth = new Date(sheetMonth.getFullYear(), sheetMonth.getMonth() - 1, 1);
  renderMySheet();
});
$("month-next").addEventListener("click", () => {
  sheetMonth = new Date(sheetMonth.getFullYear(), sheetMonth.getMonth() + 1, 1);
  renderMySheet();
});

async function renderMySheet() {
  $("month-label").textContent = monthLabel(sheetMonth);
  setSaveStatus("", "");
  await renderUserSheet($("my-sheet-sections"), currentProfile, sheetMonth, "self");
}

$("my-sheet-sections").addEventListener("input", handleSheetInput);
$("member-sheet-sections").addEventListener("input", handleSheetInput);

// ════════════════════════════════════════════════════════════
// TEAM (admin)
// ════════════════════════════════════════════════════════════
async function renderTeam() {
  const { data: invites, error: invErr } = await db
    .from("invites")
    .select("*")
    .order("created_at", { ascending: false });

  const list = $("invites-list");
  list.innerHTML = "";
  if (invErr) {
    list.innerHTML = `<p class="hint">Could not load invites: ${invErr.message}</p>`;
  } else if (invites && invites.length) {
    invites.forEach((inv) => {
      const item = document.createElement("div");
      item.className = "invite-item";
      item.innerHTML = `
        <span>${inv.email}</span>
        <span class="pill">${inv.role}</span>
        <span class="pill" style="background:${inv.used ? "rgba(88,201,136,0.12)" : "rgba(138,146,166,0.12)"};color:${inv.used ? "var(--c-fv)" : "var(--text-dim)"}">${inv.used ? "Used" : "Pending"}</span>
        <span class="spacer"></span>
        ${inv.used ? "" : `<button class="btn btn-danger btn-small" data-del-invite="${inv.id}" type="button">Revoke</button>`}
      `;
      list.appendChild(item);
    });
  }

  const { data: members, error: memErr } = await db
    .from("profiles")
    .select("*")
    .order("name", { ascending: true });

  const body = $("members-body");
  body.innerHTML = "";
  if (memErr) {
    body.innerHTML = `<tr><td colspan="6">Could not load members: ${memErr.message}</td></tr>`;
    return;
  }
  membersCache = members || [];

  membersCache.forEach((m) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.name || "—"}</td>
      <td>${m.email}</td>
      <td><span class="role-pill ${m.role}">${m.role}</span></td>
      <td class="col-num"><input class="cell rate" data-member="${m.id}" data-rate-field="hourly_rate" type="number" min="0" step="0.25" value="${m.hourly_rate}"></td>
      <td class="col-num"><input class="cell rate" data-member="${m.id}" data-rate-field="commission_rate" type="number" min="0" step="0.001" value="${m.commission_rate}"></td>
      <td><span class="hint">commission as decimal — 0.03 = 3%</span></td>
    `;
    body.appendChild(tr);
  });
}

$("btn-invite").addEventListener("click", async () => {
  const email = $("invite-email").value.trim().toLowerCase();
  const role = $("invite-role").value;
  if (!email) { toast("Enter an email to invite.", true); return; }

  const { error } = await db.from("invites").insert({ email, role });
  if (error) {
    toast("Invite failed: " + error.message, true);
    return;
  }
  $("invite-email").value = "";
  toast("Invite created — tell them to sign up with " + email);
  renderTeam();
});

$("invites-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-invite]");
  if (!btn) return;
  const { error } = await db.from("invites").delete().eq("id", btn.dataset.delInvite);
  if (error) { toast("Could not revoke: " + error.message, true); return; }
  toast("Invite revoked");
  renderTeam();
});

let rateTimers = {};
$("members-body").addEventListener("input", (e) => {
  const input = e.target;
  if (!input.dataset.member) return;
  const key = input.dataset.member + ":" + input.dataset.rateField;

  clearTimeout(rateTimers[key]);
  rateTimers[key] = setTimeout(async () => {
    const { error } = await db
      .from("profiles")
      .update({ [input.dataset.rateField]: num(input.value) })
      .eq("id", input.dataset.member);
    if (error) { toast("Rate update failed: " + error.message, true); return; }
    toast("Rate updated");
    if (input.dataset.member === currentUser.id) {
      currentProfile[input.dataset.rateField] = num(input.value);
    }
  }, 700);
});

// ════════════════════════════════════════════════════════════
// PAYROLL (admin)
// ════════════════════════════════════════════════════════════
$("pay-month-prev").addEventListener("click", () => {
  payMonth = new Date(payMonth.getFullYear(), payMonth.getMonth() - 1, 1);
  renderPayroll();
});
$("pay-month-next").addEventListener("click", () => {
  payMonth = new Date(payMonth.getFullYear(), payMonth.getMonth() + 1, 1);
  renderPayroll();
});

async function renderPayroll() {
  $("pay-month-label").textContent = monthLabel(payMonth);
  $("member-sheet-panel").classList.add("hidden");
  memberSheetTarget = null;

  const { first, last } = monthRange(payMonth);
  const pKeys = [periodKey(payMonth, 1), periodKey(payMonth, 2)];
  const m2 = String(payMonth.getMonth() + 1).padStart(2, "0");
  const pay15Key = `${payMonth.getFullYear()}-${m2}-P15`;
  const pay1Key = `${payMonth.getFullYear()}-${m2}-P1`;

  const [
    { data: members, error: memErr },
    { data: sheets, error: shErr },
    { data: subs, error: subErr },
    { data: pays, error: payErr },
  ] = await Promise.all([
    db.from("profiles").select("*").order("name", { ascending: true }),
    db.from("timesheets").select("*").gte("entry_date", first).lte("entry_date", last),
    db.from("submissions").select("*").in("period", pKeys),
    db.from("payments").select("*").in("period", [pay15Key, pay1Key]),
  ]);

  const body = $("payroll-body");
  body.innerHTML = "";

  if (memErr || shErr || subErr || payErr) {
    body.innerHTML = `<tr><td colspan="8">Failed to load payroll data.</td></tr>`;
    return;
  }
  membersCache = members || [];

  const grand = { h1Hours: 0, h2Hours: 0, comm: 0, net: 0, on15: 0, on1: 0, total: 0 };

  membersCache.forEach((m) => {
    const rows = (sheets || []).filter((s) => s.user_id === m.id);
    let h1Hours = 0, h2Hours = 0, commMonth = 0, netMonth = 0;

    rows.forEach((r) => {
      const day = parseInt(r.entry_date.slice(8), 10);
      const calc = calcRow(r, m);
      commMonth += calc.commission;
      netMonth += calc.total;
      if (day <= 14) { h1Hours += num(r.hours); }
      else { h2Hours += num(r.hours); }
    });

    const h1Pay = h1Hours * num(m.hourly_rate);
    const h2Pay = h2Hours * num(m.hourly_rate);
    const payOn15 = h1Pay;                 // 15th: hours 1–14 only
    const payOn1 = h2Pay + commMonth;      // 1st: hours 15–end + ALL commission
    const monthTotal = payOn15 + payOn1;

    grand.h1Hours += h1Hours;
    grand.h2Hours += h2Hours;
    grand.comm += commMonth;
    grand.net += netMonth;
    grand.on15 += payOn15;
    grand.on1 += payOn1;
    grand.total += monthTotal;

    const h1Sub = (subs || []).some((s) => s.user_id === m.id && s.period === pKeys[0]);
    const h2Sub = (subs || []).some((s) => s.user_id === m.id && s.period === pKeys[1]);
    const badge = (ok, label) =>
      `<span class="sub-badge ${ok ? "ok" : ""}" title="${label}">${ok ? "✓" : "–"}</span>`;

    const paid15 = (pays || []).some((p) => p.user_id === m.id && p.period === pay15Key);
    const paid1 = (pays || []).some((p) => p.user_id === m.id && p.period === pay1Key);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="member-link" data-view-member="${m.id}" type="button">${m.name || m.email}</button></td>
      <td>${badge(h1Sub, "1st half")} ${badge(h2Sub, "2nd half")}</td>
      <td class="col-num">${h1Hours}</td>
      <td class="col-num">${h2Hours}</td>
      <td class="col-num cell-total">${fmt(netMonth)}</td>
      <td class="col-num cell-grey">${fmt(commMonth)}</td>
      <td class="col-num cell-payout${paid15 ? " paid" : ""}">
        <label class="paid-wrap" title="Mark paid">
          <strong>${fmt(payOn15)}</strong>
          <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay15Key}" ${paid15 ? "checked" : ""}>
        </label>
      </td>
      <td class="col-num cell-payout${paid1 ? " paid" : ""}">
        <label class="paid-wrap" title="Mark paid">
          <strong>${fmt(payOn1)}</strong>
          <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay1Key}" ${paid1 ? "checked" : ""}>
        </label>
      </td>
      <td class="col-num"><strong>${fmt(monthTotal)}</strong></td>
    `;
    body.appendChild(tr);
  });

  $("payroll-foot").innerHTML = `
    <tr>
      <td>ALL MEMBERS</td>
      <td></td>
      <td class="col-num">${grand.h1Hours}</td>
      <td class="col-num">${grand.h2Hours}</td>
      <td class="col-num cell-total">${fmt(grand.net)}</td>
      <td class="col-num cell-grey">${fmt(grand.comm)}</td>
      <td class="col-num cell-payout"><strong>${fmt(grand.on15)}</strong></td>
      <td class="col-num cell-payout"><strong>${fmt(grand.on1)}</strong></td>
      <td class="col-num"><strong>${fmt(grand.total)}</strong></td>
    </tr>
  `;
}

// toggle paid checkboxes
$("payroll-body").addEventListener("change", async (e) => {
  const check = e.target;
  if (!check.classList.contains("paid-check")) return;

  const userId = check.dataset.payUser;
  const period = check.dataset.payPeriod;
  const cell = check.closest("td");

  if (check.checked) {
    const { error } = await db.from("payments").insert({ user_id: userId, period });
    if (error && error.code !== "23505") {
      check.checked = false;
      toast("Could not mark as paid: " + error.message, true);
      return;
    }
    if (cell) cell.classList.add("paid");
    toast("Marked as paid ✓");
  } else {
    const { error } = await db.from("payments").delete().eq("user_id", userId).eq("period", period);
    if (error) {
      check.checked = true;
      toast("Could not unmark: " + error.message, true);
      return;
    }
    if (cell) cell.classList.remove("paid");
    toast("Unmarked");
  }
});

// open a member's editable sheet (click again to minimize)
$("payroll-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-view-member]");
  if (!btn) return;

  // clicking the same member again closes the panel
  if (memberSheetTarget && memberSheetTarget.id === btn.dataset.viewMember) {
    $("member-sheet-panel").classList.add("hidden");
    memberSheetTarget = null;
    return;
  }

  const member = membersCache.find((m) => m.id === btn.dataset.viewMember);
  if (!member) return;

  memberSheetTarget = member;
  $("member-sheet-title").textContent =
    (member.name || member.email) + " — " + monthLabel(payMonth);
  $("member-sheet-panel").classList.remove("hidden");

  await renderUserSheet($("member-sheet-sections"), member, payMonth, "admin");
  $("member-sheet-panel").scrollIntoView({ behavior: "smooth" });
});

// ── Boot ────────────────────────────────────────────────────
init();
