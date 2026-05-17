import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Surfaced in the console at boot so a missing .env doesn't fail silently.
  console.error(
    "Supabase env missing: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in frontend/.env."
  );
}

export const supabase = createClient(url || "", anonKey || "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/** Resolved bearer token for the current session, or "" if signed out. */
export async function currentAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || "";
}
