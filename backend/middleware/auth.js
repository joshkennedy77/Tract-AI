const supabase = require("../supabaseClient.js");

/**
 * Resolves the bearer token to a user and attaches:
 *   req.user = {
 *     id, email,
 *     company_id, company_role,   // null if the user isn't in a company yet
 *     tract_role,                  // null unless this user is in tract_staff
 *   }
 *
 * For PR-1 we pick the first company_members row for the user; a "user in
 * multiple companies" UX comes later. Tract staff who haven't been added to
 * a company will have company_id=null; gate company-scoped routes with
 * requireCompany so they get a clear 403 instead of an empty dashboard.
 */
async function requireUser(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      return res.status(401).json({ error: "Sign in required." });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Invalid or expired session." });
    }
    const userId = data.user.id;

    const [membershipRes, staffRes] = await Promise.all([
      supabase
        .from("company_members")
        .select("company_id, role")
        .eq("user_id", userId)
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("tract_staff")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    req.user = {
      id: userId,
      email: data.user.email || null,
      company_id: membershipRes.data?.company_id || null,
      company_role: membershipRes.data?.role || null,
      tract_role: staffRes.data?.role || null,
    };
    next();
  } catch (err) {
    console.error("requireUser error:", err.message || err);
    res.status(500).json({ error: "Auth check failed." });
  }
}

function requireCompany(req, res, next) {
  if (!req.user?.company_id) {
    return res.status(403).json({
      error:
        "No company yet. Ask a Tract admin or your company admin for an invite.",
    });
  }
  next();
}

function requireTractStaff(req, res, next) {
  if (!req.user?.tract_role) {
    return res.status(403).json({ error: "Tract staff only." });
  }
  next();
}

function requireCompanyAdmin(req, res, next) {
  if (!req.user?.company_id || req.user.company_role !== "admin") {
    return res.status(403).json({ error: "Company admin only." });
  }
  next();
}

module.exports = {
  requireUser,
  requireCompany,
  requireCompanyAdmin,
  requireTractStaff,
};
