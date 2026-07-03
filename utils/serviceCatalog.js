/** Catalog taxonomy: fixed wash services, variable visit services, retail products. */

export function getServiceCatalogType(service) {
  if (!service?.isVariable) return 'service';
  if (service.skipWorkProcess) return 'product';
  return 'variable';
}

export function buildCatalogTypeQuery(catalogType) {
  const type = String(catalogType || 'all').toLowerCase();
  if (type === 'services' || type === 'service') {
    return { isVariable: { $ne: true } };
  }
  if (type === 'variable' || type === 'variable-services') {
    return { isVariable: true, skipWorkProcess: { $ne: true } };
  }
  if (type === 'products' || type === 'product') {
    return { isVariable: true, skipWorkProcess: true };
  }
  return {};
}

export function shouldTrackInventory(service) {
  return !!service?.isVariable && !!service?.skipWorkProcess && service?.trackInventory !== false;
}

export function lineQuantity(raw) {
  const q = Math.floor(Number(raw) || 1);
  return q >= 1 ? q : 1;
}
