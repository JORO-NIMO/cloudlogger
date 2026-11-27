// Plan catalogue: what each plan allows. Whop payment events set users.plan,
// and every limit below is enforced in src/index.js before data is written.
export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    sites: 1,
    logsPerMonth: 1000,
    retentionDays: 30
  },
  pro_monthly_5: {
    id: "pro_monthly_5",
    name: "Pro",
    sites: 10,
    logsPerMonth: 50000,
    retentionDays: 365
  }
};

// The administrator key (CLIENT_API_TOKEN) is not limited.
export const SYSTEM_PLAN = {
  id: "system_unlimited",
  name: "System",
  sites: Infinity,
  logsPerMonth: Infinity,
  retentionDays: Infinity
};

/** Unknown plan ids fall back to the free limits (fail closed). */
export function planLimits(plan) {
  if (plan === "system_unlimited") return SYSTEM_PLAN;
  return PLANS[plan] ?? PLANS.free;
}

/** Statuses that trigger a failure alert (same pattern the dashboard badges use). */
const FAILURE_PATTERN = /fail|error|denied|invalid|declin|crash|timeout/i;
export function isFailure(status) {
  return FAILURE_PATTERN.test(String(status || ""));
}

/** Current UTC month as "YYYY-MM" — the quota accounting window. */
export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}
