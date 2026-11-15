
(function (root) {
  'use strict';

  var FILES = ['fnevents.json', 'announcements.json', 'changelog.json', 'config.json', 'archive.json'];

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (isObj(v)) { var o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = canon(v[k]); }); return o; }
    return v;
  }
  function same(a, b) { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)); }
  function keyOf(x) {
    if (!isObj(x)) return null;
    if (x.id != null && x.id !== '') return 'id:' + x.id;
    if (x.name != null && x.name !== '') return 'n:' + String(x.name).toLowerCase();
    return null;
  }
  function keysOf(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = keyOf(arr[i]);
      if (k == null || seen[k]) return null;
      seen[k] = 1; out.push(k);
    }
    return out;
  }
  function indexOfKey(arr, key) {
    for (var i = 0; i < arr.length; i++) if (keyOf(arr[i]) === key) return i;
    return -1;
  }

  /* patch format
   *   { t:'replace', v }
   *   { t:'obj',  set:{ key: patch }, del:[key] }
   *   { t:'list', ops:[ {o:'add',key,item,after} | {o:'del',key} | {o:'mod',key,p} ], order:[key] | null }
   */
  function diff(a, b) {
    if (same(a, b)) return null;
    if (isObj(a) && isObj(b)) {
      var set = {}, del = [];
      Object.keys(b).forEach(function (k) {
        if (!(k in a)) set[k] = { t: 'replace', v: clone(b[k]) };
        else { var p = diff(a[k], b[k]); if (p) set[k] = p; }
      });
      Object.keys(a).forEach(function (k) { if (!(k in b)) del.push(k); });
      return { t: 'obj', set: set, del: del };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      var ka = keysOf(a), kb = keysOf(b);
      if (ka && kb) {
        var am = {}, bm = {}, ops = [];
        a.forEach(function (x, i) { am[ka[i]] = x; });
        b.forEach(function (x, i) { bm[kb[i]] = x; });
        ka.forEach(function (k) { if (!(k in bm)) ops.push({ o: 'del', key: k }); });
        b.forEach(function (x, i) {
          var k = kb[i];
          if (!(k in am)) ops.push({ o: 'add', key: k, item: clone(x), after: i ? kb[i - 1] : null });
          else if (!same(am[k], x)) ops.push({ o: 'mod', key: k, p: diff(am[k], x) });
        });
        var oa = ka.filter(function (k) { return k in bm; }), ob = kb.filter(function (k) { return k in am; });
        return { t: 'list', ops: ops, order: JSON.stringify(oa) !== JSON.stringify(ob) ? kb.slice() : null };
      }
    }
    return { t: 'replace', v: clone(b) };
  }

  function apply(cur, p) {
    if (!p) return cur;
    if (p.t === 'replace') return clone(p.v);
    if (p.t === 'obj') {
      var o = isObj(cur) ? clone(cur) : {};
      (p.del || []).forEach(function (k) { delete o[k]; });
      Object.keys(p.set || {}).forEach(function (k) { o[k] = apply(o[k], p.set[k]); });
      return o;
    }
    if (p.t === 'list') {
      var arr = Array.isArray(cur) ? clone(cur) : [];
      (p.ops || []).forEach(function (op) {
        var idx = indexOfKey(arr, op.key);
        if (op.o === 'del') { if (idx >= 0) arr.splice(idx, 1); }
        else if (op.o === 'mod') { if (idx >= 0) arr[idx] = apply(arr[idx], op.p); }
        else if (op.o === 'add') {
          if (idx >= 0) arr[idx] = clone(op.item);
          else if (op.after == null) arr.unshift(clone(op.item));
          else {
            var at = indexOfKey(arr, op.after);
            if (at >= 0) arr.splice(at + 1, 0, clone(op.item)); else arr.push(clone(op.item));
          }
        }
      });
      if (p.order) {
        var rank = {};
        p.order.forEach(function (k, i) { rank[k] = i; });
        var listed = [], rest = [];
        arr.forEach(function (x) { (rank[keyOf(x)] != null ? listed : rest).push(x); });
        listed.sort(function (x, y) { return rank[keyOf(x)] - rank[keyOf(y)]; });
        arr = listed.concat(rest);
      }
      return arr;
    }
    return cur;
  }

  function leaves(p) {
    if (!p) return 0;
    if (p.t === 'replace') return 1;
    if (p.t === 'obj') return (p.del || []).length + Object.keys(p.set || {}).reduce(function (n, k) { return n + leaves(p.set[k]); }, 0);
    if (p.t === 'list') return (p.ops || []).length + (p.order ? 1 : 0);
    return 0;
  }
  function summarize(p) {
    var s = { add: 0, mod: 0, del: 0, other: 0 };
    if (!p) return s;
    if (p.t === 'list') { p.ops.forEach(function (o) { s[o.o]++; }); if (p.order && !p.ops.length) s.other = 1; }
    else s.other = leaves(p);
    return s;
  }
  function describe(p) {
    var s = summarize(p), bits = [];
    if (s.add) bits.push(s.add + ' added');
    if (s.mod) bits.push(s.mod + ' changed');
    if (s.del) bits.push(s.del + ' removed');
    if (s.other) bits.push(s.other + (s.other === 1 ? ' setting' : ' settings') + ' changed');
    return bits.join(', ') || 'no changes';
  }

  function ms(v) { var t = Date.parse(v); return isNaN(t) ? null : t; }

  /* Pure: given the parsed files and the current time, work out what to write. */
  function plan(files, nowMs) {
    var out = {}, log = [], labels = [];
    var sched = Array.isArray(files['scheduled.json']) ? files['scheduled.json'] : [];
    var due = sched.filter(function (e) { var t = e && ms(e.at); return t != null && t <= nowMs; }).sort(function (x, y) { return ms(x.at) - ms(y.at); });
    if (due.length) {
      due.forEach(function (e) {
        Object.keys(e.files || {}).forEach(function (name) {
          if (FILES.indexOf(name) === -1) { log.push('Skipped unknown file ' + name); return; }
          var cur = out[name] !== undefined ? out[name] : files[name];
          out[name] = apply(cur === undefined ? null : cur, e.files[name]);
        });
        log.push('Applied "' + (e.label || e.id) + '" (scheduled for ' + e.at + ')');
        labels.push(e.label || e.id);
      });
      out['scheduled.json'] = sched.filter(function (e) { return due.indexOf(e) === -1; });
    }
    var cfg = out['config.json'] !== undefined ? out['config.json'] : files['config.json'];
    var days = cfg && cfg.settings && Number(cfg.settings.archiveAfterDays);
    if (days > 0) {
      var evs = out['fnevents.json'] !== undefined ? out['fnevents.json'] : files['fnevents.json'];
      if (Array.isArray(evs)) {
        var cut = nowMs - days * 86400000, keep = [], moved = [];
        evs.forEach(function (e) {
          var end = e && ms(e.endTime);
          if (e && e.draft !== true && end != null && end < cut) moved.push(Object.assign({}, e, { archivedAt: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z') }));
          else keep.push(e);
        });
        if (moved.length) {
          var arch = out['archive.json'] !== undefined ? out['archive.json'] : files['archive.json'];
          arch = Array.isArray(arch) ? arch.slice() : [];
          var have = {};
          arch.forEach(function (x) { var k = keyOf(x); if (k) have[k] = 1; });
          moved.forEach(function (x) { if (!have[keyOf(x)]) arch.push(x); });
          out['fnevents.json'] = keep;
          out['archive.json'] = arch;
          labels.push('archived ' + moved.length + ' old event' + (moved.length === 1 ? '' : 's'));
          log.push('Archived ' + moved.length + ' event' + (moved.length === 1 ? '' : 's') + ' that ended more than ' + days + ' days ago');
        }
      }
    }
    return { out: out, log: log, labels: labels, applied: due.length };
  }

  var api = { diff: diff, apply: apply, summarize: summarize, describe: describe, plan: plan, keyOf: keyOf, FILES: FILES };
  root.FNBRWSchedule = api;

  /* ---- command line (GitHub Actions) ---- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    if (typeof require !== 'undefined' && require.main === module) {
      var fs = require('fs'), path = require('path'), os = require('os');
      var dir = process.env.DATA_DIR || 'data';
      var files = {}, bad = false;
      FILES.concat(['scheduled.json']).forEach(function (n) {
        var p = path.join(dir, n);
        if (!fs.existsSync(p)) return;
        try { files[n] = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { console.log('Cannot read ' + n + ': ' + e.message); if (n === 'scheduled.json') bad = true; }
      });
      if (bad) { console.log('scheduled.json is not valid JSON, nothing was done.'); process.exitCode = 1; }
      else {
        var res = api.plan(files, Date.now());
        var names = Object.keys(res.out);
        if (!names.length) console.log('Nothing is due.');
        names.forEach(function (n) {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, n), JSON.stringify(res.out[n], null, 2) + '\n');
        });
        res.log.forEach(function (l) { console.log(l); });
        var msg = res.labels.length ? 'Scheduled publish: ' + res.labels.join('; ') : '';
        fs.writeFileSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'fnbrw-message.txt'), msg.slice(0, 480));
      }
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);