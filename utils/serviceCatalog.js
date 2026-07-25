/** Catalog taxonomy: fixed wash services, variable visit services, retail products. */

const CATALOG_FILTER_MAP = {
  all: 'all',
  services: 'service',
  service: 'service',
  variable: 'variable',
  'variable-services': 'variable',
  products: 'product',
  product: 'product',
};

export function normalizeCatalogTypeFilter(catalogType) {
  const key = String(catalogType || 'all').toLowerCase();
  return CATALOG_FILTER_MAP[key] || 'all';
}

export function getServiceCatalogType(service) {
  if (!service?.isVariable) return 'service';
  if (service.skipWorkProcess) return 'product';
  return 'variable';
}

export function matchesCatalogType(service, catalogType) {
  const filter = normalizeCatalogTypeFilter(catalogType);
  if (filter === 'all') return true;
  return getServiceCatalogType(service) === filter;
}

/** Mongo filter aligned with getServiceCatalogType(). */
export function buildCatalogTypeQuery(catalogType) {
  const filter = normalizeCatalogTypeFilter(catalogType);
  if (filter === 'service') {
    return {
      $or: [
        { isVariable: false },
        { isVariable: null },
        { isVariable: { $exists: false } },
      ],
    };
  }
  if (filter === 'variable') {
    return {
      isVariable: true,
      $or: [
        { skipWorkProcess: false },
        { skipWorkProcess: null },
        { skipWorkProcess: { $exists: false } },
      ],
    };
  }
  if (filter === 'product') {
    return {
      isVariable: true,
      skipWorkProcess: true,
    };
  }
  return {};
}

/**
 * Combine branch scope, catalog type, category, and search without clobbering $or clauses.
 */
export function buildServicesListQuery(baseFilter, { search, catalogType, categoryId } = {}) {
  const clauses = [{ ...baseFilter }];
  const catalog = buildCatalogTypeQuery(catalogType);
  if (Object.keys(catalog).length) clauses.push(catalog);

  if (categoryId && String(categoryId).trim() && String(categoryId).toUpperCase() !== 'ALL') {
    const cid = String(categoryId).trim();
    if (/^[a-f\d]{24}$/i.test(cid)) {
      clauses.push({ categoryId: cid });
    }
  }

  if (search && typeof search === 'string' && search.trim()) {
    const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clauses.push({
      $or: [
        { name: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
      ],
    });
  }

  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

export function shouldTrackInventory(service) {
  return !!service?.isVariable && !!service?.skipWorkProcess && service?.trackInventory !== false;
}

export function lineQuantity(raw) {
  const q = Math.floor(Number(raw) || 1);
  return q >= 1 ? q : 1;
}
