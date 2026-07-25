import {
  buildJobQualityChecklistGroups,
  normalizeServiceQualityChecklist,
  validateAndSnapshotQualityChecks,
} from '../utils/qualityChecklist.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let n = normalizeServiceQualityChecklist({
  name: '  Exterior  ',
  items: [{ label: 'No spots' }, { label: '' }, { label: 'No spots' }, { label: 'Mirrors clean' }],
});
assert(n.name === 'Exterior', 'name trim');
assert(n.items.length === 2, 'dedupe empty and duplicates');
assert(n.items[0].label === 'No spots' && n.items[1].label === 'Mirrors clean', 'labels');

const svcA = {
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Premium Wash',
  qualityChecklist: {
    name: 'Exterior QC',
    items: [{ _id: '111111111111111111111111', label: 'No spots' }, { _id: '222222222222222222222222', label: 'Dry' }],
  },
};
const svcB = {
  _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  name: 'Interior',
  qualityChecklist: {
    name: 'Cabin QC',
    items: [{ _id: '333333333333333333333333', label: 'Vacuum done' }],
  },
};
const svcC = {
  _id: 'cccccccccccccccccccccccc',
  name: 'Product',
  skipWorkProcess: true,
  qualityChecklist: { name: 'X', items: [{ _id: '444444444444444444444444', label: 'Skip me' }] },
};

const job = {
  services: [
    { serviceId: svcA._id },
    { serviceId: svcB._id, customName: 'Deep Interior' },
    { serviceId: svcC._id },
  ],
};
const byId = new Map([
  [svcA._id, svcA],
  [svcB._id, svcB],
  [svcC._id, svcC],
]);
const built = buildJobQualityChecklistGroups(job, byId);
assert(built.required === true, 'required');
assert(built.groups.length === 2, 'skip product');
assert(built.groups[0].serviceName === 'Premium Wash', 'svc A name');
assert(built.groups[1].serviceName === 'Deep Interior', 'custom name');
assert(built.groups[0].items.length === 2 && built.groups[1].items.length === 1, 'item counts');

let bad = validateAndSnapshotQualityChecks(built.groups, null);
assert(!bad.ok, 'null body fails');

bad = validateAndSnapshotQualityChecks(built.groups, [
  { serviceId: svcA._id, items: [{ itemId: '111111111111111111111111', checked: true }] },
]);
assert(!bad.ok, 'partial fails');

const ok = validateAndSnapshotQualityChecks(built.groups, [
  {
    serviceId: svcA._id,
    items: [
      { itemId: '111111111111111111111111', checked: true },
      { itemId: '222222222222222222222222', checked: true },
    ],
  },
  {
    serviceId: svcB._id,
    items: [{ itemId: '333333333333333333333333', checked: true }],
  },
]);
assert(ok.ok && ok.snapshot.length === 2, 'full pass');

const emptyJob = buildJobQualityChecklistGroups({ services: [{ serviceId: 'dddddddddddddddddddddddd' }] }, new Map());
assert(emptyJob.required === false, 'no checklist not required');

console.log('qualityChecklist tests passed');
