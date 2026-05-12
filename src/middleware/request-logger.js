/**
 * Middleware de logging por request.
 * Registra: método, ruta, org, ip, status HTTP y duración.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - start;
    const org = req.body?.organization_id || "-";
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "-";
    const user = req._resolvedUserId || "-";
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} org=${org} user=${user} ip=${ip} -> ${res.statusCode} (${ms}ms)`
    );
  });

  next();
}
