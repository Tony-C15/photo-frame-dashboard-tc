// Minimal Mapbox Vector Tile (.pbf) reader: just enough protobuf to pull the layers we draw (server/radar.js, which
// slims each tile down to a small JSON for the weather page's map — the frame never has to parse a .pbf).
// MVT.decode(bytes, wanted) -> { layerName: { extent, features: [{ t: 1 point | 2 line | 3 polygon, p: {key: value}, g: [[x, y, x, y, …] per path] }] } }
// Only layers listed in `wanted` ({ name: [property keys to keep] }) are decoded, so the rest costs nothing.
function reader(buf, pos, end) { return { b: buf, i: pos, end: end }; }
function varint(r) {
  var x = 0, s = 0, c;
  do { c = r.b[r.i++]; x += (c & 127) * Math.pow(2, s); s += 7; } while (c & 128);
  return x;
}
function skip(r, wt) {
  if (wt === 0) varint(r); else if (wt === 1) r.i += 8; else if (wt === 2) { var n = varint(r); r.i += n; } else r.i += 4;
}
function str(r) {
  var n = varint(r), s = '', e = r.i + n, c;
  while (r.i < e) {
    c = r.b[r.i++];
    if (c < 128) s += String.fromCharCode(c);
    else if (c < 224) s += String.fromCharCode(((c & 31) << 6) | (r.b[r.i++] & 63));
    else if (c < 240) { s += String.fromCharCode(((c & 15) << 12) | ((r.b[r.i++] & 63) << 6) | (r.b[r.i++] & 63)); }
    else { var cp = ((c & 7) << 18) | ((r.b[r.i++] & 63) << 12) | ((r.b[r.i++] & 63) << 6) | (r.b[r.i++] & 63); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
  }
  return s;
}
function value(r) {
  var n = varint(r), end = r.i + n, v = null;
  while (r.i < end) {
    var k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 1) v = str(r);
    else if (f === 4 || f === 5) v = varint(r);
    else if (f === 6) { var z = varint(r); v = z % 2 ? -(z + 1) / 2 : z / 2; }
    else if (f === 7) v = !!varint(r);
    else if (f === 3) { v = new DataView(r.b.buffer, r.b.byteOffset + r.i, 8).getFloat64(0, true); r.i += 8; }
    else if (f === 2) { v = new DataView(r.b.buffer, r.b.byteOffset + r.i, 4).getFloat32(0, true); r.i += 4; }
    else skip(r, wt);
  }
  return v;
}
function feature(r, keys, vals, keep) {
  var n = varint(r), end = r.i + n, type = 0, tags = [], geo = null;
  while (r.i < end) {
    var k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 3) type = varint(r);
    else if (f === 2 || f === 4) {
      var m = varint(r), e = r.i + m, a = [];
      while (r.i < e) a.push(varint(r));
      if (f === 2) tags = a; else geo = a;
    } else skip(r, wt);
  }
  var p = {};
  for (var t = 0; t + 1 < tags.length; t += 2) if (keep.indexOf(keys[tags[t]]) >= 0) p[keys[tags[t]]] = vals[tags[t + 1]];
  return { t: type, p: p, g: path(geo || []) };
}
// geometry commands -> one flat [x, y, x, y, …] array per line / ring
function path(cmds) {
  var out = [], cur = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    var c = cmds[i++], id = c & 7, cnt = c >> 3;
    if (id === 7) { if (cur) cur.push(cur[0], cur[1]); continue; }
    for (var k = 0; k < cnt; k++) {
      var dx = cmds[i++], dy = cmds[i++];
      x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
      if (id === 1) { cur = [x, y]; out.push(cur); } else if (cur) cur.push(x, y);
    }
  }
  return out;
}
function layer(r, wanted) {
  var n = varint(r), end = r.i + n, name = '', start = r.i, extent = 4096;
  // the name comes after the features in some encoders, so find it first
  while (r.i < end) {
    var k = varint(r), f = k >> 3, wt = k & 7;
    if (f === 1) name = str(r); else skip(r, wt);
  }
  var keep = wanted[name];
  if (!keep) return null;
  var keys = [], vals = [], feats = [];
  r.i = start;
  while (r.i < end) {
    var k2 = varint(r), f2 = k2 >> 3, wt2 = k2 & 7;
    if (f2 === 3) keys.push(str(r));
    else if (f2 === 4) vals.push(value(r));
    else if (f2 === 5) extent = varint(r);
    else if (f2 === 2) { feats.push(r.i); skipLen(r); }
    else skip(r, wt2);
  }
  function skipLen(rr) { var m2 = varint(rr); rr.i += m2; }
  return { name: name, extent: extent, features: feats.map(function (at) { return feature(reader(r.b, at, end), keys, vals, keep); }) };
}
export const MVT = {
  decode(bytes, wanted) {
    var r = reader(bytes, 0, bytes.length), out = {};
    while (r.i < r.end) {
      var k = varint(r), f = k >> 3, wt = k & 7;
      if (f === 3) { var l = layer(r, wanted); if (l) out[l.name] = l; } else skip(r, wt);
    }
    return out;
  }
};

