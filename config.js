// ============================================================
// CONFIG — paste your Supabase project credentials here
// Supabase Dashboard → Project Settings → API
// ============================================================
const SUPABASE_URL = "YOUR_SUPABASE_URL";        // e.g. https://abcdefgh.supabase.co
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

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
