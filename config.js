// ============================================================
// CONFIG — Supabase project credentials
// ============================================================
const SUPABASE_URL = "https://trtadlggiueszoccuqyz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_s7TA4DlXCHaiXoJE5O4fww_HHiiG57R";

// Platform net rates (net = gross × rate)
const NET_RATES = {
  of: 0.80,
  fv: 0.80,
  slushy: 0.50,
  fansly: 0.80,
};

// Bonus rates (per count)
const BONUS_RATES = {
  full_script: 10,
  rebuttal: 3,
  team: 5,
  individual: 5,
};
