import BusinessSettings from '../models/BusinessSettings.model.js';

export async function isInventoryManagementEnabled(businessId) {
  if (!businessId) return false;
  const id = businessId._id || businessId;
  const settings = await BusinessSettings.findOne({ businessId: id })
    .select('inventoryManagementEnabled')
    .lean();
  return settings?.inventoryManagementEnabled === true;
}
