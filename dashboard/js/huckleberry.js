// Huckleberry client: talks to the app's Firebase backend over plain REST (no SDK, keeps the bundle
// small). Read-only. Endpoints and document layout follow https://github.com/Woyken/py-huckleberry-api
// (reverse-engineered; the Firebase key below is the public key shipped in the Huckleberry app).
// Only a refresh token is kept on the device (localStorage) — the password is never stored.
(function () {
  'use strict';
  var KEY = 'AIzaSyApGVHktXeekGyAt-G6dIeWHUkq2oXqcjg';
  var FS = 'https://firestore.googleapis.com/v1/projects/simpleintervals/databases/(default)/documents';
  var SK = 'hb.auth';
  var H = window.Huck = { skew: 0, idToken: null, expires: 0, refreshToken: null, uid: null, email: '' };

  // ------------------------------------------------------------ storage
  function save() {
    try { localStorage.setItem(SK, JSON.stringify({ r: H.refreshToken, u: H.uid, e: H.email })); } catch (e) { /* private mode */ }
  }
  (function restore() {
    try {
      var s = JSON.parse(localStorage.getItem(SK));
      if (s && s.r) { H.refreshToken = s.r; H.uid = s.u; H.email = s.e || ''; }
    } catch (e) { /* ignore */ }
  })();
  H.signedIn = function () { return !!H.refreshToken; };
  H.signOut = function () {
    H.idToken = null; H.refreshToken = null; H.uid = null; H.expires = 0;
    try { localStorage.removeItem(SK); } catch (e) { /* ignore */ }
  };

  // ------------------------------------------------------------ http
  function http(url, opts) {
    return fetch(url, opts).then(function (r) {
      var d = r.headers.get('date'); // only readable if the server exposes it; keeps the frame's wrong clock honest
      if (d && Date.parse(d)) H.skew = Date.parse(d) - Date.now();
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { /* non-JSON body */ }
        if (!r.ok) {
          var err = new Error((j && j.error && (j.error.message || j.error.status)) || 'HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }
  function post(url, body, headers) {
    var h = { 'Content-Type': 'application/json' };
    if (headers) for (var k in headers) h[k] = headers[k];
    return http(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  }

  // ------------------------------------------------------------ auth
  function setAuth(id, refresh, uid, expiresIn) {
    H.idToken = id; H.refreshToken = refresh; H.uid = uid;
    H.expires = Date.now() + (+expiresIn) * 1000;
    save();
  }
  var LOGIN_ERRORS = {
    EMAIL_NOT_FOUND: 'No Huckleberry account with that email.',
    INVALID_PASSWORD: 'Wrong email or password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    INVALID_EMAIL: 'That email address doesn’t look right.',
    USER_DISABLED: 'This account has been disabled.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts — wait a few minutes and try again.'
  };
  H.errorText = function (e) {
    if (!e) return '';
    var code = String(e.message || '').split(' ')[0];
    if (LOGIN_ERRORS[code]) return LOGIN_ERRORS[code];
    if (e.auth) return 'Session expired — sign in again.';
    if (e.name === 'TypeError') return 'Can’t reach Huckleberry. Check the frame’s Wi-Fi.';
    return 'Huckleberry error: ' + (e.message || 'unknown');
  };
  H.signIn = function (email, password) {
    return post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + KEY,
      { email: email, password: password, returnSecureToken: true }).then(function (d) {
      H.email = email;
      setAuth(d.idToken, d.refreshToken, d.localId, d.expiresIn);
    });
  };
  var refreshing = null;
  function token() {
    if (H.idToken && Date.now() < H.expires - 60000) return Promise.resolve(H.idToken);
    if (!H.refreshToken) { var e = new Error('NOT_SIGNED_IN'); e.auth = true; return Promise.reject(e); }
    if (!refreshing) {
      refreshing = post('https://securetoken.googleapis.com/v1/token?key=' + KEY,
        { grant_type: 'refresh_token', refresh_token: H.refreshToken }).then(function (d) {
        setAuth(d.id_token, d.refresh_token, d.user_id || H.uid, d.expires_in);
        refreshing = null;
        return H.idToken;
      }, function (err) {
        refreshing = null;
        if (err.status === 400 || err.status === 401) { err.auth = true; H.signOut(); }
        throw err;
      });
    }
    return refreshing;
  }

  // ------------------------------------------------------------ firestore (REST value format -> plain JS)
  function dec(v) {
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.integerValue !== undefined) return +v.integerValue;
    if (v.doubleValue !== undefined) return +v.doubleValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.timestampValue !== undefined) return Date.parse(v.timestampValue) / 1000;
    if (v.mapValue !== undefined) return obj(v.mapValue.fields);
    if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(dec);
    return null;
  }
  function obj(fields) {
    var o = {};
    for (var k in fields || {}) o[k] = dec(fields[k]);
    return o;
  }
  function api(path, body) {
    return token().then(function (t) {
      var auth = { Authorization: 'Bearer ' + t };
      return body ? post(FS + path, body, auth) : http(FS + path, { headers: auth });
    });
  }
  function get(path) {
    return api(path).then(function (d) { return obj(d.fields); }, function (e) {
      if (e.status === 404) return null;
      throw e;
    });
  }
  function query(parent, q) {
    return api('/' + parent + ':runQuery', { structuredQuery: q }).then(function (rows) {
      return rows.filter(function (r) { return r.document; }).map(function (r) { return obj(r.document.fields); });
    });
  }
  // Interval history. Entries live either as their own docs, or batched inside `multi` container docs.
  function intervals(coll, cid, since) {
    var from = [{ collectionId: 'intervals' }];
    var recent = query(coll + '/' + cid, {
      from: from,
      where: { fieldFilter: { field: { fieldPath: 'start' }, op: 'GREATER_THAN_OR_EQUAL', value: { doubleValue: since } } },
      orderBy: [{ field: { fieldPath: 'start' }, direction: 'DESCENDING' }]
    });
    var batched = query(coll + '/' + cid, {
      from: from,
      where: { fieldFilter: { field: { fieldPath: 'multi' }, op: 'EQUAL', value: { booleanValue: true } } }
    }).catch(function () { return []; });
    return Promise.all([recent, batched]).then(function (r) {
      var out = r[0].filter(function (e) { return !e.multi; });
      r[1].forEach(function (c) {
        Object.keys(c.data || {}).forEach(function (k) {
          var e = c.data[k];
          if (e && e.start >= since) out.push(e);
        });
      });
      out.sort(function (a, b) { return b.start - a.start; });
      return out;
    });
  }

  // ------------------------------------------------------------ public reads
  // Children on the account: [{ cid, name, birthdate }]
  H.children = function () {
    return get('/users/' + H.uid).then(function (u) {
      var list = (u && u.childList) || [];
      return Promise.all(list.map(function (c) {
        return get('/childs/' + c.cid).catch(function () { return null; }).then(function (doc) {
          return { cid: c.cid, name: (doc && doc.childsName) || c.nickname || 'Baby', birthdate: doc && doc.birthdate,
            // Huckleberry's own day window: the day starts at morningCutoff and night starts at nightStart
            morningCutoff: doc && doc.morningCutoff, nightStart: doc && doc.nightStart };
        });
      }));
    });
  };
  // The small "state" docs: running timers + last-event summaries. Cheap, polled often.
  H.live = function (cid) {
    var names = ['sleep', 'feed', 'diaper'];
    return Promise.all(names.map(function (n) { return get('/' + n + '/' + cid); })).then(function (r) {
      return { sleep: r[0], feed: r[1], diaper: r[2] };
    });
  };
  // When the last bath was logged (epoch seconds), or null. Baths are an "activity" (mode "bath"); the
  // activities/{cid} doc keeps a small prefs.lastBath summary, so this is one cheap read.
  H.lastBath = function (cid) {
    return get('/activities/' + cid).then(function (d) {
      var b = d && d.prefs && d.prefs.lastBath;
      if (!b || !b.start) return null;
      return b.start > 1e12 ? b.start / 1000 : b.start;
    });
  };
  // Every solids meal ever logged (small: a handful per day). Used to tell a genuinely new food from one
  // that was tried before but not within the last 30 days.
  H.solidsEver = function (cid) {
    var from = [{ collectionId: 'intervals' }];
    var single = query('feed/' + cid, { from: from, where: { fieldFilter: { field: { fieldPath: 'mode' }, op: 'EQUAL', value: { stringValue: 'solids' } } } });
    var batched = query('feed/' + cid, { from: from, where: { fieldFilter: { field: { fieldPath: 'multi' }, op: 'EQUAL', value: { booleanValue: true } } } }).catch(function () { return []; });
    return Promise.all([single, batched]).then(function (r) {
      var out = r[0].filter(function (e) { return !e.multi; });
      r[1].forEach(function (c) { Object.keys(c.data || {}).forEach(function (k) { var e = c.data[k]; if (e && e.mode === 'solids') out.push(e); }); });
      return out;
    });
  };
  // Recent events for today's totals and the 30-day foods list. Heavier, polled rarely.
  H.history = function (cid) {
    var now = Date.now() / 1000 + H.skew / 1000, day = 86400;
    return Promise.all([
      intervals('feed', cid, now - 30 * day),
      intervals('sleep', cid, now - 3 * day),
      intervals('diaper', cid, now - 3 * day)
    ]).then(function (r) { return { feed: r[0], sleep: r[1], diaper: r[2] }; });
  };

})();
