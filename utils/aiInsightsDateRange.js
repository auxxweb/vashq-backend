/**
 * Resolve AI Insights date ranges to { start, end, label } (inclusive end-of-day).
 */
export function parseAiInsightsDateRange(range, from, to) {
  const now = new Date();
  const startOfDay = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const endOfDay = (d) => {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  };
  const mondayOfWeek = (d) => {
    const x = startOfDay(d);
    const day = x.getDay();
    const diff = (day + 6) % 7;
    x.setDate(x.getDate() - diff);
    return x;
  };

  const r = String(range || 'today').toLowerCase();
  let start;
  let end;
  let label;

  switch (r) {
    case 'today':
    case 'daily':
      start = startOfDay(now);
      end = endOfDay(now);
      label = 'Today';
      break;
    case 'yesterday':
      {
        const y = new Date(now);
        y.setDate(y.getDate() - 1);
        start = startOfDay(y);
        end = endOfDay(y);
        label = 'Yesterday';
      }
      break;
    case 'this_week':
    case 'week':
    case 'weekly':
      start = mondayOfWeek(now);
      end = endOfDay(now);
      label = 'This Week';
      break;
    case 'last_week': {
      const thisMon = mondayOfWeek(now);
      const lastMon = new Date(thisMon);
      lastMon.setDate(lastMon.getDate() - 7);
      const lastSun = new Date(thisMon);
      lastSun.setDate(lastSun.getDate() - 1);
      start = startOfDay(lastMon);
      end = endOfDay(lastSun);
      label = 'Last Week';
      break;
    }
    case 'this_month':
    case 'monthly':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = endOfDay(now);
      label = 'This Month';
      break;
    case 'last_month': {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = endOfDay(new Date(now.getFullYear(), now.getMonth(), 0));
      label = 'Last Month';
      break;
    }
    case 'last_3_months':
      start = startOfDay(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()));
      end = endOfDay(now);
      label = 'Last 3 Months';
      break;
    case 'last_6_months':
      start = startOfDay(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()));
      end = endOfDay(now);
      label = 'Last 6 Months';
      break;
    case 'last_12_months':
    case 'yearly':
      start = startOfDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
      end = endOfDay(now);
      label = 'Last 12 Months';
      break;
    case 'custom':
      if (!from || !to) {
        start = startOfDay(now);
        end = endOfDay(now);
        label = 'Today';
      } else {
        start = startOfDay(new Date(from));
        end = endOfDay(new Date(to));
        label = 'Custom Range';
      }
      break;
    default:
      start = startOfDay(now);
      end = endOfDay(now);
      label = 'Today';
  }

  return { start, end, label, range: r };
}
