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
let bonusMonth = startOfMonth(new Date());
let teamMonth = startOfMonth(new Date());
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
  return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function roleLabel(role) {
  if (role === "member") return "Chatter";
  if (role === "non_chatter") return "Non-Chatter";
  if (role === "super_admin") return "Super Admin";
  return "Admin";
}

function isAdminUser(profile) {
  return profile.role === "admin" || profile.role === "super_admin";
}

function isSuperAdmin(profile) {
  return profile.role === "super_admin";
}

function isTestUser(profile) {
  // test accounts are hidden from all production/admin views
  return profile.role === "test";
}

// strips test accounts out of any member list shown to admins
function realMembers(list) {
  return (list || []).filter((m) => !isTestUser(m));
}

function isNonChatter(profile) {
  // admins are classified as non-chatters: hourly-only timesheets,
  // no sales/commission, no bonuses, not eligible for sales teams.
  // super admins are excluded from everything (not an employee).
  return profile.role === "non_chatter" || profile.role === "admin" || profile.role === "super_admin";
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

  if (profile.active === false) {
    showAuthError("This account has been deactivated. Contact an admin if you think this is a mistake.");
    await db.auth.signOut();
    $("auth-view").classList.remove("hidden");
    $("app-view").classList.add("hidden");
    return;
  }

  currentProfile = profile;
  $("user-name").textContent = profile.name || profile.email;

  if (isAdminUser(profile)) {
    document.querySelectorAll(".admin-only").forEach((el) => el.classList.remove("hidden"));
  }
  if (profile.role === "member" || profile.role === "test") {
    document.querySelectorAll(".member-only").forEach((el) => el.classList.remove("hidden"));
  }

  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");

  loadBonusBanners();
  loadLeaveBanners();
  renderMySheet();
}

// ── leave decision banners ──
async function loadLeaveBanners() {
  if (currentProfile.role !== "member") return;

  const { data: events, error } = await db
    .from("leave_requests")
    .select("*")
    .eq("user_id", currentUser.id)
    .neq("status", "pending")
    .eq("seen", false)
    .order("decided_at", { ascending: true });

  if (error || !events || !events.length) return;

  const container = $("bonus-banners");

  events.forEach((ev) => {
    const banner = document.createElement("div");
    const approved = ev.status === "approved";
    banner.className = "bonus-banner" + (approved ? "" : " leave-rejected");
    let icon, text;
    if (approved) {
      icon = "🌴";
      text = `Your leave request for <strong>${leaveRangeLabel(ev)}</strong> was <strong>approved</strong>.`;
    } else if (ev.status === "cancelled") {
      icon = "📋";
      text = `Your approved leave for <strong>${leaveRangeLabel(ev)}</strong> has been <strong>cancelled</strong> by an admin.`;
    } else {
      icon = "📋";
      text = `Your leave request for <strong>${leaveRangeLabel(ev)}</strong> was <strong>rejected</strong>.`;
    }
    banner.innerHTML = `
      <span class="bonus-banner-icon">${icon}</span>
      <span class="bonus-banner-text">${text}</span>
      <button class="bonus-banner-x" data-seen-leave="${ev.id}" type="button" title="Dismiss">✕</button>
    `;
    container.appendChild(banner);
  });
}

$("bonus-banners").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-seen-leave]");
  if (!btn) return;
  const banner = btn.closest(".bonus-banner");
  const { error } = await db.from("leave_requests").update({ seen: true }).eq("id", btn.dataset.seenLeave);
  if (error) { toast("Could not dismiss: " + error.message, true); return; }
  banner.remove();
});

// ── bonus celebration banners ──
const BONUS_LABELS = {
  full_script: "Full Script",
  rebuttal: "Rebuttal",
  team: "Team",
  individual: "Individual",
  extras: "Extras",
};

async function loadBonusBanners() {
  // only chatters receive bonuses
  if (currentProfile.role !== "member") return;

  const { data: events, error } = await db
    .from("bonus_events")
    .select("*")
    .eq("user_id", currentUser.id)
    .eq("dismissed", false)
    .order("created_at", { ascending: true });

  if (error || !events || !events.length) return;

  const container = $("bonus-banners");
  container.innerHTML = "";

  events.forEach((ev) => {
    const banner = document.createElement("div");
    banner.className = "bonus-banner";
    banner.innerHTML = `
      <span class="bonus-banner-icon">🎉</span>
      <span class="bonus-banner-text">Congratulations! <strong>${fmt(ev.amount)}</strong> bonus received for <strong>${ev.label}</strong>!</span>
      <button class="bonus-banner-x" data-dismiss-bonus="${ev.id}" type="button" title="Dismiss">✕</button>
    `;
    container.appendChild(banner);
  });
}

$("bonus-banners").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-dismiss-bonus]");
  if (!btn) return;

  const banner = btn.closest(".bonus-banner");
  const { error } = await db
    .from("bonus_events")
    .update({ dismissed: true })
    .eq("id", btn.dataset.dismissBonus);

  if (error) { toast("Could not dismiss: " + error.message, true); return; }
  banner.remove();
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    ["my-timesheet", "overtime", "request-leave", "team", "team-sales", "bonuses", "overtime-rq", "leave-rq", "payroll"].forEach((v) => {
      $("view-" + v).classList.toggle("hidden", v !== view);
    });
    if (view === "my-timesheet") renderMySheet();
    if (view === "overtime") renderOvertime();
    if (view === "request-leave") renderRequestLeave();
    if (view === "team") renderTeam();
    if (view === "team-sales") renderTeamSales();
    if (view === "bonuses") renderBonuses();
    if (view === "overtime-rq") renderOvertimeRQ();
    if (view === "leave-rq") renderLeaveRQ();
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

// Fetches ALL timesheet rows across ALL members for a date range, paging past
// Supabase's default 1000-row cap. Without this, a full month across many
// chatters silently drops rows and undercounts payroll / team-sales totals.
async function fetchAllTimesheets(first, last) {
  const all = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("timesheets")
      .select("*")
      .gte("entry_date", first)
      .lte("entry_date", last)
      .order("entry_date", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) { toast("Failed to load timesheets: " + error.message, true); break; }
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
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

// non-chatters: hourly only, no sales columns
const NC_SHEET_HEAD = `
  <tr>
    <th class="col-date">Date</th>
    <th class="col-num th-hours">Hours</th>
    <th class="col-num th-pay">Hours $</th>
  </tr>
`;

async function renderUserSheet(container, profile, monthDate, mode) {
  container.dataset.userId = profile.id;
  container.dataset.mode = mode;
  container.innerHTML = "";

  const { first, last } = monthRange(monthDate);
  const [rows, subs, otData] = await Promise.all([
    loadMonthRows(profile.id, monthDate),
    loadSubmissions(profile.id, monthDate),
    // approved overtime for this member in this month (skip in preview, no real user)
    mode === "preview"
      ? Promise.resolve({ data: [] })
      : db.from("overtime_requests").select("*")
          .eq("user_id", profile.id).eq("status", "approved")
          .gte("ot_date", first).lte("ot_date", last),
  ]);

  // map approved overtime by date → pay amount
  const otByDate = {};
  (otData.data || []).forEach((o) => {
    const pay = num(o.hours) * num(profile.hourly_rate) * (1 + num(o.boost_pct) / 100);
    otByDate[o.ot_date] = (otByDate[o.ot_date] || 0) + pay;
  });

  const year = monthDate.getFullYear();
  const monthIdx = monthDate.getMonth();
  const lastDay = daysInMonth(monthDate);

  [1, 2].forEach((half) => {
    const pKey = periodKey(monthDate, half);
    const submittedAt = subs[pKey] || null;
    const isAdmin = isAdminUser(currentProfile);
    // preview mode: always read-only; members can't edit a submitted period; admins always can
    const editable = mode === "preview" ? false : (isAdmin || !submittedAt);

    const firstDay = half === 1 ? 1 : 15;
    const endDay = half === 1 ? 14 : lastDay;

    const section = document.createElement("section");
    section.className = "panel sheet-section" + (submittedAt && !isAdmin ? " locked" : "");
    section.dataset.period = pKey;
    section.dataset.half = String(half);
    if (isNonChatter(profile)) section.dataset.nc = "1";

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
    table.className = "sheet" + (isNonChatter(profile) ? " plain" : "");
    table.innerHTML = `<thead>${isNonChatter(profile) ? NC_SHEET_HEAD : SHEET_HEAD}</thead>`;
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
      const otAmount = otByDate[date];
      const otIcon = otAmount
        ? ` <button class="ot-flag" type="button" data-ot-amount="${otAmount.toFixed(2)}" title="Overtime approved">⏱</button>`
        : "";

      if (isNonChatter(profile)) {
        tr.innerHTML = `
          <td class="col-date">${label}${otIcon}</td>
          <td class="col-num"><input class="cell hours" data-field="hours" type="number" min="0" step="0.5" value="${row.hours || ""}" placeholder="–" ${dis}></td>
          <td class="col-num cell-pay" data-cell="pay"></td>
        `;
      } else {
        tr.innerHTML = `
          <td class="col-date">${label}${otIcon}</td>
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
      }
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

    if (mode === "preview") {
      bar.innerHTML = `<span class="hint">Preview only — this is what a ${profile.role === "member" ? "Chatter" : "Non-Chatter"} timesheet looks like. Inputs are disabled.</span>`;
    } else if (mode === "self") {
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
  const setCell = (name, val) => {
    const el = tr.querySelector(`[data-cell="${name}"]`);
    if (el) el.textContent = val;
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
  setCell("of-net", fmt(calc.ofNet));
  setCell("fv-net", fmt(calc.fvNet));
  setCell("slushy-net", fmt(calc.slushyNet));
  setCell("fansly-net", fmt(calc.fanslyNet));
  setCell("total", fmt(calc.total));
  setCell("comm", fmt(calc.commission));
  setCell("pay", fmt(calc.hoursPay));
}

function recalcHalfTotals(section, profile) {
  const tbody = section.querySelector(".half-body");
  const tfoot = section.querySelector(".half-foot");
  const sums = { hours: 0, of: 0, fv: 0, slushy: 0, fansly: 0, ofNet: 0, fvNet: 0, slushyNet: 0, fanslyNet: 0, total: 0, comm: 0, pay: 0 };

  tbody.querySelectorAll("tr").forEach((tr) => {
    const get = (field) => {
      const el = tr.querySelector(`input[data-field="${field}"]`);
      return el ? num(el.value) : 0;
    };
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

  if (section.dataset.nc === "1") {
    tfoot.innerHTML = `
      <tr>
        <td>TOTAL</td>
        <td class="col-num">${sums.hours}</td>
        <td class="col-num cell-pay">${fmt(sums.pay)}</td>
      </tr>
    `;
    return;
  }

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
  const get = (field) => {
    const el = tr.querySelector(`input[data-field="${field}"]`);
    return el ? num(el.value) : 0;
  };

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
  const next = new Date(sheetMonth.getFullYear(), sheetMonth.getMonth() + 1, 1);
  if (next.getTime() > startOfMonth(new Date()).getTime()) {
    toast("That timesheet isn't available yet — it opens on the 1st.");
    return;
  }
  sheetMonth = next;
  renderMySheet();
});

async function renderMySheet() {
  $("month-label").textContent = monthLabel(sheetMonth);
  setSaveStatus("", "");

  // future months are unavailable until they start
  const atCurrentMonth = sheetMonth.getTime() >= startOfMonth(new Date()).getTime();
  $("month-next").disabled = atCurrentMonth;
  $("month-next").style.opacity = atCurrentMonth ? "0.35" : "1";

  // super admin: no timesheet of their own — read-only preview of each role's sheet
  if (isSuperAdmin(currentProfile)) {
    $("my-sheet-title").textContent = "Timesheet Preview";
    $("preview-role").classList.remove("hidden");
    const previewProfile = {
      id: currentUser.id,
      role: $("preview-role").value,
      hourly_rate: 2,
      commission_rate: 0.03,
    };
    await renderUserSheet($("my-sheet-sections"), previewProfile, sheetMonth, "preview");
    return;
  }

  await renderUserSheet($("my-sheet-sections"), currentProfile, sheetMonth, "self");
}

$("preview-role").addEventListener("change", () => renderMySheet());

// auto-rollover: when a new month starts, move anyone viewing the
// (old) current month onto the new one automatically
let realMonth = startOfMonth(new Date());
setInterval(() => {
  const nowMonth = startOfMonth(new Date());
  if (nowMonth.getTime() !== realMonth.getTime()) {
    const prevMonth = realMonth;
    realMonth = nowMonth;
    if (currentUser && sheetMonth.getTime() === prevMonth.getTime()) {
      sheetMonth = nowMonth;
      if (!$("view-my-timesheet").classList.contains("hidden")) renderMySheet();
    }
  }
}, 60000);

$("my-sheet-sections").addEventListener("input", handleSheetInput);
$("member-sheet-sections").addEventListener("input", handleSheetInput);

// overtime flag click → small popover anchored to the icon
function handleOtFlagClick(e) {
  const flag = e.target.closest(".ot-flag");

  // close any open popover when clicking elsewhere
  document.querySelectorAll(".ot-popover").forEach((p) => p.remove());
  if (!flag) return;

  e.stopPropagation();
  const amount = "$" + num(flag.dataset.otAmount).toFixed(2);

  const pop = document.createElement("div");
  pop.className = "ot-popover";
  pop.innerHTML = `Overtime request accepted.<br><strong>${amount}</strong> added to next pay.`;

  // anchor relative to the icon
  const wrap = flag.closest("td");
  wrap.style.position = "relative";
  wrap.appendChild(pop);
}
$("my-sheet-sections").addEventListener("click", handleOtFlagClick);
$("member-sheet-sections").addEventListener("click", handleOtFlagClick);
// click anywhere else closes the popover
document.addEventListener("click", (e) => {
  if (!e.target.closest(".ot-flag") && !e.target.closest(".ot-popover")) {
    document.querySelectorAll(".ot-popover").forEach((p) => p.remove());
  }
});

// ════════════════════════════════════════════════════════════
// TEAM (admin)
// ════════════════════════════════════════════════════════════
async function renderTeam() {
  const { data: invites, error: invErr } = await db
    .from("invites")
    .select("*")
    .eq("used", false)
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
        <span class="pill">${roleLabel(inv.role)}</span>
        <span class="pill" style="background:rgba(138,146,166,0.12);color:var(--text-dim)">Pending</span>
        <span class="spacer"></span>
        <button class="btn btn-danger btn-small" data-del-invite="${inv.id}" type="button">Revoke</button>
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
  membersCache = realMembers(members);

  membersCache.forEach((m) => {
    const tr = document.createElement("tr");
    tr.dataset.memberRow = m.id;

    if (isSuperAdmin(m)) {
      tr.innerHTML = `
        <td>${m.name || "—"}</td>
        <td>${m.email}</td>
        <td><span class="role-pill super_admin">${roleLabel(m.role)}</span></td>
        <td class="col-num"><span class="hint">—</span></td>
        <td class="col-num"><span class="hint">—</span></td>
        <td><span class="hint">owner — not an employee</span></td>
        <td class="actions-cell">${isSuperAdmin(currentProfile) ? `<button class="btn btn-ghost btn-small" data-edit-member="${m.id}" type="button">Edit</button>` : ""}${m.id === currentUser.id ? '<span class="hint">you</span>' : ""}</td>
      `;
      body.appendChild(tr);
      return;
    }

    const commCell = isNonChatter(m)
      ? `<td class="col-num"><span class="hint">—</span></td><td><span class="hint">hourly only</span></td>`
      : `<td class="col-num"><input class="cell rate" data-member="${m.id}" data-rate-field="commission_rate" type="number" min="0" step="0.001" value="${m.commission_rate}"></td><td><span class="hint">commission as decimal — 0.03 = 3%</span></td>`;

    const isSelf = m.id === currentUser.id;
    const isDeactivated = m.active === false;
    const canEdit = isSuperAdmin(currentProfile);
    const editBtn = canEdit ? `<button class="btn btn-ghost btn-small" data-edit-member="${m.id}" type="button">Edit</button>` : "";
    const firedBadge = m.fired ? ` <span class="fired-badge">FIRED</span>` : "";
    const deactivatedBadge = isDeactivated ? ` <span class="deactivated-badge">DEACTIVATED</span>` : "";
    let actionsCell;
    if (isSelf) {
      actionsCell = `<td class="actions-cell">${editBtn}<span class="hint">you</span></td>`;
    } else if (isDeactivated) {
      actionsCell = `<td class="actions-cell">
        ${editBtn}
        <button class="btn btn-danger btn-small" data-remove-member="${m.id}" type="button">Remove</button>
      </td>`;
    } else {
      actionsCell = `<td class="actions-cell">
        ${editBtn}
        ${m.fired
          ? `<button class="btn btn-ghost btn-small" data-unfire-member="${m.id}" type="button">Unfire</button>`
          : `<button class="btn btn-danger btn-small" data-fire-member="${m.id}" type="button">Fired</button>`}
        <button class="btn btn-danger btn-small" data-remove-member="${m.id}" type="button">Remove</button>
      </td>`;
    }

    tr.innerHTML = `
      <td>${m.name || "—"}${firedBadge}${deactivatedBadge}</td>
      <td>${m.email}</td>
      <td><span class="role-pill ${m.role}">${roleLabel(m.role)}</span></td>
      <td class="col-num"><input class="cell rate" data-member="${m.id}" data-rate-field="hourly_rate" type="number" min="0" step="0.25" value="${m.hourly_rate}"></td>
      ${commCell}
      ${actionsCell}
    `;
    body.appendChild(tr);
  });
}

// fire / unfire / remove / edit members
$("members-body").addEventListener("click", async (e) => {
  // enter edit mode (super admin only)
  const editBtn = e.target.closest("[data-edit-member]");
  if (editBtn) {
    const m = membersCache.find((x) => x.id === editBtn.dataset.editMember);
    if (!m) return;
    const tr = $("members-body").querySelector(`tr[data-member-row="${m.id}"]`);
    if (!tr) return;
    tr.innerHTML = `
      <td><input class="edit-field" data-edit-name value="${m.name || ""}" placeholder="Name"></td>
      <td><input class="edit-field" data-edit-email type="email" value="${m.email}" placeholder="email@example.com"></td>
      <td><span class="role-pill ${m.role}">${roleLabel(m.role)}</span></td>
      <td colspan="3"><span class="hint">Editing name &amp; email — changing the email also changes their login</span></td>
      <td class="actions-cell">
        <button class="btn btn-primary btn-small" data-save-member="${m.id}" type="button">Save</button>
        <button class="btn btn-ghost btn-small" data-cancel-edit type="button">Cancel</button>
      </td>
    `;
    return;
  }

  // save edit
  const saveBtn = e.target.closest("[data-save-member]");
  if (saveBtn) {
    const tr = saveBtn.closest("tr");
    const newName = tr.querySelector("[data-edit-name]").value.trim();
    const newEmail = tr.querySelector("[data-edit-email]").value.trim().toLowerCase();
    if (!newName || !newEmail.includes("@")) { toast("Enter a valid name and email.", true); return; }

    const { error } = await db.rpc("admin_update_member", {
      target_id: saveBtn.dataset.saveMember,
      new_name: newName,
      new_email: newEmail,
    });
    if (error) { toast("Update failed: " + error.message, true); return; }
    toast("Member updated ✓ They log in with the new email from now on.");
    renderTeam();
    return;
  }

  // cancel edit
  if (e.target.closest("[data-cancel-edit]")) {
    renderTeam();
    return;
  }

  const fireBtn = e.target.closest("[data-fire-member]");
  if (fireBtn) {
    const m = membersCache.find((x) => x.id === fireBtn.dataset.fireMember);
    if (!m) return;
    if (!confirm(`Mark ${m.name || m.email} as fired?\n\nTheir FULL remaining pay (including all commission and bonuses) will be due on the next payday. The day after that payday their login will be deactivated automatically — their data and pay history are kept.`)) return;

    const { error } = await db.from("profiles")
      .update({ fired: true, fired_at: new Date().toISOString() })
      .eq("id", m.id);
    if (error) { toast("Could not mark as fired: " + error.message, true); return; }
    toast(`${m.name || m.email} marked as fired`);
    renderTeam();
    return;
  }

  const unfireBtn = e.target.closest("[data-unfire-member]");
  if (unfireBtn) {
    const m = membersCache.find((x) => x.id === unfireBtn.dataset.unfireMember);
    if (!m) return;

    const { error } = await db.from("profiles")
      .update({ fired: false, fired_at: null })
      .eq("id", m.id);
    if (error) { toast("Could not unfire: " + error.message, true); return; }
    toast(`${m.name || m.email} is no longer marked as fired`);
    renderTeam();
    return;
  }

  const removeBtn = e.target.closest("[data-remove-member]");
  if (removeBtn) {
    const m = membersCache.find((x) => x.id === removeBtn.dataset.removeMember);
    if (!m) return;
    if (!confirm(`PERMANENTLY remove ${m.name || m.email} from the platform?\n\nThis deletes their account, login access, and ALL their data (timesheets, bonuses, fines, payment records). This cannot be undone.`)) return;
    if (!confirm(`Are you absolutely sure? ${m.name || m.email}'s entire history will be gone.`)) return;

    const { error } = await db.from("profiles").delete().eq("id", m.id);
    if (error) { toast("Could not remove member: " + error.message, true); return; }
    toast(`${m.name || m.email} removed from the platform`);
    renderTeam();
  }
});

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
// TEAM SALES (admin)
// ════════════════════════════════════════════════════════════
$("ts-month-prev").addEventListener("click", () => {
  teamMonth = new Date(teamMonth.getFullYear(), teamMonth.getMonth() - 1, 1);
  renderTeamSales();
});
$("ts-month-next").addEventListener("click", () => {
  teamMonth = new Date(teamMonth.getFullYear(), teamMonth.getMonth() + 1, 1);
  renderTeamSales();
});

// remembers which team cards are expanded between re-renders
let expandedTeams = new Set();

$("btn-create-team").addEventListener("click", async () => {
  const name = $("new-team-name").value.trim();
  const target = num($("new-team-target").value);
  if (!name) { toast("Enter a team name.", true); return; }

  const selectedIds = Array.from(
    $("new-team-chips").querySelectorAll(".chip-check:checked")
  ).map((c) => c.dataset.chipUser);

  if (!selectedIds.length) { toast("Select at least one chatter for the team.", true); return; }

  const { data: created, error } = await db
    .from("teams")
    .insert({ name, daily_target: target })
    .select()
    .single();
  if (error || !created) { toast("Could not create team: " + (error ? error.message : "unknown error"), true); return; }

  const memberRows = selectedIds.map((uid) => ({ team_id: created.id, user_id: uid }));
  const { error: tmError } = await db.from("team_members").insert(memberRows);
  if (tmError) { toast("Team created but adding members failed: " + tmError.message, true); }

  $("new-team-name").value = "";
  $("new-team-target").value = "";
  expandedTeams.add(created.id);
  toast("Team created ✓");
  renderTeamSales();
});

// visual state for the create-form chips
$("new-team-chips").addEventListener("change", (e) => {
  const check = e.target;
  if (!check.classList.contains("chip-check")) return;
  check.closest(".member-chip").classList.toggle("in-team", check.checked);
});

function memberChipHtml(m, inTeam) {
  return `
    <label class="member-chip${inTeam ? " in-team" : ""}">
      <input type="checkbox" class="chip-check" data-chip-user="${m.id}" ${inTeam ? "checked" : ""}>
      ${m.name || m.email}
    </label>
  `;
}

async function renderTeamSales() {
  $("ts-month-label").textContent = monthLabel(teamMonth);

  const { first, last } = monthRange(teamMonth);

  const [
    { data: teams, error: tErr },
    { data: teamMembers, error: tmErr },
    { data: members, error: mErr },
  ] = await Promise.all([
    db.from("teams").select("*").order("created_at", { ascending: true }),
    db.from("team_members").select("*"),
    db.from("profiles").select("*").order("name", { ascending: true }),
  ]);

  // timesheets fetched separately with pagination (can exceed 1000 rows/month)
  const sheets = await fetchAllTimesheets(first, last);

  const container = $("teams-container");
  container.innerHTML = "";

  if (tErr || tmErr || mErr) {
    container.innerHTML = `<p class="hint">Failed to load team sales data.</p>`;
    return;
  }
  membersCache = realMembers(members);

  // populate the create-form chips (all unchecked, chatters only)
  $("new-team-chips").innerHTML = membersCache
    .filter((m) => !isNonChatter(m))
    .map((m) => memberChipHtml(m, false))
    .join("");

  if (!teams || !teams.length) {
    container.innerHTML = `<p class="hint">No teams yet — create your first one above.</p>`;
    return;
  }

  const now = new Date();
  const todayIso = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  const year = teamMonth.getFullYear();
  const monthIdx = teamMonth.getMonth();
  const lastDay = daysInMonth(teamMonth);

  // pre-index sheets: date → userId → net total (robust to date/timestamp formats)
  const netByDateUser = {};
  (sheets || []).forEach((r) => {
    const dateKey = String(r.entry_date).slice(0, 10); // normalise "2026-06-17T..." → "2026-06-17"
    const m = membersCache.find((x) => x.id === r.user_id);
    if (!m) return;
    (netByDateUser[dateKey] = netByDateUser[dateKey] || {});
    netByDateUser[dateKey][r.user_id] =
      (netByDateUser[dateKey][r.user_id] || 0) + calcRow(r, m).total;
  });

  teams.forEach((team) => {
    const memberIds = (teamMembers || [])
      .filter((tm) => tm.team_id === team.id)
      .map((tm) => tm.user_id);

    // tally every day (needed for the summary even when collapsed)
    let hits = 0, misses = 0;
    const rowsHtml = [];

    for (let day = 1; day <= lastDay; day++) {
      const date = isoDate(year, monthIdx, day);
      const isFuture = date > todayIso;
      const dateObj = new Date(year, monthIdx, day);
      const label = dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });

      let dayNet = 0;
      const dayMap = netByDateUser[date];
      if (dayMap) {
        memberIds.forEach((uid) => { dayNet += dayMap[uid] || 0; });
      }

      let statusHtml = `<span class="ts-status future">—</span>`;
      if (!isFuture) {
        if (num(team.daily_target) === 0) {
          statusHtml = `<span class="ts-status future">No target</span>`;
        } else if (dayNet >= num(team.daily_target)) {
          statusHtml = `<span class="ts-status hit">HIT ✓</span>`;
          hits++;
        } else {
          statusHtml = `<span class="ts-status miss">MISS</span>`;
          misses++;
        }
      }

      rowsHtml.push(`
        <tr${(dateObj.getDay() === 0 || dateObj.getDay() === 6) ? ' class="weekend"' : ""}>
          <td class="col-date">${label}</td>
          <td class="col-num cell-total">${fmt(dayNet)}</td>
          <td class="col-num">${fmt(team.daily_target)}</td>
          <td>${statusHtml}</td>
        </tr>
      `);
    }

    const isExpanded = expandedTeams.has(team.id);

    const section = document.createElement("section");
    section.className = "panel team-card";
    section.dataset.teamId = team.id;

    section.innerHTML = `
      <button class="team-row" data-toggle-team type="button">
        <span class="team-row-name">${team.name}</span>
        <span class="team-row-meta">${memberIds.length} chatter${memberIds.length === 1 ? "" : "s"} · target ${fmt(team.daily_target)}/day</span>
        <span class="team-row-summary">
          <strong class="ts-hit-count">${hits} hit${hits === 1 ? "" : "s"}</strong>
          <strong class="ts-miss-count">${misses} miss${misses === 1 ? "" : "es"}</strong>
        </span>
        <span class="team-chevron${isExpanded ? " open" : ""}">▾</span>
      </button>

      <div class="team-detail${isExpanded ? "" : " hidden"}">
        <div class="team-head">
          <input class="team-name-input" data-tfield="name" value="${team.name}" title="Team name">
          <label class="team-target-label">Daily target $
            <input class="cell rate" data-tfield="daily_target" type="number" min="0" step="0.01" value="${team.daily_target}">
          </label>
          <span class="spacer"></span>
          <button class="btn btn-danger btn-small" data-del-team type="button">Delete team</button>
        </div>

        <div class="member-chips">
          ${membersCache.filter((m) => !isNonChatter(m)).map((m) => memberChipHtml(m, memberIds.includes(m.id))).join("")}
        </div>

        <div class="table-scroll">
          <table class="sheet plain" style="min-width: 560px;">
            <thead>
              <tr>
                <th class="col-date">Date</th>
                <th class="col-num th-total">Team Net Sales $</th>
                <th class="col-num th-grey">Target $</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rowsHtml.join("")}</tbody>
          </table>
        </div>
      </div>
    `;

    container.appendChild(section);
  });

  renderManagerTeams();
}

// ════════════════════════════════════════════════════════════
// MANAGER TEAMS — exclusive rosters + net sales
// ════════════════════════════════════════════════════════════
let mgrExpanded = new Set();
let mgrManagerBreakdowns = {};

// the 4 fixed manager teams, in display order
const FIXED_MGR_TEAMS = [
  { name: "Team Kim", is_floater: false },
  { name: "Team Macky", is_floater: false },
  { name: "Team Janus", is_floater: false },
  { name: "Floaters", is_floater: true },
];

// hardcoded team → manager. Each team is run by the admin whose name/email
// matches one of these fragments (case-insensitive). Floaters has no single
// manager (its net is split across all managers).
const TEAM_MANAGER_MATCH = {
  "Team Kim": ["kim", "kcabarse"],
  "Team Macky": ["macky", "mackey", "mackeyckey"],
  "Team Janus": ["janji", "janus", "janusmanligoy"],
};

// find the admin who manages a given team name
function resolveTeamManager(teamName, admins) {
  const frags = TEAM_MANAGER_MATCH[teamName];
  if (!frags) return null;
  return admins.find((a) => {
    const hay = ((a.name || "") + " " + (a.email || "")).toLowerCase();
    return frags.some((f) => hay.includes(f));
  }) || null;
}

$("mgr-toggle").addEventListener("click", () => {
  const detail = $("mgr-detail");
  const chevron = $("mgr-chevron");
  const open = detail.classList.contains("hidden");
  detail.classList.toggle("hidden", !open);
  chevron.classList.toggle("open", open);
  if (open) renderManagerTeams();
});

// makes sure the 4 fixed teams exist (creates any that are missing)
async function ensureFixedMgrTeams() {
  const { data: existing } = await db.from("manager_teams").select("*");
  const names = new Set((existing || []).map((t) => t.name));
  const missing = FIXED_MGR_TEAMS.filter((t) => !names.has(t.name));
  if (missing.length) {
    await db.from("manager_teams").insert(missing);
  }
}

async function renderManagerTeams() {
  const container = $("mgr-teams-container");
  if (!container) return;

  await ensureFixedMgrTeams();

  const { first, last } = monthRange(teamMonth);
  const [
    { data: mgrTeamsRaw, error: tErr },
    { data: assignments, error: aErr },
    { data: members, error: mErr },
  ] = await Promise.all([
    db.from("manager_teams").select("*"),
    db.from("manager_team_members").select("*"),
    db.from("profiles").select("*").order("name", { ascending: true }),
  ]);

  const sheets = await fetchAllTimesheets(first, last);

  container.innerHTML = "";
  if (tErr || aErr || mErr) {
    container.innerHTML = `<p class="hint">Failed to load manager teams.</p>`;
    return;
  }

  // order teams by the fixed list
  const orderIdx = (name) => {
    const i = FIXED_MGR_TEAMS.findIndex((t) => t.name === name);
    return i === -1 ? 99 : i;
  };
  const mgrTeams = (mgrTeamsRaw || []).slice().sort((a, b) => orderIdx(a.name) - orderIdx(b.name));

  const chatters = realMembers(members).filter((m) => !isNonChatter(m));
  const admins = realMembers(members).filter((m) => m.role === "admin");

  // net sales per chatter for the month (total + per-platform)
  const netByUser = {};
  const platByUser = {};
  (sheets || []).forEach((r) => {
    const m = chatters.find((x) => x.id === r.user_id);
    if (!m) return;
    const c = calcRow(r, m);
    netByUser[r.user_id] = (netByUser[r.user_id] || 0) + c.total;
    const p = platByUser[r.user_id] || (platByUser[r.user_id] = { of: 0, fv: 0, fansly: 0, slushy: 0 });
    p.of += c.ofNet;
    p.fv += c.fvNet;
    p.fansly += c.fanslyNet;
    p.slushy += c.slushyNet;
  });

  // which team each chatter is on
  const teamOfUser = {};
  (assignments || []).forEach((a) => { teamOfUser[a.user_id] = a.team_id; });

  mgrManagerBreakdowns = {};

  mgrTeams.forEach((team) => {
    const memberIds = (assignments || []).filter((a) => a.team_id === team.id).map((a) => a.user_id);
    const teamNet = memberIds.reduce((sum, uid) => sum + (netByUser[uid] || 0), 0);
    const teamPlat = memberIds.reduce((acc, uid) => {
      const p = platByUser[uid];
      if (p) { acc.of += p.of; acc.fv += p.fv; acc.fansly += p.fansly; acc.slushy += p.slushy; }
      return acc;
    }, { of: 0, fv: 0, fansly: 0, slushy: 0 });
    mgrManagerBreakdowns[team.id] = { ...teamPlat, total: teamNet };
    const isOpen = mgrExpanded.has(team.id);

    const section = document.createElement("section");
    section.className = "panel team-card mgr-card";
    section.dataset.mgrTeam = team.id;
    section.innerHTML = `
      <button class="team-row" data-mgr-toggle type="button">
        <span class="team-row-name">${team.name}${team.is_floater ? ` <span class="floater-badge">FLOATER</span>` : ""}</span>
        <span class="team-row-meta">${memberIds.length} chatter${memberIds.length === 1 ? "" : "s"}</span>
        <span class="team-row-summary"><strong class="mgr-net">${fmt(teamNet)}</strong> net this month</span>
        <span class="mgr-breakdown-spacer"></span>
        <span class="team-chevron${isOpen ? " open" : ""}">▾</span>
      </button>
      <button class="net-breakdown-btn mgr-breakdown-btn" type="button" data-mgr-breakdown="${team.id}" title="Platform breakdown">▦</button>
      <div class="team-detail${isOpen ? "" : " hidden"}">
        ${team.is_floater
          ? `<div class="mgr-manager-row"><span class="hint">Floaters' net is split evenly across all three managers.</span></div>`
          : `<div class="mgr-manager-row"><span class="team-target-label" style="gap:6px;">Managed by <strong style="color:var(--accent)">${(resolveTeamManager(team.name, admins) || {}).name || (resolveTeamManager(team.name, admins) || {}).email || "—"}</strong></span><span class="hint">This manager earns 1% of the team's net sales.</span></div>`}
        <p class="hint">Tick a chatter to add them to this team. Chatters already on another team aren't shown here.</p>
        <div class="member-chips">
          ${chatters
            .filter((m) => !teamOfUser[m.id] || teamOfUser[m.id] === team.id)
            .map((m) => {
              const here = teamOfUser[m.id] === team.id;
              return `
                <label class="member-chip${here ? " in-team" : ""}">
                  <input type="checkbox" class="mgr-chip-check" data-mgr-user="${m.id}" ${here ? "checked" : ""}>
                  ${m.name || m.email}
                </label>
              `;
            }).join("") || `<span class="hint">No unassigned chatters available.</span>`}
        </div>
      </div>
    `;
    container.appendChild(section);
  });
}

// manager team: expand/collapse + net breakdown popover
$("mgr-teams-container").addEventListener("click", (e) => {
  // platform breakdown popover
  const bd = e.target.closest("[data-mgr-breakdown]");
  document.querySelectorAll(".net-popover").forEach((p) => p.remove());
  if (bd) {
    e.stopPropagation();
    const b = mgrManagerBreakdowns[bd.dataset.mgrBreakdown];
    if (!b) return;
    const pop = document.createElement("div");
    pop.className = "net-popover";
    pop.innerHTML = `
      <div class="net-popover-title">Net Sales by Platform</div>
      <div class="net-popover-row"><span class="np-of">OnlyFans</span><span>${fmt(b.of)}</span></div>
      <div class="net-popover-row"><span class="np-fv">FV</span><span>${fmt(b.fv)}</span></div>
      <div class="net-popover-row"><span class="np-fansly">Fansly</span><span>${fmt(b.fansly)}</span></div>
      <div class="net-popover-row"><span class="np-slushy">Slushy</span><span>${fmt(b.slushy)}</span></div>
      <div class="net-popover-row net-popover-total"><span>Total</span><span>${fmt(b.total)}</span></div>
    `;
    document.body.appendChild(pop);
    const r = bd.getBoundingClientRect();
    let left = r.right - pop.offsetWidth;
    let top = r.bottom + 6;
    if (left < 8) left = 8;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    return;
  }

  const toggle = e.target.closest("[data-mgr-toggle]");
  if (!toggle) return;
  const card = toggle.closest("[data-mgr-team]");
  const id = card.dataset.mgrTeam;
  const detail = card.querySelector(".team-detail");
  const chevron = card.querySelector(".team-chevron");
  const open = detail.classList.contains("hidden");
  detail.classList.toggle("hidden", !open);
  chevron.classList.toggle("open", open);
  if (open) mgrExpanded.add(id); else mgrExpanded.delete(id);
});

// manager team: assign/move chatter (exclusive)
$("mgr-teams-container").addEventListener("change", async (e) => {
  const check = e.target;
  if (!check.classList.contains("mgr-chip-check")) return;
  const card = check.closest("[data-mgr-team]");
  const teamId = card.dataset.mgrTeam;
  const userId = check.dataset.mgrUser;

  if (check.checked) {
    // upsert on user_id (unique) moves them from any other team to this one
    const { error } = await db.from("manager_team_members")
      .upsert({ team_id: teamId, user_id: userId }, { onConflict: "user_id" });
    if (error) { check.checked = false; toast("Could not assign: " + error.message, true); return; }
    toast("Chatter assigned ✓");
  } else {
    const { error } = await db.from("manager_team_members")
      .delete().eq("user_id", userId).eq("team_id", teamId);
    if (error) { check.checked = true; toast("Could not remove: " + error.message, true); return; }
    toast("Chatter removed");
  }
  renderManagerTeams();
});
$("teams-container").addEventListener("input", (e) => {
  const input = e.target;
  if (!input.dataset.tfield) return;

  const section = input.closest("[data-team-id]");
  const teamId = section.dataset.teamId;
  const field = input.dataset.tfield;
  const timerKey = teamId + ":" + field;

  clearTimeout(teamFieldTimers[timerKey]);
  teamFieldTimers[timerKey] = setTimeout(async () => {
    const value = field === "daily_target" ? num(input.value) : input.value.trim();
    const { error } = await db.from("teams").update({ [field]: value }).eq("id", teamId);
    if (error) { toast("Team update failed: " + error.message, true); return; }
    toast("Team updated");
    if (field === "daily_target") renderTeamSales();
  }, 700);
});

$("teams-container").addEventListener("change", async (e) => {
  const check = e.target;
  if (!check.classList.contains("chip-check")) return;

  const section = check.closest("[data-team-id]");
  const teamId = section.dataset.teamId;
  const chipUserId = check.dataset.chipUser;

  if (check.checked) {
    const { error } = await db.from("team_members").insert({ team_id: teamId, user_id: chipUserId });
    if (error && error.code !== "23505") {
      check.checked = false;
      toast("Could not add member: " + error.message, true);
      return;
    }
  } else {
    const { error } = await db.from("team_members").delete().eq("team_id", teamId).eq("user_id", chipUserId);
    if (error) {
      check.checked = true;
      toast("Could not remove member: " + error.message, true);
      return;
    }
  }
  renderTeamSales();
});

$("teams-container").addEventListener("click", async (e) => {
  // expand / collapse
  const toggleBtn = e.target.closest("[data-toggle-team]");
  if (toggleBtn) {
    const card = toggleBtn.closest("[data-team-id]");
    const teamId = card.dataset.teamId;
    const detail = card.querySelector(".team-detail");
    const chevron = card.querySelector(".team-chevron");
    const nowOpen = detail.classList.contains("hidden");
    detail.classList.toggle("hidden", !nowOpen);
    chevron.classList.toggle("open", nowOpen);
    if (nowOpen) expandedTeams.add(teamId);
    else expandedTeams.delete(teamId);
    return;
  }

  // delete team
  const btn = e.target.closest("[data-del-team]");
  if (!btn) return;

  const section = btn.closest("[data-team-id]");
  if (!confirm("Delete this team? (Doesn't affect any timesheet data.)")) return;

  const { error } = await db.from("teams").delete().eq("id", section.dataset.teamId);
  if (error) { toast("Could not delete team: " + error.message, true); return; }
  expandedTeams.delete(section.dataset.teamId);
  toast("Team deleted");
  renderTeamSales();
});

// ════════════════════════════════════════════════════════════
// OVERTIME (chatters)
// ════════════════════════════════════════════════════════════
function otStatusPill(r) {
  if (r.status === "approved") return `<span class="status-pill submitted">Approved +${num(r.boost_pct)}%</span>`;
  if (r.status === "rejected") return `<span class="status-pill rejected">Rejected</span>`;
  return `<span class="status-pill open">Pending</span>`;
}

function otDateLabel(d) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", weekday: "short" });
}

async function renderOvertime() {
  // date input can't be in the future
  const now = new Date();
  $("ot-date").max = isoDate(now.getFullYear(), now.getMonth(), now.getDate());

  const { data: requests, error } = await db
    .from("overtime_requests")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  const list = $("ot-my-list");
  list.innerHTML = "";

  if (error) {
    list.innerHTML = `<p class="hint">Could not load requests: ${error.message}</p>`;
    return;
  }
  if (!requests || !requests.length) {
    list.innerHTML = `<p class="hint">No overtime requests yet.</p>`;
    return;
  }

  requests.forEach((r) => {
    const item = document.createElement("div");
    item.className = "invite-item";
    item.innerHTML = `
      <span><strong>${otDateLabel(r.ot_date)}</strong> · ${num(r.hours)} hour${num(r.hours) === 1 ? "" : "s"}${r.note ? ` · <span class="hint">${r.note}</span>` : ""}</span>
      ${otStatusPill(r)}
      <span class="spacer"></span>
      ${r.status === "pending" ? `<button class="btn btn-danger btn-small" data-cancel-ot="${r.id}" type="button">Cancel</button>` : ""}
    `;
    list.appendChild(item);
  });
}

$("btn-submit-ot").addEventListener("click", async () => {
  const otDate = $("ot-date").value;
  const hours = num($("ot-hours").value);
  const note = $("ot-note").value.trim();

  if (!otDate) { toast("Select the date you worked overtime.", true); return; }
  if (hours <= 0) { toast("Enter your overtime hours.", true); return; }

  const { error } = await db.from("overtime_requests").insert({
    user_id: currentUser.id,
    ot_date: otDate,
    hours,
    note: note || null,
  });
  if (error) { toast("Could not submit request: " + error.message, true); return; }

  $("ot-date").value = "";
  $("ot-hours").value = "";
  $("ot-note").value = "";
  toast("Overtime request submitted ✓");
  renderOvertime();
});

$("ot-my-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cancel-ot]");
  if (!btn) return;
  if (!confirm("Cancel this overtime request?")) return;

  const { error } = await db.from("overtime_requests").delete().eq("id", btn.dataset.cancelOt);
  if (error) { toast("Could not cancel: " + error.message, true); return; }
  toast("Request cancelled");
  renderOvertime();
});

// ════════════════════════════════════════════════════════════
// OVERTIME RQ (admin)
// ════════════════════════════════════════════════════════════
async function renderOvertimeRQ() {
  const [
    { data: requests, error: rErr },
    { data: members, error: mErr },
  ] = await Promise.all([
    db.from("overtime_requests").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("*"),
  ]);

  const pendingList = $("ot-pending-list");
  const decidedList = $("ot-decided-list");
  pendingList.innerHTML = "";
  decidedList.innerHTML = "";

  if (rErr || mErr) {
    pendingList.innerHTML = `<p class="hint">Could not load requests.</p>`;
    return;
  }
  membersCache = realMembers(members);

  const nameOf = (uid) => {
    const m = membersCache.find((x) => x.id === uid);
    return m ? (m.name || m.email) : "Unknown";
  };
  const rateOf = (uid) => {
    const m = membersCache.find((x) => x.id === uid);
    return m ? num(m.hourly_rate) : 0;
  };

  // only requests from real (non-test) members
  const realIds = new Set(membersCache.map((m) => m.id));
  const visibleReqs = (requests || []).filter((r) => realIds.has(r.user_id));

  const pending = visibleReqs.filter((r) => r.status === "pending");
  const decided = visibleReqs.filter((r) => r.status !== "pending").slice(0, 30);

  if (!pending.length) {
    pendingList.innerHTML = `<p class="hint">No pending requests.</p>`;
  }
  pending.forEach((r) => {
    const item = document.createElement("div");
    item.className = "invite-item";
    item.dataset.otId = r.id;
    item.innerHTML = `
      <span><strong>${nameOf(r.user_id)}</strong> · ${otDateLabel(r.ot_date)} · ${num(r.hours)} hr${r.note ? ` · <span class="hint">${r.note}</span>` : ""}</span>
      <span class="spacer"></span>
      <label class="team-target-label">Boost %
        <input class="cell rate ot-pct" type="number" min="0" step="5" value="50" style="width: 70px;">
      </label>
      <span class="hint ot-preview" data-rate="${rateOf(r.user_id)}" data-hours="${num(r.hours)}"></span>
      <button class="btn btn-primary btn-small" data-approve-ot="${r.id}" type="button">Approve</button>
      <button class="btn btn-danger btn-small" data-reject-ot="${r.id}" type="button">Reject</button>
    `;
    pendingList.appendChild(item);
    updateOtPreview(item);
  });

  if (!decided.length) {
    decidedList.innerHTML = `<p class="hint">No decisions yet.</p>`;
  }
  decided.forEach((r) => {
    const item = document.createElement("div");
    item.className = "invite-item";
    item.innerHTML = `
      <span><strong>${nameOf(r.user_id)}</strong> · ${otDateLabel(r.ot_date)} · ${num(r.hours)} hr${r.note ? ` · <span class="hint">${r.note}</span>` : ""}</span>
      ${otStatusPill(r)}
    `;
    decidedList.appendChild(item);
  });
}

function updateOtPreview(item) {
  const pct = num(item.querySelector(".ot-pct").value);
  const preview = item.querySelector(".ot-preview");
  const rate = num(preview.dataset.rate);
  const hours = num(preview.dataset.hours);
  const boosted = rate * (1 + pct / 100);
  preview.textContent = `→ ${fmt(boosted)}/hr × ${hours} = ${fmt(boosted * hours)}`;
}

$("ot-pending-list").addEventListener("input", (e) => {
  if (!e.target.classList.contains("ot-pct")) return;
  updateOtPreview(e.target.closest(".invite-item"));
});

$("ot-pending-list").addEventListener("click", async (e) => {
  const approveBtn = e.target.closest("[data-approve-ot]");
  if (approveBtn) {
    const item = approveBtn.closest(".invite-item");
    const pct = num(item.querySelector(".ot-pct").value);
    if (pct < 0) { toast("Boost % can't be negative.", true); return; }

    const { error } = await db.from("overtime_requests")
      .update({ status: "approved", boost_pct: pct, decided_at: new Date().toISOString() })
      .eq("id", approveBtn.dataset.approveOt);
    if (error) { toast("Could not approve: " + error.message, true); return; }
    toast(`Approved with +${pct}% boost ✓`);
    renderOvertimeRQ();
    return;
  }

  const rejectBtn = e.target.closest("[data-reject-ot]");
  if (rejectBtn) {
    if (!confirm("Reject this overtime request?")) return;
    const { error } = await db.from("overtime_requests")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", rejectBtn.dataset.rejectOt);
    if (error) { toast("Could not reject: " + error.message, true); return; }
    toast("Request rejected");
    renderOvertimeRQ();
  }
});

// ════════════════════════════════════════════════════════════
// LEAVE — shared helpers
// ════════════════════════════════════════════════════════════
const LEAVE_ALLOWANCE = 7; // days per 6-month period

// inclusive day count between two ISO dates
function leaveDays(fromIso, toIso) {
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

// which half-year a date falls in: 'YYYY-H1' (Jan–Jun) or 'YYYY-H2' (Jul–Dec)
function leavePeriodOf(iso) {
  const d = new Date(iso + "T00:00:00");
  const half = d.getMonth() <= 5 ? "H1" : "H2";
  return `${d.getFullYear()}-${half}`;
}

function leavePeriodLabel(periodKey) {
  const [yr, half] = periodKey.split("-");
  return half === "H1" ? `Jan 1 – Jun 30, ${yr}` : `Jul 1 – Dec 31, ${yr}`;
}

// days used by approved leave in a given period (handles ranges spanning the boundary)
function daysUsedInPeriod(requests, periodKey) {
  let used = 0;
  requests.filter((r) => r.status === "approved").forEach((r) => {
    let d = new Date(r.from_date + "T00:00:00");
    const end = new Date(r.to_date + "T00:00:00");
    while (d <= end) {
      const iso = isoDate(d.getFullYear(), d.getMonth(), d.getDate());
      if (leavePeriodOf(iso) === periodKey) used++;
      d = new Date(d.getTime() + 86400000);
    }
  });
  return used;
}

function leaveStatusPill(r) {
  if (r.status === "approved") return `<span class="status-pill submitted">Approved</span>`;
  if (r.status === "rejected") return `<span class="status-pill rejected">Rejected</span>`;
  if (r.status === "cancelled") return `<span class="status-pill rejected">Cancelled</span>`;
  return `<span class="status-pill open">Pending</span>`;
}

function leaveRangeLabel(r) {
  const f = otDateLabel(r.from_date);
  if (r.from_date === r.to_date) return f;
  return `${f} → ${otDateLabel(r.to_date)}`;
}

// ════════════════════════════════════════════════════════════
// REQUEST LEAVE (chatters)
// ════════════════════════════════════════════════════════════
async function renderRequestLeave() {
  const now = new Date();
  const curH1 = `${now.getFullYear()}-H1`;
  const curH2 = `${now.getFullYear()}-H2`;

  $("leave-h1-label").textContent = `Jan 1 – Jun 30, ${now.getFullYear()}`;
  $("leave-h2-label").textContent = `Jul 1 – Dec 31, ${now.getFullYear()}`;
  applyLeaveReasonRules();

  const { data: requests, error } = await db
    .from("leave_requests")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  const list = $("leave-my-list");
  list.innerHTML = "";

  if (error) {
    list.innerHTML = `<p class="hint">Could not load requests: ${error.message}</p>`;
    return;
  }

  const reqs = requests || [];
  const h1Used = daysUsedInPeriod(reqs, curH1);
  const h2Used = daysUsedInPeriod(reqs, curH2);
  $("leave-h1-left").parentElement.innerHTML = `<strong>${Math.max(0, LEAVE_ALLOWANCE - h1Used)}</strong> of ${LEAVE_ALLOWANCE} days left`;
  $("leave-h2-left").parentElement.innerHTML = `<strong>${Math.max(0, LEAVE_ALLOWANCE - h2Used)}</strong> of ${LEAVE_ALLOWANCE} days left`;

  if (!reqs.length) {
    list.innerHTML = `<p class="hint">No leave requests yet.</p>`;
    return;
  }

  reqs.forEach((r) => {
    const item = document.createElement("div");
    item.className = "invite-item";
    item.innerHTML = `
      <span><strong>${leaveRangeLabel(r)}</strong> · ${leaveDays(r.from_date, r.to_date)} day${leaveDays(r.from_date, r.to_date) === 1 ? "" : "s"} · <span class="leave-reason-tag">${r.reason}</span>${r.note ? ` · <span class="hint">${r.note}</span>` : ""}</span>
      ${leaveStatusPill(r)}
      <span class="spacer"></span>
      ${r.status === "pending" ? `<button class="btn btn-danger btn-small" data-cancel-leave="${r.id}" type="button">Cancel</button>` : ""}
    `;
    list.appendChild(item);
  });
}

// reason changes which rules apply
function applyLeaveReasonRules() {
  const reason = $("leave-reason").value;
  const now = new Date();
  const todayIso = isoDate(now.getFullYear(), now.getMonth(), now.getDate());

  if (reason === "personal") {
    // personal leave needs 7 days notice → earliest start is today + 7
    const earliest = new Date(now.getTime() + 7 * 86400000);
    const earliestIso = isoDate(earliest.getFullYear(), earliest.getMonth(), earliest.getDate());
    $("leave-from").min = earliestIso;
    $("leave-to").min = earliestIso;
    $("leave-sick-upload").style.display = "none";
    $("leave-reason-hint").textContent = "Personal leave requires at least 7 days notice.";
  } else {
    // sick leave: any date, proof upload available
    $("leave-from").min = todayIso;
    $("leave-to").min = todayIso;
    $("leave-sick-upload").style.display = "";
    $("leave-reason-hint").textContent = "You can attach a doctor's note or proof for sick leave.";
  }
}
$("leave-reason").addEventListener("change", applyLeaveReasonRules);

// live day-count preview
function updateLeaveDayCount() {
  const from = $("leave-from").value;
  const to = $("leave-to").value;
  if (from && to) {
    const days = leaveDays(from, to);
    $("leave-day-count").textContent = days > 0 ? `This request is ${days} day${days === 1 ? "" : "s"}.` : "End date must be on or after the start date.";
  } else {
    $("leave-day-count").textContent = "";
  }
}
$("leave-from").addEventListener("change", () => { $("leave-to").min = $("leave-from").value; updateLeaveDayCount(); });
$("leave-to").addEventListener("change", updateLeaveDayCount);

$("btn-submit-leave").addEventListener("click", async () => {
  const from = $("leave-from").value;
  const to = $("leave-to").value;
  const reason = $("leave-reason").value;
  const note = $("leave-note").value.trim();

  if (!from || !to) { toast("Select both start and end dates.", true); return; }
  const days = leaveDays(from, to);
  if (days <= 0) { toast("End date must be on or after the start date.", true); return; }

  // personal leave: at least 7 days notice
  if (reason === "personal") {
    const now = new Date();
    const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
    if (new Date(from + "T00:00:00") < earliest) {
      toast("Personal leave needs at least 7 days notice.", true);
      return;
    }
  }

  // sick leave: optional proof upload
  let proofPath = null;
  const fileInput = $("leave-proof");
  if (reason === "sick" && fileInput.files.length) {
    const file = fileInput.files[0];
    if (file.size > 10 * 1024 * 1024) { toast("File must be under 10MB.", true); return; }
    const ext = file.name.split(".").pop();
    const path = `${currentUser.id}/${Date.now()}.${ext}`;
    $("btn-submit-leave").disabled = true;
    const { error: upErr } = await db.storage.from("leave-proofs").upload(path, file);
    $("btn-submit-leave").disabled = false;
    if (upErr) { toast("Could not upload proof: " + upErr.message, true); return; }
    proofPath = path;
  }

  const { error } = await db.from("leave_requests").insert({
    user_id: currentUser.id,
    from_date: from,
    to_date: to,
    reason,
    note: note || null,
    proof_path: proofPath,
  });
  if (error) { toast("Could not submit request: " + error.message, true); return; }

  $("leave-from").value = "";
  $("leave-to").value = "";
  $("leave-note").value = "";
  fileInput.value = "";
  $("leave-day-count").textContent = "";
  toast("Leave request submitted ✓");
  renderRequestLeave();
});

$("leave-my-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cancel-leave]");
  if (!btn) return;
  if (!confirm("Cancel this leave request?")) return;
  const { error } = await db.from("leave_requests").delete().eq("id", btn.dataset.cancelLeave);
  if (error) { toast("Could not cancel: " + error.message, true); return; }
  toast("Request cancelled");
  renderRequestLeave();
});

// ════════════════════════════════════════════════════════════
// LEAVE RQ (admin)
// ════════════════════════════════════════════════════════════
let leaveCalMonth = startOfMonth(new Date());
let leaveAllData = [];

async function renderLeaveRQ() {
  const [
    { data: requests, error: rErr },
    { data: members, error: mErr },
  ] = await Promise.all([
    db.from("leave_requests").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("*"),
  ]);

  const pendingList = $("leave-pending-list");
  const decidedList = $("leave-decided-list");
  pendingList.innerHTML = "";
  decidedList.innerHTML = "";

  if (rErr || mErr) {
    pendingList.innerHTML = `<p class="hint">Could not load requests.</p>`;
    return;
  }
  membersCache = realMembers(members);
  const realIds = new Set(membersCache.map((m) => m.id));
  leaveAllData = (requests || []).filter((r) => realIds.has(r.user_id));

  const nameOf = (uid) => {
    const m = membersCache.find((x) => x.id === uid);
    return m ? (m.name || m.email) : "Unknown";
  };

  const pending = leaveAllData.filter((r) => r.status === "pending");
  const decided = leaveAllData.filter((r) => r.status !== "pending").slice(0, 30);

  if (!pending.length) {
    pendingList.innerHTML = `<p class="hint">No pending requests.</p>`;
  }
  pending.forEach((r) => {
    const period = leavePeriodOf(r.from_date);
    const userReqs = leaveAllData.filter((x) => x.user_id === r.user_id);
    const used = daysUsedInPeriod(userReqs, period);
    const remaining = LEAVE_ALLOWANCE - used;
    const days = leaveDays(r.from_date, r.to_date);
    const wouldExceed = days > remaining;

    const item = document.createElement("div");
    item.className = "invite-item leave-pending-item";
    item.innerHTML = `
      <div class="leave-pending-info">
        <span><strong>${nameOf(r.user_id)}</strong> · ${leaveRangeLabel(r)} · ${days} day${days === 1 ? "" : "s"} · <span class="leave-reason-tag">${r.reason}</span>${r.note ? ` · <span class="hint">${r.note}</span>` : ""}${r.proof_path ? ` · <button class="leave-proof-link" data-proof="${r.proof_path}" type="button">📎 View proof</button>` : ""}</span>
        <span class="leave-remaining ${wouldExceed ? "over" : "ok"}">
          ${remaining} of ${LEAVE_ALLOWANCE} days left this period (${leavePeriodLabel(period)})${wouldExceed ? " — this request exceeds it!" : ""}
        </span>
      </div>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-small" data-approve-leave="${r.id}" type="button">Approve</button>
      <button class="btn btn-danger btn-small" data-reject-leave="${r.id}" type="button">Reject</button>
    `;
    pendingList.appendChild(item);
  });

  if (!decided.length) {
    decidedList.innerHTML = `<p class="hint">No decisions yet.</p>`;
  }
  decided.forEach((r) => {
    const item = document.createElement("div");
    item.className = "invite-item";
    const coverHtml = r.status === "approved"
      ? `<label class="cover-wrap" title="Cover organised">
           <input type="checkbox" class="cover-check" data-cover-leave="${r.id}" ${r.cover_organised ? "checked" : ""}>
           Cover Organised
         </label>`
      : "";
    const cancelHtml = r.status === "approved"
      ? `<button class="btn btn-danger btn-small" data-cancel-leave-admin="${r.id}" type="button">Cancel</button>`
      : "";
    item.innerHTML = `
      <span><strong>${nameOf(r.user_id)}</strong> · ${leaveRangeLabel(r)} · <span class="leave-reason-tag">${r.reason}</span></span>
      ${leaveStatusPill(r)}
      <span class="spacer"></span>
      ${coverHtml}
      ${cancelHtml}
    `;
    decidedList.appendChild(item);
  });

  renderLeaveCalendar();
}

$("leave-pending-list").addEventListener("click", async (e) => {
  // view proof (signed URL)
  const proofBtn = e.target.closest("[data-proof]");
  if (proofBtn) {
    const { data, error } = await db.storage
      .from("leave-proofs")
      .createSignedUrl(proofBtn.dataset.proof, 300);
    if (error || !data) { toast("Could not open proof: " + (error ? error.message : "unknown"), true); return; }
    window.open(data.signedUrl, "_blank");
    return;
  }

  const approveBtn = e.target.closest("[data-approve-leave]");
  if (approveBtn) {
    const { error } = await db.from("leave_requests")
      .update({ status: "approved", decided_at: new Date().toISOString() })
      .eq("id", approveBtn.dataset.approveLeave);
    if (error) { toast("Could not approve: " + error.message, true); return; }
    toast("Leave approved ✓");
    renderLeaveRQ();
    return;
  }
  const rejectBtn = e.target.closest("[data-reject-leave]");
  if (rejectBtn) {
    if (!confirm("Reject this leave request?")) return;
    const { error } = await db.from("leave_requests")
      .update({ status: "rejected", decided_at: new Date().toISOString() })
      .eq("id", rejectBtn.dataset.rejectLeave);
    if (error) { toast("Could not reject: " + error.message, true); return; }
    toast("Request rejected");
    renderLeaveRQ();
  }
});

// recent decisions: cancel approved leave + toggle cover organised
$("leave-decided-list").addEventListener("click", async (e) => {
  const cancelBtn = e.target.closest("[data-cancel-leave-admin]");
  if (cancelBtn) {
    if (!confirm("Cancel this approved leave? It'll be removed from the calendar and the chatter will see it as Cancelled.")) return;
    const { error } = await db.from("leave_requests")
      .update({ status: "cancelled", seen: false, decided_at: new Date().toISOString() })
      .eq("id", cancelBtn.dataset.cancelLeaveAdmin);
    if (error) { toast("Could not cancel: " + error.message, true); return; }
    toast("Leave cancelled");
    renderLeaveRQ();
  }
});

$("leave-decided-list").addEventListener("change", async (e) => {
  const check = e.target;
  if (!check.classList.contains("cover-check")) return;
  const { error } = await db.from("leave_requests")
    .update({ cover_organised: check.checked })
    .eq("id", check.dataset.coverLeave);
  if (error) {
    check.checked = !check.checked;
    toast("Could not update cover status: " + error.message, true);
    return;
  }
  toast(check.checked ? "Marked cover organised ✓" : "Cover unmarked");
});

// ── admin: add own leave via topbar modal ──
$("btn-add-own-leave").addEventListener("click", () => {
  $("own-leave-from").value = "";
  $("own-leave-to").value = "";
  $("own-leave-note").value = "";
  $("own-leave-reason").value = "personal";
  $("add-leave-modal").classList.remove("hidden");
});
$("add-leave-close").addEventListener("click", () => $("add-leave-modal").classList.add("hidden"));
$("add-leave-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-leave-modal") $("add-leave-modal").classList.add("hidden");
});

$("btn-save-own-leave").addEventListener("click", async () => {
  const from = $("own-leave-from").value;
  const to = $("own-leave-to").value;
  const reason = $("own-leave-reason").value;
  const note = $("own-leave-note").value.trim();

  if (!from || !to) { toast("Select both dates.", true); return; }
  if (leaveDays(from, to) <= 0) { toast("End date must be on or after the start date.", true); return; }

  // admin's own leave is added directly as approved, and pre-seen (no self-notification)
  const { error } = await db.from("leave_requests").insert({
    user_id: currentUser.id,
    from_date: from,
    to_date: to,
    reason,
    note: note || null,
    status: "approved",
    seen: true,
    decided_at: new Date().toISOString(),
  });
  if (error) { toast("Could not add leave: " + error.message, true); return; }

  $("add-leave-modal").classList.add("hidden");
  toast("Leave added to calendar ✓");
  if (!$("view-leave-rq").classList.contains("hidden")) renderLeaveRQ();
});

$("leave-cal-prev").addEventListener("click", () => {
  leaveCalMonth = new Date(leaveCalMonth.getFullYear(), leaveCalMonth.getMonth() - 1, 1);
  renderLeaveCalendar();
});
$("leave-cal-next").addEventListener("click", () => {
  leaveCalMonth = new Date(leaveCalMonth.getFullYear(), leaveCalMonth.getMonth() + 1, 1);
  renderLeaveCalendar();
});

function renderLeaveCalendar() {
  $("leave-cal-label").textContent = monthLabel(leaveCalMonth);
  const cal = $("leave-calendar");
  cal.innerHTML = "";

  const year = leaveCalMonth.getFullYear();
  const monthIdx = leaveCalMonth.getMonth();
  const firstDow = new Date(year, monthIdx, 1).getDay();
  const total = daysInMonth(leaveCalMonth);

  const nameOf = (uid) => {
    const m = membersCache.find((x) => x.id === uid);
    return m ? (m.name || m.email) : "Unknown";
  };

  // build a date → [names] map from approved leave
  const byDate = {};
  leaveAllData.filter((r) => r.status === "approved").forEach((r) => {
    let d = new Date(r.from_date + "T00:00:00");
    const end = new Date(r.to_date + "T00:00:00");
    while (d <= end) {
      if (d.getFullYear() === year && d.getMonth() === monthIdx) {
        const day = d.getDate();
        (byDate[day] = byDate[day] || []).push({ name: nameOf(r.user_id), reason: r.reason });
      }
      d = new Date(d.getTime() + 86400000);
    }
  });

  ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach((d) => {
    const h = document.createElement("div");
    h.className = "cal-dow";
    h.textContent = d;
    cal.appendChild(h);
  });

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement("div");
    blank.className = "cal-cell empty";
    cal.appendChild(blank);
  }

  for (let day = 1; day <= total; day++) {
    const cell = document.createElement("div");
    cell.className = "cal-cell";
    const people = byDate[day] || [];
    cell.innerHTML = `
      <div class="cal-day-num">${day}</div>
      ${people.map((p) => `<div class="cal-leave ${p.reason}">${p.name}</div>`).join("")}
    `;
    cal.appendChild(cell);
  }
}

// ════════════════════════════════════════════════════════════
// BONUSES (admin)
// ════════════════════════════════════════════════════════════
function bonusMonthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function calcBonusTotal(b) {
  return num(b.full_script) * BONUS_RATES.full_script
    + num(b.rebuttal) * BONUS_RATES.rebuttal
    + num(b.team) * BONUS_RATES.team
    + num(b.individual) * BONUS_RATES.individual
    + num(b.extras);
}

$("bonus-month-prev").addEventListener("click", () => {
  bonusMonth = new Date(bonusMonth.getFullYear(), bonusMonth.getMonth() - 1, 1);
  renderBonuses();
});
$("bonus-month-next").addEventListener("click", () => {
  bonusMonth = new Date(bonusMonth.getFullYear(), bonusMonth.getMonth() + 1, 1);
  renderBonuses();
});

function setBonusSaveStatus(state, text) {
  const el = $("bonus-save-status");
  el.className = "save-status " + (state || "");
  el.textContent = text || "";
}

async function renderBonuses() {
  $("bonus-month-label").textContent = monthLabel(bonusMonth);
  setBonusSaveStatus("", "");
  const mKey = bonusMonthKey(bonusMonth);

  const [
    { data: members, error: memErr },
    { data: bonuses, error: bonErr },
    { data: fines, error: finErr },
  ] = await Promise.all([
    db.from("profiles").select("*").order("name", { ascending: true }),
    db.from("bonuses").select("*").eq("month", mKey),
    db.from("fines").select("*").eq("month", mKey).order("created_at", { ascending: true }),
  ]);

  const body = $("bonuses-body");
  body.innerHTML = "";

  if (memErr || bonErr || finErr) {
    body.innerHTML = `<tr><td colspan="7">Failed to load bonuses: ${(memErr || bonErr || finErr).message}</td></tr>`;
    return;
  }
  membersCache = realMembers(members);

  membersCache.filter((m) => !isNonChatter(m)).forEach((m) => {
    const b = (bonuses || []).find((x) => x.user_id === m.id) ||
      { full_script: "", rebuttal: "", team: "", individual: "", extras: "" };

    const tr = document.createElement("tr");
    tr.dataset.bonusUser = m.id;
    tr.dataset.prevBonus = JSON.stringify({
      full_script: num(b.full_script),
      rebuttal: num(b.rebuttal),
      team: num(b.team),
      individual: num(b.individual),
      extras: num(b.extras),
    });
    tr.innerHTML = `
      <td>${m.name || m.email}</td>
      <td class="col-num"><input class="cell bonus-cell" data-bfield="full_script" type="number" min="0" step="1" value="${b.full_script || ""}" placeholder="–"></td>
      <td class="col-num"><input class="cell bonus-cell" data-bfield="rebuttal" type="number" min="0" step="1" value="${b.rebuttal || ""}" placeholder="–"></td>
      <td class="col-num"><input class="cell bonus-cell" data-bfield="team" type="number" min="0" step="1" value="${b.team || ""}" placeholder="–"></td>
      <td class="col-num"><input class="cell bonus-cell" data-bfield="individual" type="number" min="0" step="1" value="${b.individual || ""}" placeholder="–"></td>
      <td class="col-num"><input class="cell bonus-cell" data-bfield="extras" type="number" min="0" step="0.01" value="${b.extras || ""}" placeholder="–"></td>
      <td class="col-num cell-total" data-bonus-total></td>
    `;
    body.appendChild(tr);
    recalcBonusRow(tr);
  });

  recalcBonusTotals();

  // ── FINES ──
  const finesBody = $("fines-body");
  finesBody.innerHTML = "";
  let finesGrand = 0;

  membersCache.filter((m) => !isNonChatter(m)).forEach((m) => {
    const memberFines = (fines || []).filter((f) => f.user_id === m.id);
    const totalFines = memberFines.reduce((sum, f) => sum + num(f.amount), 0);
    finesGrand += totalFines;

    const chipsHtml = memberFines.length
      ? memberFines.map((f) => `
          <span class="fine-chip">
            ${fmt(f.amount)}${f.reason ? " — " + f.reason : ""}
            <button class="fine-x" data-del-fine="${f.id}" type="button" title="Remove fine">✕</button>
          </span>
        `).join("")
      : `<span class="hint">No fines</span>`;

    const tr = document.createElement("tr");
    tr.dataset.fineUser = m.id;
    tr.innerHTML = `
      <td>${m.name || m.email}</td>
      <td class="fine-chips-cell">${chipsHtml}</td>
      <td class="col-num"><input class="cell rate fine-amount" type="number" min="0" step="0.01" placeholder="0.00"></td>
      <td><input class="fine-reason" type="text" placeholder="Reason (optional)"></td>
      <td><button class="btn btn-ghost btn-small" data-add-fine type="button">+ Add fine</button></td>
      <td class="col-num cell-total">${fmt(totalFines)}</td>
    `;
    finesBody.appendChild(tr);
  });

  $("fines-foot").innerHTML = `
    <tr>
      <td>ALL MEMBERS</td>
      <td></td><td></td><td></td><td></td>
      <td class="col-num cell-total">${fmt(finesGrand)}</td>
    </tr>
  `;
}

// add / remove fines
$("fines-body").addEventListener("click", async (e) => {
  const addBtn = e.target.closest("[data-add-fine]");
  if (addBtn) {
    const tr = addBtn.closest("tr");
    const fineUserId = tr.dataset.fineUser;
    const amount = num(tr.querySelector(".fine-amount").value);
    const reason = tr.querySelector(".fine-reason").value.trim();

    if (amount <= 0) { toast("Enter a fine amount.", true); return; }

    const { error } = await db.from("fines").insert({
      user_id: fineUserId,
      month: bonusMonthKey(bonusMonth),
      amount,
      reason: reason || null,
    });
    if (error) { toast("Could not add fine: " + error.message, true); return; }
    toast("Fine added");
    renderBonuses();
    return;
  }

  const delBtn = e.target.closest("[data-del-fine]");
  if (delBtn) {
    if (!confirm("Remove this fine?")) return;
    const { error } = await db.from("fines").delete().eq("id", delBtn.dataset.delFine);
    if (error) { toast("Could not remove fine: " + error.message, true); return; }
    toast("Fine removed");
    renderBonuses();
  }
});

function readBonusRow(tr) {
  const get = (field) => num(tr.querySelector(`input[data-bfield="${field}"]`).value);
  return {
    full_script: get("full_script"),
    rebuttal: get("rebuttal"),
    team: get("team"),
    individual: get("individual"),
    extras: get("extras"),
  };
}

function recalcBonusRow(tr) {
  const b = readBonusRow(tr);
  tr.querySelector("[data-bonus-total]").textContent = fmt(calcBonusTotal(b));
}

function recalcBonusTotals() {
  const body = $("bonuses-body");
  const sums = { fs: 0, reb: 0, team: 0, ind: 0, extras: 0, total: 0 };
  body.querySelectorAll("tr").forEach((tr) => {
    if (!tr.dataset.bonusUser) return;
    const b = readBonusRow(tr);
    sums.fs += b.full_script;
    sums.reb += b.rebuttal;
    sums.team += b.team;
    sums.ind += b.individual;
    sums.extras += b.extras;
    sums.total += calcBonusTotal(b);
  });
  $("bonuses-foot").innerHTML = `
    <tr>
      <td>ALL MEMBERS</td>
      <td class="col-num">${sums.fs}</td>
      <td class="col-num">${sums.reb}</td>
      <td class="col-num">${sums.team}</td>
      <td class="col-num">${sums.ind}</td>
      <td class="col-num">${fmt(sums.extras)}</td>
      <td class="col-num cell-total">${fmt(sums.total)}</td>
    </tr>
  `;
}

let bonusTimers = {};
$("bonuses-body").addEventListener("input", (e) => {
  const input = e.target;
  if (!input.classList.contains("bonus-cell")) return;

  const tr = input.closest("tr");
  recalcBonusRow(tr);
  recalcBonusTotals();

  const bonusUserId = tr.dataset.bonusUser;
  const mKey = bonusMonthKey(bonusMonth);
  setBonusSaveStatus("saving", "Saving…");

  clearTimeout(bonusTimers[bonusUserId]);
  bonusTimers[bonusUserId] = setTimeout(async () => {
    const b = readBonusRow(tr);
    const { error } = await db.from("bonuses").upsert(
      { user_id: bonusUserId, month: mKey, ...b },
      { onConflict: "user_id,month" }
    );
    if (error) {
      setBonusSaveStatus("error", "Save failed — " + error.message);
      toast("Bonus save failed: " + error.message, true);
      return;
    }
    setBonusSaveStatus("saved", "All changes saved");

    // record increases as celebration events for the chatter
    const prev = JSON.parse(tr.dataset.prevBonus || "{}");
    const events = [];
    ["full_script", "rebuttal", "team", "individual"].forEach((field) => {
      const diff = num(b[field]) - num(prev[field]);
      if (diff > 0) {
        events.push({
          user_id: bonusUserId,
          amount: diff * BONUS_RATES[field],
          label: BONUS_LABELS[field],
        });
      }
    });
    const extrasDiff = num(b.extras) - num(prev.extras);
    if (extrasDiff > 0) {
      events.push({ user_id: bonusUserId, amount: extrasDiff, label: BONUS_LABELS.extras });
    }

    tr.dataset.prevBonus = JSON.stringify(b);

    if (events.length) {
      const { error: evError } = await db.from("bonus_events").insert(events);
      if (evError) console.error("Could not record bonus events:", evError.message);
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
    { data: subs, error: subErr },
    { data: pays, error: payErr },
    { data: monthBonuses, error: bonusErr },
    { data: monthFines, error: fineErr },
    { data: monthOT, error: otErr },
  ] = await Promise.all([
    db.from("profiles").select("*").order("name", { ascending: true }),
    db.from("submissions").select("*").in("period", pKeys),
    db.from("payments").select("*").in("period", [pay15Key, pay1Key]),
    db.from("bonuses").select("*").eq("month", bonusMonthKey(payMonth)),
    db.from("fines").select("*").eq("month", bonusMonthKey(payMonth)),
    db.from("overtime_requests").select("*").eq("status", "approved").gte("ot_date", first).lte("ot_date", last),
  ]);

  // timesheets fetched separately with pagination (can exceed 1000 rows/month)
  const sheets = await fetchAllTimesheets(first, last);

  // manager teams for the Managers section (1% of team net)
  const [{ data: mgrTeams }, { data: mgrAssigns }] = await Promise.all([
    db.from("manager_teams").select("*"),
    db.from("manager_team_members").select("*"),
  ]);

  const body = $("payroll-body");
  body.innerHTML = "";

  if (memErr || subErr || payErr || bonusErr || fineErr || otErr) {
    body.innerHTML = `<tr><td colspan="12">Failed to load payroll data.</td></tr>`;
    return;
  }
  membersCache = realMembers(members);

  // per-chatter platform net for the month, then per-team, then per-manager
  const platByUser = {};
  (sheets || []).forEach((r) => {
    const cm = membersCache.find((x) => x.id === r.user_id);
    if (!cm || isNonChatter(cm)) return;
    const c = calcRow(r, cm);
    const p = platByUser[r.user_id] || (platByUser[r.user_id] = { of: 0, fv: 0, fansly: 0, slushy: 0 });
    p.of += c.ofNet; p.fv += c.fvNet; p.fansly += c.fanslyNet; p.slushy += c.slushyNet;
  });
  // manager_id → summed OWN team platform net (excludes floaters)
  const payrollAdmins = membersCache.filter((x) => x.role === "admin");
  const mgrTeamNet = {};
  const floaterNet = { of: 0, fv: 0, fansly: 0, slushy: 0 };
  (mgrTeams || []).forEach((t) => {
    if (t.is_floater) {
      (mgrAssigns || []).filter((a) => a.team_id === t.id).forEach((a) => {
        const p = platByUser[a.user_id];
        if (p) { floaterNet.of += p.of; floaterNet.fv += p.fv; floaterNet.fansly += p.fansly; floaterNet.slushy += p.slushy; }
      });
      return;
    }
    // hardcoded team → manager
    const mgr = resolveTeamManager(t.name, payrollAdmins);
    if (!mgr) return;
    const acc = mgrTeamNet[mgr.id] || (mgrTeamNet[mgr.id] = { of: 0, fv: 0, fansly: 0, slushy: 0 });
    (mgrAssigns || []).filter((a) => a.team_id === t.id).forEach((a) => {
      const p = platByUser[a.user_id];
      if (p) { acc.of += p.of; acc.fv += p.fv; acc.fansly += p.fansly; acc.slushy += p.slushy; }
    });
  });

  // make sure every team's manager has an entry (so empty teams still get floater share)
  (mgrTeams || []).forEach((t) => {
    if (t.is_floater) return;
    const mgr = resolveTeamManager(t.name, payrollAdmins);
    if (mgr && !mgrTeamNet[mgr.id]) mgrTeamNet[mgr.id] = { of: 0, fv: 0, fansly: 0, slushy: 0 };
  });

  // the floaters' net is split evenly across all managers who run a team
  const managerIdsWithTeam = Object.keys(mgrTeamNet);
  const shareCount = managerIdsWithTeam.length || 1;
  const floaterShare = {
    of: floaterNet.of / shareCount,
    fv: floaterNet.fv / shareCount,
    fansly: floaterNet.fansly / shareCount,
    slushy: floaterNet.slushy / shareCount,
  };
  managerIdsWithTeam.forEach((mid) => {
    mgrTeamNet[mid].of += floaterShare.of;
    mgrTeamNet[mid].fv += floaterShare.fv;
    mgrTeamNet[mid].fansly += floaterShare.fansly;
    mgrTeamNet[mid].slushy += floaterShare.slushy;
  });
  managerPayrollBreakdowns = {};

  const grand = { h1Hours: 0, h2Hours: 0, comm: 0, net: 0, bonus: 0, ot: 0, fines: 0, on15: 0, on1: 0, total: 0,
                  ofNet: 0, fvNet: 0, slushyNet: 0, fanslyNet: 0 };
  const ncGrand = { h1Hours: 0, h2Hours: 0, on15: 0, on1: 0, total: 0 };
  const ncBody = $("payroll-nc-body");
  ncBody.innerHTML = "";
  const mgrGrand = { h1Hours: 0, h2Hours: 0, teamNet: 0, comm: 0, on15: 0, on1: 0, total: 0 };
  const mgrBody = $("payroll-mgr-body");
  mgrBody.innerHTML = "";

  membersCache.forEach((m) => {
    if (isSuperAdmin(m)) return; // super admin is not an employee — excluded from payroll

    const rows = (sheets || []).filter((s) => s.user_id === m.id);
    let h1Hours = 0, h2Hours = 0, commMonth = 0, netMonth = 0;

    rows.forEach((r) => {
      const day = parseInt(r.entry_date.slice(8), 10);
      const calc = calcRow(r, m);
      commMonth += calc.commission;
      netMonth += calc.total;
      if (day <= 14) { h1Hours += num(r.hours); }
      else { h2Hours += num(r.hours); }
      // platform breakdown only counts for chatters (non-chatters have no sales)
      if (!isNonChatter(m)) {
        grand.ofNet += calc.ofNet;
        grand.fvNet += calc.fvNet;
        grand.slushyNet += calc.slushyNet;
        grand.fanslyNet += calc.fanslyNet;
      }
    });

    const h1Pay = h1Hours * num(m.hourly_rate);
    const h2Pay = h2Hours * num(m.hourly_rate);

    const h1Sub = (subs || []).some((s) => s.user_id === m.id && s.period === pKeys[0]);
    const h2Sub = (subs || []).some((s) => s.user_id === m.id && s.period === pKeys[1]);
    const badge = (ok, label) =>
      `<span class="sub-badge ${ok ? "ok" : ""}" title="${label}">${ok ? "✓" : "–"}</span>`;

    const paid15 = (pays || []).some((p) => p.user_id === m.id && p.period === pay15Key);
    const paid1 = (pays || []).some((p) => p.user_id === m.id && p.period === pay1Key);

    // ── MANAGERS: admins with 1% team commission ──
    if (m.role === "admin") {
      const plat = mgrTeamNet[m.id] || { of: 0, fv: 0, fansly: 0, slushy: 0 };
      const teamNet = plat.of + plat.fv + plat.fansly + plat.slushy;
      const mgrComm = teamNet * 0.01;
      managerPayrollBreakdowns[m.id] = {
        of: plat.of * 0.01, fv: plat.fv * 0.01, fansly: plat.fansly * 0.01, slushy: plat.slushy * 0.01, total: mgrComm,
      };

      let payOn15 = h1Pay;
      let payOn1 = h2Pay + mgrComm;
      if (m.fired && !paid15) { payOn15 = h1Pay + h2Pay + mgrComm; payOn1 = 0; }
      const monthTotal = payOn15 + payOn1;

      mgrGrand.h1Hours += h1Hours;
      mgrGrand.h2Hours += h2Hours;
      mgrGrand.teamNet += teamNet;
      mgrGrand.comm += mgrComm;
      mgrGrand.on15 += payOn15;
      mgrGrand.on1 += payOn1;
      mgrGrand.total += monthTotal;

      const firedBadge = m.fired ? ` <span class="fired-badge" title="Fired — full pay due next payday">FIRED</span>` : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><button class="member-link" data-view-member="${m.id}" type="button">${m.name || m.email}</button>${firedBadge}</td>
        <td>${badge(h1Sub, "1st half")} ${badge(h2Sub, "2nd half")}</td>
        <td class="col-num">${h1Hours}</td>
        <td class="col-num">${h2Hours}</td>
        <td class="col-num net-fv">${fmt(teamNet)}</td>
        <td class="col-num cell-grey">${fmt(mgrComm)} <button class="net-breakdown-btn" type="button" data-mgr-comm-breakdown="${m.id}" title="Commission by platform">▦</button></td>
        <td class="col-num cell-payout${paid15 ? " paid" : ""}">
          <div class="paid-wrap">
            <span class="pay-amount"><strong>${fmt(payOn15)}</strong></span>
            <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay15Key}" ${paid15 ? "checked" : ""}>
          </div>
        </td>
        <td class="col-num cell-payout${paid1 ? " paid" : ""}">
          <div class="paid-wrap">
            <span class="pay-amount"><strong>${fmt(payOn1)}</strong></span>
            <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay1Key}" ${paid1 ? "checked" : ""}>
          </div>
        </td>
        <td class="col-num"><strong>${fmt(monthTotal)}</strong></td>
      `;
      mgrBody.appendChild(tr);
      return;
    }

    // ── NON-CHATTERS: hourly only ──
    if (isNonChatter(m)) {
      let payOn15 = h1Pay;
      let payOn1 = h2Pay;

      // fired: full remaining pay lands on the next unpaid payday
      if (m.fired && !paid15) {
        payOn15 = h1Pay + h2Pay;
        payOn1 = 0;
      }
      const monthTotal = payOn15 + payOn1;

      ncGrand.h1Hours += h1Hours;
      ncGrand.h2Hours += h2Hours;
      ncGrand.on15 += payOn15;
      ncGrand.on1 += payOn1;
      ncGrand.total += monthTotal;

      const firedBadge = m.fired ? ` <span class="fired-badge" title="Fired — full pay due next payday">FIRED</span>` : "";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><button class="member-link" data-view-member="${m.id}" type="button">${m.name || m.email}</button>${firedBadge}</td>
        <td>${badge(h1Sub, "1st half")} ${badge(h2Sub, "2nd half")}</td>
        <td class="col-num">${h1Hours}</td>
        <td class="col-num">${h2Hours}</td>
        <td class="col-num cell-payout${paid15 ? " paid" : ""}">
          <div class="paid-wrap">
            <span class="pay-amount"><strong>${fmt(payOn15)}</strong></span>
            <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay15Key}" ${paid15 ? "checked" : ""}>
          </div>
        </td>
        <td class="col-num cell-payout${paid1 ? " paid" : ""}">
          <div class="paid-wrap">
            <span class="pay-amount"><strong>${fmt(payOn1)}</strong></span>
            <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay1Key}" ${paid1 ? "checked" : ""}>
          </div>
        </td>
        <td class="col-num"><strong>${fmt(monthTotal)}</strong></td>
      `;
      ncBody.appendChild(tr);
      return;
    }

    // ── CHATTERS: full payroll ──
    const bonusRow = (monthBonuses || []).find((b) => b.user_id === m.id);
    const bonusTotal = bonusRow ? calcBonusTotal(bonusRow) : 0;
    const fineTotal = (monthFines || [])
      .filter((f) => f.user_id === m.id)
      .reduce((sum, f) => sum + num(f.amount), 0);

    // approved overtime: hours × hourly × (1 + boost%), split by pay period date
    let ot15Pay = 0, ot1Pay = 0;
    (monthOT || []).filter((o) => o.user_id === m.id).forEach((o) => {
      const otPay = num(o.hours) * num(m.hourly_rate) * (1 + num(o.boost_pct) / 100);
      const otDay = parseInt(o.ot_date.slice(8), 10);
      if (otDay <= 14) ot15Pay += otPay;
      else ot1Pay += otPay;
    });
    const otTotal = ot15Pay + ot1Pay;

    let payOn15 = h1Pay + ot15Pay;                                          // 15th: hours 1–14 + their overtime
    let payOn1 = h2Pay + commMonth + bonusTotal + ot1Pay - fineTotal;       // 1st: hours 15–end + commission + bonuses + overtime − fines

    // fired: full remaining pay (incl. commission & bonuses) lands on the next unpaid payday
    if (m.fired && !paid15) {
      payOn15 = h1Pay + h2Pay + commMonth + bonusTotal + otTotal - fineTotal;
      payOn1 = 0;
    }
    const monthTotal = payOn15 + payOn1;

    grand.h1Hours += h1Hours;
    grand.h2Hours += h2Hours;
    grand.comm += commMonth;
    grand.net += netMonth;
    grand.bonus += bonusTotal;
    grand.ot += otTotal;
    grand.fines += fineTotal;
    grand.on15 += payOn15;
    grand.on1 += payOn1;
    grand.total += monthTotal;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="member-link" data-view-member="${m.id}" type="button">${m.name || m.email}</button>${m.fired ? ` <span class="fired-badge" title="Fired — full pay (incl. commission) due next payday">FIRED</span>` : ""}</td>
      <td>${badge(h1Sub, "1st half")} ${badge(h2Sub, "2nd half")}</td>
      <td class="col-num">${h1Hours}</td>
      <td class="col-num">${h2Hours}</td>
      <td class="col-num net-fv">${fmt(netMonth)}</td>
      <td class="col-num cell-grey">${fmt(commMonth)}</td>
      <td class="col-num cell-grey">${fmt(bonusTotal)}</td>
      <td class="col-num cell-grey">${fmt(otTotal)}</td>
      <td class="col-num cell-grey">${fineTotal > 0 ? "−" + fmt(fineTotal) : fmt(0)}</td>
      <td class="col-num cell-payout${paid15 ? " paid" : ""}">
        <div class="paid-wrap">
          <span class="pay-amount"><strong>${fmt(payOn15)}</strong></span>
          <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay15Key}" ${paid15 ? "checked" : ""}>
        </div>
      </td>
      <td class="col-num cell-payout${paid1 ? " paid" : ""}">
        <div class="paid-wrap">
          <span class="pay-amount"><strong>${fmt(payOn1)}</strong></span>
          <input type="checkbox" class="paid-check" data-pay-user="${m.id}" data-pay-period="${pay1Key}" ${paid1 ? "checked" : ""}>
        </div>
      </td>
      <td class="col-num"><strong>${fmt(monthTotal)}</strong></td>
    `;
    body.appendChild(tr);
  });

  $("payroll-foot").innerHTML = `
    <tr>
      <td>ALL CHATTERS</td>
      <td></td>
      <td class="col-num">${grand.h1Hours}</td>
      <td class="col-num">${grand.h2Hours}</td>
      <td class="col-num net-fv">${fmt(grand.net)} <button class="net-breakdown-btn" type="button" data-net-breakdown title="Platform breakdown">▦</button></td>
      <td class="col-num cell-grey">${fmt(grand.comm)}</td>
      <td class="col-num cell-grey">${fmt(grand.bonus)}</td>
      <td class="col-num cell-grey">${fmt(grand.ot)}</td>
      <td class="col-num cell-grey">${grand.fines > 0 ? "−" + fmt(grand.fines) : fmt(0)}</td>
      <td class="col-num cell-payout"><strong>${fmt(grand.on15)}</strong></td>
      <td class="col-num cell-payout"><strong>${fmt(grand.on1)}</strong></td>
      <td class="col-num"><strong>${fmt(grand.total)}</strong></td>
    </tr>
  `;

  $("payroll-nc-foot").innerHTML = `
    <tr>
      <td>ALL NON-CHATTERS</td>
      <td></td>
      <td class="col-num">${ncGrand.h1Hours}</td>
      <td class="col-num">${ncGrand.h2Hours}</td>
      <td class="col-num cell-payout"><strong>${fmt(ncGrand.on15)}</strong></td>
      <td class="col-num cell-payout"><strong>${fmt(ncGrand.on1)}</strong></td>
      <td class="col-num"><strong>${fmt(ncGrand.total)}</strong></td>
    </tr>
  `;

  $("payroll-mgr-foot").innerHTML = `
    <tr>
      <td>ALL MANAGERS</td>
      <td></td>
      <td class="col-num">${mgrGrand.h1Hours}</td>
      <td class="col-num">${mgrGrand.h2Hours}</td>
      <td class="col-num net-fv">${fmt(mgrGrand.teamNet)}</td>
      <td class="col-num cell-grey">${fmt(mgrGrand.comm)}</td>
      <td class="col-num cell-payout"><strong>${fmt(mgrGrand.on15)}</strong></td>
      <td class="col-num cell-payout"><strong>${fmt(mgrGrand.on1)}</strong></td>
      <td class="col-num"><strong>${fmt(mgrGrand.total)}</strong></td>
    </tr>
  `;

  // stash the platform breakdown for the popover
  payrollNetBreakdown = {
    of: grand.ofNet,
    fv: grand.fvNet,
    slushy: grand.slushyNet,
    fansly: grand.fanslyNet,
    total: grand.net,
  };
}

let payrollNetBreakdown = null;
let managerPayrollBreakdowns = {};

// net sales platform breakdown popover (fixed overlay so the table doesn't clip it)
$("payroll-foot").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-net-breakdown]");
  document.querySelectorAll(".net-popover").forEach((p) => p.remove());
  if (!btn || !payrollNetBreakdown) return;

  e.stopPropagation();
  const b = payrollNetBreakdown;
  const pop = document.createElement("div");
  pop.className = "net-popover";
  pop.innerHTML = `
    <div class="net-popover-title">Net Sales by Platform</div>
    <div class="net-popover-row"><span class="np-of">OnlyFans</span><span>${fmt(b.of)}</span></div>
    <div class="net-popover-row"><span class="np-fv">FV</span><span>${fmt(b.fv)}</span></div>
    <div class="net-popover-row"><span class="np-fansly">Fansly</span><span>${fmt(b.fansly)}</span></div>
    <div class="net-popover-row"><span class="np-slushy">Slushy</span><span>${fmt(b.slushy)}</span></div>
    <div class="net-popover-row net-popover-total"><span>Total</span><span>${fmt(b.total)}</span></div>
  `;
  document.body.appendChild(pop);

  // position next to the icon, kept within the viewport
  const r = btn.getBoundingClientRect();
  const popW = pop.offsetWidth;
  const popH = pop.offsetHeight;
  let left = r.right - popW;            // right-align with the icon
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + popH > window.innerHeight - 8) top = r.top - popH - 6; // flip above if no room below
  pop.style.left = left + "px";
  pop.style.top = top + "px";
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-net-breakdown]") && !e.target.closest("[data-mgr-breakdown]") && !e.target.closest("[data-mgr-comm-breakdown]") && !e.target.closest(".net-popover")) {
    document.querySelectorAll(".net-popover").forEach((p) => p.remove());
  }
});

// click a pay figure to select its text (without toggling the paid checkbox)
function handlePayAmountClick(e) {
  const amt = e.target.closest(".pay-amount");
  if (!amt) return;
  const range = document.createRange();
  range.selectNodeContents(amt);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
$("payroll-body").addEventListener("click", handlePayAmountClick);
$("payroll-nc-body").addEventListener("click", handlePayAmountClick);

// toggle paid checkboxes (both chatter and non-chatter tables)
async function handlePaidToggle(e) {
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
}
$("payroll-body").addEventListener("change", handlePaidToggle);
$("payroll-nc-body").addEventListener("change", handlePaidToggle);

// open a member's editable sheet (click again to minimize)
async function handleMemberLinkClick(e) {
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
}
$("payroll-body").addEventListener("click", handleMemberLinkClick);
$("payroll-nc-body").addEventListener("click", handleMemberLinkClick);
$("payroll-mgr-body").addEventListener("click", handlePayAmountClick);
$("payroll-mgr-body").addEventListener("change", handlePaidToggle);
$("payroll-mgr-body").addEventListener("click", handleMemberLinkClick);

// manager commission platform breakdown popover
$("payroll-mgr-body").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mgr-comm-breakdown]");
  document.querySelectorAll(".net-popover").forEach((p) => p.remove());
  if (!btn) return;
  const b = managerPayrollBreakdowns[btn.dataset.mgrCommBreakdown];
  if (!b) return;
  e.stopPropagation();
  const pop = document.createElement("div");
  pop.className = "net-popover";
  pop.innerHTML = `
    <div class="net-popover-title">Manager Comm by Platform (1%)</div>
    <div class="net-popover-row"><span class="np-of">OnlyFans</span><span>${fmt(b.of)}</span></div>
    <div class="net-popover-row"><span class="np-fv">FV</span><span>${fmt(b.fv)}</span></div>
    <div class="net-popover-row"><span class="np-fansly">Fansly</span><span>${fmt(b.fansly)}</span></div>
    <div class="net-popover-row"><span class="np-slushy">Slushy</span><span>${fmt(b.slushy)}</span></div>
    <div class="net-popover-row net-popover-total"><span>Total</span><span>${fmt(b.total)}</span></div>
  `;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  let left = r.right - pop.offsetWidth;
  let top = r.bottom + 6;
  if (left < 8) left = 8;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
  pop.style.left = left + "px";
  pop.style.top = top + "px";
});

// ── Boot ────────────────────────────────────────────────────
init();
