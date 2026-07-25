/**
 * Classify a job cart from catalog service documents.
 * Products = variable + skipWorkProcess; everything else requires wash workflow.
 */

export function isProductCatalogService(service) {
  return !!service?.isVariable && !!service?.skipWorkProcess;
}

/** True when any line needs bay / status workflow (wash or variable visit). */
export function cartRequiresWork(catalogServices = []) {
  return (catalogServices || []).some((s) => !isProductCatalogService(s));
}

/** True when every line is a product (direct bill / counter sale). */
export function cartIsProductsOnly(catalogServices = []) {
  const list = catalogServices || [];
  return list.length > 0 && !cartRequiresWork(list);
}

/**
 * Derive directBill from cart composition (do not trust the client).
 * Products-only → direct bill; any work item → wash job.
 */
export function resolveDirectBillFromCatalog(catalogServices = []) {
  return cartIsProductsOnly(catalogServices);
}

/** Catalog rows that contribute to ETA / quality (exclude products). */
export function workCatalogServices(catalogServices = []) {
  return (catalogServices || []).filter((s) => !isProductCatalogService(s));
}
