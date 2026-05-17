/**
 * Seed demo users + Acme Inc Demo company + memberships + tract_staff.
 *
 * Usage:
 *   node scripts/seed-demo-users.js
 *
 * Idempotent: re-running is safe.
 *
 * Prerequisite: the broken AFTER UPDATE trigger on auth.users must be GONE.
 * If you still have it, this script's user-create call will fail with
 * "Database error creating new user". See scripts/find-auth-trigger.sql.
 *
 * Output:
 *   super@demo.tract     / demo1234   Tract superadmin + Acme admin
 *   admin@acme.demo      / demo1234   Acme admin
 *   employee@acme.demo   / demo1234   Acme employee
 */
const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "backend", ".env"),
});
const { createClient } = require("@supabase/supabase-js");

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

const DEMO = [
  {
    email: "super@demo.tract",
    password: "demo1234",
    role: "admin",
    isTract: true,
  },
  {
    email: "admin@acme.demo",
    password: "demo1234",
    role: "admin",
    isTract: false,
  },
  {
    email: "employee@acme.demo",
    password: "demo1234",
    role: "employee",
    isTract: false,
  },
];

async function ensureUser({ email, password }) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (!error) return { id: data.user.id, fresh: true };

  const msg = (error.message || "").toLowerCase();
  if (msg.includes("already") || error.code === "email_exists") {
    const { data: rows, error: rpcErr } = await supabase.rpc(
      "find_user_by_email",
      { p_email: email }
    );
    if (rpcErr) throw rpcErr;
    if (!rows?.[0]?.id) {
      throw new Error(`${email} exists but find_user_by_email returned no row.`);
    }
    return { id: rows[0].id, fresh: false };
  }

  // Re-throw with extra hint for the most common case.
  const hint =
    msg.includes("database error")
      ? "\n  Hint: the AFTER UPDATE trigger on auth.users is still firing.\n        Run scripts/find-auth-trigger.sql first, then DROP the function CASCADE."
      : "";
  throw new Error(`${error.message}${hint}`);
}

(async () => {
  console.log("Seeding demo users via service-role admin API…\n");

  const ids = {};
  for (const u of DEMO) {
    try {
      const r = await ensureUser(u);
      ids[u.email] = r.id;
      console.log(`  ${r.fresh ? "✓ created" : "↻ existed"}  ${u.email}`);
    } catch (e) {
      console.error(`\n✗ ${u.email}: ${e.message}`);
      process.exit(1);
    }
  }

  const superId = ids["super@demo.tract"];

  // Company
  let companyId;
  {
    const { data: existing } = await supabase
      .from("companies")
      .select("id")
      .eq("slug", "acme-inc-demo")
      .maybeSingle();
    if (existing) {
      companyId = existing.id;
      console.log(`\n↻ Acme Inc Demo already exists`);
    } else {
      const { data, error } = await supabase
        .from("companies")
        .insert({
          name: "Acme Inc Demo",
          slug: "acme-inc-demo",
          created_by: superId,
        })
        .select("id")
        .single();
      if (error) {
        console.error("Create company:", error.message);
        process.exit(1);
      }
      companyId = data.id;
      console.log(`\n✓ created Acme Inc Demo`);
    }
  }

  // Memberships
  for (const u of DEMO) {
    const { error } = await supabase
      .from("company_members")
      .upsert(
        {
          company_id: companyId,
          user_id: ids[u.email],
          role: u.role,
          invited_by: superId,
        },
        { onConflict: "company_id,user_id" }
      );
    if (error) {
      console.error(`Member ${u.email}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log("✓ memberships set");

  // tract_staff
  const { error: tsErr } = await supabase
    .from("tract_staff")
    .upsert(
      { user_id: superId, role: "superadmin" },
      { onConflict: "user_id" }
    );
  if (tsErr) {
    console.error(`tract_staff: ${tsErr.message}`);
    process.exit(1);
  }
  console.log("✓ super@demo.tract added to tract_staff");

  console.log(
    "\n----------------------------------------\n" +
      "Done. Sign in at http://localhost:3010:\n" +
      "  super@demo.tract     / demo1234   (Tract super + Acme admin)\n" +
      "  admin@acme.demo      / demo1234   (Acme admin)\n" +
      "  employee@acme.demo   / demo1234   (Acme employee)"
  );
})();
