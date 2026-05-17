/**
 * Create a Supabase Auth user via the Admin API and print the seed SQL
 * needed to make them usable in the Tract dashboard (tract_staff + a
 * starter company + company_members row).
 *
 * Usage:
 *   node scripts/create-user.js <email> <password>
 *
 * Falls back to a clear error message — much more diagnostic than the
 * generic "Database error creating new user" that Supabase Studio shows.
 */
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "backend", ".env"),
});

const { createClient } = require("@supabase/supabase-js");

const [, , emailArg, passwordArg] = process.argv;
if (!emailArg || !passwordArg) {
  console.error("Usage: node scripts/create-user.js <email> <password>");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env"
  );
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

(async () => {
  const { data, error } = await supabase.auth.admin.createUser({
    email: emailArg,
    password: passwordArg,
    email_confirm: true,
  });

  if (error) {
    console.error("\n❌ Failed to create user.");
    console.error("   message :", error.message);
    if (error.status) console.error("   status  :", error.status);
    if (error.code) console.error("   code    :", error.code);
    console.error(
      "\nIf the message blames a trigger or missing table, check\n" +
        "Supabase Studio → Database → Triggers (filter auth.users) and drop\n" +
        "any stale handle_new_user / on_auth_user_created trigger."
    );
    process.exit(1);
  }

  const id = data.user.id;
  console.log("✅ Created user");
  console.log("   id    :", id);
  console.log("   email :", data.user.email);
  console.log("\nNow paste this into Supabase SQL Editor to wire them up:");
  console.log(`
-- Tract superadmin (lets you use PR-3 / PR-4 dashboards later)
insert into public.tract_staff (user_id, role)
values ('${id}', 'superadmin');

-- A starter company + admin membership so the main dashboard works today
with c as (
  insert into public.companies (name, slug, created_by)
  values ('Tract Demo', 'tract-demo', '${id}')
  returning id
)
insert into public.company_members (company_id, user_id, role, invited_by)
select c.id, '${id}', 'admin', '${id}' from c;
`);
})();
