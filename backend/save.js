const supabase = require("./supabaseClient.js");

async function saveResult(data) {
  const scanId =
    data.scan_id != null && data.scan_id !== ""
      ? String(data.scan_id)
      : data.scanId != null && data.scanId !== ""
        ? String(data.scanId)
        : "";

  if (!scanId) {
    console.error(
      "saveResult: missing scan_id (JSON would omit it → DB NULL). Pass scan_id from /api/scan and restart `npm run api`. Keys received:",
      Object.keys(data || {})
    );
    return {
      ok: false,
      error:
        "Missing scan_id in save payload — restart the API server after updating code.",
    };
  }

  const sources = Array.isArray(data.sources) ? data.sources : [];
  const sourceCount =
    data.source_count != null && data.source_count !== ""
      ? Math.max(0, Number(data.source_count) || 0)
      : sources.length;

  const row = {
    scan_id: scanId,
    ...(data.comparison_id
      ? { comparison_id: String(data.comparison_id) }
      : {}),
    brand: data.brand,
    engine: data.engine,
    prompt: data.prompt,
    response: data.response,
    brand_mentioned: data.brand_mentioned,
    sentiment: data.sentiment,
    competitors_mentioned: data.competitors_mentioned,
    source_count: sourceCount,
    sources,
  };

  const { error } = await supabase.from("scans").insert(row);

  if (error) {
    console.error(
      "Failed to save scan:",
      error.message,
      error.details || "",
      error.hint || ""
    );
    const detail = [error.message, error.details, error.hint]
      .filter(Boolean)
      .join(" — ");
    return { ok: false, error: detail };
  }

  console.log(`Saved: ${data.engine} result for ${data.brand}`);
  return { ok: true };
}

module.exports = { saveResult };
