const usage = new Map();
let currentDay = "";
let globalCount = 0;
let activeRequests = 0;

export function publicChatGuard(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);

  if (day !== currentDay) {
    currentDay = day;
    globalCount = 0;
    usage.clear();
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const record = usage.get(ip) || {
    minuteStart: now,
    minuteCount: 0,
    dayCount: 0
  };

  if (now - record.minuteStart >= 60000) {
    record.minuteStart = now;
    record.minuteCount = 0;
  }

  if (
    record.minuteCount >= 3 ||
    record.dayCount >= 30 ||
    globalCount >= 120 ||
    activeRequests >= 2
  ) {
    res.set("Retry-After", "60");
    return res.status(429).json({
      error: "Limite temporaneo della demo raggiunto. Riprova più tardi."
    });
  }

  record.minuteCount++;
  record.dayCount++;
  globalCount++;
  usage.set(ip, record);

  activeRequests++;
  let released = false;

  const release = () => {
    if (!released) {
      released = true;
      activeRequests--;
    }
  };

  res.once("finish", release);
  res.once("close", release);

  next();
}