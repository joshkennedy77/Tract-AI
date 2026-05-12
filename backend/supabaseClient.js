const path = require("path");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const url = process.env.SUPABASE_URL;
/** Server-side only: service role bypasses RLS so inserts from this API succeed. Never expose in the browser. */
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(url, key, {
  realtime: {
    transport: WebSocket,
  },
});

module.exports = supabase;
