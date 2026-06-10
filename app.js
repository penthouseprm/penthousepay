// ============================================================
// TIMESHEETS — Penthouse Promotions
// Vanilla JS + Supabase
// ============================================================

const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── State ───────────────────────────────────────────────────
let currentUser = null;      // supabase auth user
let currentProfile = null;   // row from profiles
let sheetMonth = startOfMonth(new Date());   // my timesheet month
let payMonth = startOfMonth(new Date());     // payroll month
let saveTimers = {};         // per-date debounce timers
let membersCache = [];

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
    // Supabase wraps trigger exceptions — surface invite errors clearly
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

// Allow Enter key to submit auth forms
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

// nav switching
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

async function renderMySheet() {
  $("month-label").textContent = monthLabel(sheetMonth);
  setSaveStatus("", "");

  const rows = await loadMonthRows(currentUser.id, sheetMonth);
  const body = $("sheet-body");
  body.innerHTML = "";

  const year = sheetMonth.getFullYear();
  const monthIdx = sheetMonth.getMonth();
  const total = daysInMonth(sheetMonth);

  for (let day = 1; day <= total; day++) {
    const date = isoDate(year, monthIdx, day);
    const row = rows[date] || { hours: "", of_gross: "", fv_gross: "", slushy_gross: "", fansly_gross: "" };
    const dateObj = new Date(year, monthIdx, day);
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

    const tr = document.createElement("tr");
    tr.dataset.date = date;
    if (isWeekend) tr.classList.add("weekend");

    const label = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });

    tr.innerHTML = `
      <td class="col-date">${label}</td>
      <td class="col-num"><input class="cell hours" data-field="hours" type="number" min="0" step="0.5" value="${row.hours || ""}" placeholder="–"></td>
      <td class="col-num"><input class="cell" data-field="of_gross" type="number" min="0" step="0.01" value="${row.of_gross || ""}" placeholder="–"></td>
      <td class="col-num net-of" data-cell="of-net"></td>
      <td class="col-num"><input class="cell" data-field="fv_gross" type="number" min="0" step="0.01" value="${row.fv_gross || ""}" placeholder="–"></td>
      <td class="col-num net-fv" data-cell="fv-net"></td>
      <td class="col-num"><input class="cell" data-field="slushy_gross" type="number" min="0" step="0.01" value="${row.slushy_gross || ""}" placeholder="–"></td>
      <td class="col-num net-slushy" data-cell="slushy-net"></td>
      <td class="col-num"><input class="cell" data-field="fansly_gross" type="number" min="0" step="0.01" value="${row.fansly_gross || ""}" placeholder="–"></td>
      <td class="col-num net-fansly" data-cell="fansly-net"></td>
      <td class="col-num cell-total" data-cell="total"></td>
      <td class="col-num cell-comm" data-cell="comm"></td>
      <td class="col-num cell-pay" data-cell="pay"></td>
    `;
    body.appendChild(tr);
    recalcDisplayRow(tr);
  }

  recalcTotals();
}

// recalc a single row's computed cells from its inputs
function recalcDisplayRow(tr) {
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
    currentProfile
  );
  tr.querySelector('[data-cell="of-net"]').textContent = fmt(calc.ofNet);
  tr.querySelector('[data-cell="fv-net"]').textContent = fmt(calc.fvNet);
  tr.querySelector('[data-cell="slushy-net"]').textContent = fmt(calc.slushyNet);
  tr.querySelector('[data-cell="fansly-net"]').textContent = fmt(calc.fanslyNet);
  tr.querySelector('[data-cell="total"]').textContent = fmt(calc.total);
  tr.querySelector('[data-cell="comm"]').textContent = fmt(calc.commission);
  tr.querySelector('[data-cell="pay"]').textContent = fmt(calc.hoursPay);
}

function recalcTotals() {
  const body = $("sheet-body");
  const sums = { hours: 0, of: 0, fv: 0, slushy: 0, fansly: 0, ofNet: 0, fvNet: 0, slushyNet: 0, fanslyNet: 0, total: 0, comm: 0, pay: 0 };

  body.querySelectorAll("tr").forEach((tr) => {
    const get = (field) => num(tr.querySelector(`input[data-field="${field}"]`).value);
    const row = {
      hours: get("hours"),
      of_gross: get("of_gross"),
      fv_gross: get("fv_gross"),
      slushy_gross: get("slushy_gross"),
      fansly_gross: get("fansly_gross"),
    };
    const calc = calcRow(row, currentProfile);
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

  $("sheet-foot").innerHTML = `
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

// delegated input handler — recalc + debounced save per row
$("sheet-body").addEventListener("input", (e) => {
  const input = e.target;
  if (!input.classList.contains("cell")) return;

  const tr = input.closest("tr");
  recalcDisplayRow(tr);
  recalcTotals();

  const date = tr.dataset.date;
  setSaveStatus("saving", "Saving…");

  clearTimeout(saveTimers[date]);
  saveTimers[date] = setTimeout(() => saveSheetRow(tr, date), 700);
});

async function saveSheetRow(tr, date) {
  const get = (field) => num(tr.querySelector(`input[data-field="${field}"]`).value);

  const payload = {
    user_id: currentUser.id,
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
    return;
  }
  setSaveStatus("saved", "All changes saved");
}

// ════════════════════════════════════════════════════════════
// TEAM (admin)
// ════════════════════════════════════════════════════════════
async function renderTeam() {
  // invites
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

  // members
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

// delegated: revoke invite buttons
$("invites-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-invite]");
  if (!btn) return;
  const { error } = await db.from("invites").delete().eq("id", btn.dataset.delInvite);
  if (error) { toast("Could not revoke: " + error.message, true); return; }
  toast("Invite revoked");
  renderTeam();
});

// delegated: rate edits with debounce
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
    // keep own profile in sync if editing self
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

  const { first, last } = monthRange(payMonth);

  const [{ data: members, error: memErr }, { data: sheets, error: shErr }] = await Promise.all([
    db.from("profiles").select("*").order("name", { ascending: true }),
    db.from("timesheets").select("*").gte("entry_date", first).lte("entry_date", last),
  ]);

  const body = $("payroll-body");
  body.innerHTML = "";

  if (memErr || shErr) {
    body.innerHTML = `<tr><td colspan="7">Failed to load payroll data.</td></tr>`;
    return;
  }
  membersCache = members || [];

  const grand = { hours: 0, total: 0, comm: 0, pay: 0, out: 0 };

  membersCache.forEach((m) => {
    const rows = (sheets || []).filter((s) => s.user_id === m.id);
    const sums = { hours: 0, total: 0, comm: 0, pay: 0 };
    rows.forEach((r) => {
      const calc = calcRow(r, m);
      sums.hours += num(r.hours);
      sums.total += calc.total;
      sums.comm += calc.commission;
      sums.pay += calc.hoursPay;
    });
    const payout = sums.comm + sums.pay;

    grand.hours += sums.hours;
    grand.total += sums.total;
    grand.comm += sums.comm;
    grand.pay += sums.pay;
    grand.out += payout;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="member-link" data-view-member="${m.id}" type="button">${m.name || m.email}</button></td>
      <td class="col-num">${sums.hours}</td>
      <td class="col-num cell-total">${fmt(sums.total)}</td>
      <td class="col-num cell-comm">${fmt(sums.comm)}</td>
      <td class="col-num cell-pay">${fmt(sums.pay)}</td>
      <td class="col-num"><strong>${fmt(payout)}</strong></td>
      <td><span class="hint">view sheet →</span></td>
    `;
    body.appendChild(tr);
  });

  $("payroll-foot").innerHTML = `
    <tr>
      <td>ALL MEMBERS</td>
      <td class="col-num">${grand.hours}</td>
      <td class="col-num cell-total">${fmt(grand.total)}</td>
      <td class="col-num cell-comm">${fmt(grand.comm)}</td>
      <td class="col-num cell-pay">${fmt(grand.pay)}</td>
      <td class="col-num"><strong>${fmt(grand.out)}</strong></td>
      <td></td>
    </tr>
  `;
}

// delegated: open a member's full sheet
$("payroll-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-view-member]");
  if (!btn) return;

  const member = membersCache.find((m) => m.id === btn.dataset.viewMember);
  if (!member) return;

  $("member-sheet-title").textContent =
    (member.name || member.email) + " — " + monthLabel(payMonth);
  $("member-sheet-panel").classList.remove("hidden");

  const rows = await loadMonthRows(member.id, payMonth);
  const body = $("member-sheet-body");
  body.innerHTML = "";

  const year = payMonth.getFullYear();
  const monthIdx = payMonth.getMonth();
  const total = daysInMonth(payMonth);
  const sums = { hours: 0, of: 0, fv: 0, slushy: 0, fansly: 0, ofNet: 0, fvNet: 0, slushyNet: 0, fanslyNet: 0, total: 0, comm: 0, pay: 0 };

  for (let day = 1; day <= total; day++) {
    const date = isoDate(year, monthIdx, day);
    const row = rows[date];
    const dateObj = new Date(year, monthIdx, day);
    const label = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });

    const tr = document.createElement("tr");
    if (dateObj.getDay() === 0 || dateObj.getDay() === 6) tr.classList.add("weekend");

    if (!row) {
      tr.innerHTML = `<td class="col-date">${label}</td>` + `<td class="col-num">—</td>`.repeat(12);
      body.appendChild(tr);
      continue;
    }

    const calc = calcRow(row, member);
    sums.hours += num(row.hours);
    sums.of += num(row.of_gross);
    sums.fv += num(row.fv_gross);
    sums.slushy += num(row.slushy_gross);
    sums.fansly += num(row.fansly_gross);
    sums.ofNet += calc.ofNet;
    sums.fvNet += calc.fvNet;
    sums.slushyNet += calc.slushyNet;
    sums.fanslyNet += calc.fanslyNet;
    sums.total += calc.total;
    sums.comm += calc.commission;
    sums.pay += calc.hoursPay;

    tr.innerHTML = `
      <td class="col-date">${label}</td>
      <td class="col-num">${num(row.hours) || "—"}</td>
      <td class="col-num">${fmt(row.of_gross)}</td>
      <td class="col-num net-of">${fmt(calc.ofNet)}</td>
      <td class="col-num">${fmt(row.fv_gross)}</td>
      <td class="col-num net-fv">${fmt(calc.fvNet)}</td>
      <td class="col-num">${fmt(row.slushy_gross)}</td>
      <td class="col-num net-slushy">${fmt(calc.slushyNet)}</td>
      <td class="col-num">${fmt(row.fansly_gross)}</td>
      <td class="col-num net-fansly">${fmt(calc.fanslyNet)}</td>
      <td class="col-num cell-total">${fmt(calc.total)}</td>
      <td class="col-num cell-comm">${fmt(calc.commission)}</td>
      <td class="col-num cell-pay">${fmt(calc.hoursPay)}</td>
    `;
    body.appendChild(tr);
  }

  $("member-sheet-foot").innerHTML = `
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
});

// ── Boot ────────────────────────────────────────────────────
init();
