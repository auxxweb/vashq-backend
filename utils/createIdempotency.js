/**
 * Return a doc created moments ago with the same key fields.
 * Used to absorb duplicate POSTs from double-clicks / flaky clients.
 */
export async function findRecentDuplicate(Model, filter, { windowMs = 20000, lean = false } = {}) {
  const query = Model.findOne({
    ...filter,
    createdAt: { $gte: new Date(Date.now() - windowMs) }
  }).sort({ createdAt: -1 });
  return lean ? query.lean() : query;
}
