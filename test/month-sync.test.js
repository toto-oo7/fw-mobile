const assert = require('node:assert/strict');
const path = require('node:path');

require(path.join(__dirname, '..', 'records.js'));
const R = globalThis.FWRecords;
const todo = { id: 'task1', text: '复尺窗帘', done: false, star: 2, group: '', done_at: '' };
const state = R.normalizeState({
  todos: [{ ...todo, start_date: '2026-11-14', end_date: '2026-11-16',
    extra_ranges: [{ start: '2026-11-23', end: '2026-11-25' }] }],
  cal: { '2026-11-14': [{ id: 'event1', text: '内部会议', done: false, kind: 'meeting' }] }
});
const records = R.recordsFromState(state);
assert.equal(records['todo:task1'].start_date, '2026-11-14');
assert.equal(records['todo:task1'].end_date, '2026-11-16');
assert.deepEqual(records['todo:task1'].extra_ranges, [{ start: '2026-11-23', end: '2026-11-25' }]);
assert.equal(records['cal:2026-11-14'][0].kind, 'meeting');
const roundtrip = R.applyRecordsToState(R.emptyState(), Object.fromEntries(Object.entries(records).map(([k, d]) => [k, { d, t: '2026-11-04T00:00:00+08:00' }])));
assert.deepEqual(roundtrip.todos[0], state.todos[0]);
assert.deepEqual(roundtrip.cal, state.cal);

const oldRecord = { text: todo.text, done: todo.done, star: todo.star, group: todo.group, done_at: todo.done_at };
const fromOld = R.applyRecordsToState(state, {
  'todo:task1': { d: oldRecord, t: '2026-11-04T00:00:00+08:00' },
  'order:todos': { d: ['task1'], t: '2026-11-04T00:00:00+08:00' }
});
assert.equal(fromOld.todos[0].start_date, '2026-11-14');
assert.equal(fromOld.todos[0].end_date, '2026-11-16');
assert.deepEqual(fromOld.todos[0].extra_ranges, state.todos[0].extra_ranges);
const oldCalendar = R.applyRecordsToState(state, {
  'cal:2026-11-14': { d: [{ id: 'event1', text: '内部会议', done: false }], t: '2026-11-04T00:00:00+08:00' }
});
assert.equal(oldCalendar.cal['2026-11-14'][0].kind, 'meeting');

const data = new Map();
globalThis.localStorage = {
  getItem: k => data.get(k) || null,
  setItem: (k, v) => data.set(k, v)
};
globalThis.GH = { getCfg: () => ({ gist: '' }) };
const legacyCalItem = { id: 'event2', text: '现场复核', group: '', done: false };
data.set('fw.state.v1', JSON.stringify({ todos: [todo], groups: [], cal: { '2026-11-20': [legacyCalItem] } }));
data.set('fw.syncstate.v1', JSON.stringify({ gist: '', records: {
  'todo:task1': { h: R.hashOf(oldRecord), t: '2026-10-01T00:00:00+08:00' },
  'cal:2026-11-20': { h: R.hashOf([legacyCalItem]), t: '2026-10-02T00:00:00+08:00' }
} }));
require(path.join(__dirname, '..', 'store.js'));
globalThis.Store.load();
assert.equal(globalThis.Store.syncState.records['todo:task1'].h,
  R.hashOf(R.recordsFromState(globalThis.Store.state)['todo:task1']));
assert.equal(globalThis.Store.syncState.records['todo:task1'].t, '2026-10-01T00:00:00+08:00');
assert.equal(globalThis.Store.syncState.records['cal:2026-11-20'].h,
  R.hashOf(R.recordsFromState(globalThis.Store.state)['cal:2026-11-20']));
assert.equal(globalThis.Store.syncState.records['cal:2026-11-20'].t, '2026-10-02T00:00:00+08:00');
console.log('month sync: ok');
