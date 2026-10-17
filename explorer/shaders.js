/**
 * @module explorer/shaders
 *
 * The GLSL (ES 3.00, WebGL2) behind renderer-webgl.js, as strings: no build step, no files to fetch.
 * One vertex + fragment pair per pass: the grid, the data-flow lane bands, the orbital rings, the
 * edges (one program text, two passes), the arrowheads and strikes, the packets, and the nodes. Every
 * pass is ONE instanced draw, one instance per thing, whose attributes (locations 1..5) renderer-webgl.js
 * packs from the scene: a unit quad (`a_corner`, -1..1), except the edges, which are a strip made from
 * gl_VertexID.
 *
 * Space. A vertex shader works in CSS px: `centre = u_cam.xy + world * u_cam.z`, then
 * `toClip`. The camera (u_cam = x, y, zoom) and the viewport (u_viewport, CSS px) are uniforms, so
 * a pan or a zoom uploads no buffer. Fragment shaders measure in CSS px from the thing's centre
 * (`v_local`) and anti-alias from a signed distance over one DEVICE pixel (`pix = 1 / u_dpr`), so
 * an edge is crisp at any zoom and any device pixel ratio.
 *
 * Colour. Straight (non-premultiplied) rgba in, premultiplied out; the blend is
 * ONE, ONE_MINUS_SRC_ALPHA. Inside a node the layers are composited in the order Canvas 2D draws
 * them (halo disc, halo ring, glow, circle, core, mark), each at the node's alpha, so a dimmed node
 * looks the same in both renderers.
 */

const HEAD = `#version 300 es
precision highp float;
uniform vec2 u_viewport;
uniform vec3 u_cam;
uniform float u_dpr;
`;

/** A point in CSS px (origin top left) to clip space */
const TO_CLIP = `
vec4 toClip(vec2 pos) {
  return vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

/** Anti-aliasing helpers, shared by every fragment shader */
const COVER = `
out vec4 outColor;

// Coverage of one device pixel by the half plane d < 0 (d: signed distance in CSS px, pix: the pixel's size)
float coverEdge(float d, float pix) {
  return clamp(0.5 - d / pix, 0.0, 1.0);
}

// Coverage of one pixel by a band of half width hw around dist = 0 (dist >= 0: distance from the centre line)
float coverBand(float dist, float hw, float pix) {
  float hi = min(hw, dist + 0.5 * pix);
  float lo = max(-hw, dist - 0.5 * pix);
  return clamp((hi - lo) / pix, 0.0, 1.0);
}

// Coverage by a dash pattern along an arc (on / off in world units; on <= 0 or off <= 0 is solid)
float coverDash(float arc, float on, float off, float pixWorld) {
  if (on <= 0.0 || off <= 0.0) return 1.0;
  float period = on + off;
  float u = mod(arc - on * 0.5 + period * 0.5, period) - period * 0.5;
  return clamp((on * 0.5 - abs(u)) / pixWorld + 0.5, 0.0, 1.0);
}

// Straight colour at alpha a, composited over acc (premultiplied)
void over(inout vec4 acc, vec3 rgb, float a) {
  acc = vec4(rgb * a, a) + acc * (1.0 - a);
}

// What Canvas 2D's shadowBlur gives a disc of radius R at distance len from its centre: a blurred copy
// of the disc. s is the blur's sigma in CSS px (shadowBlur is in DEVICE px and sigma = blur / 2). A big
// disc has a straight-edge profile (a logistic stands in for the Gaussian's CDF); a small one is a
// Gaussian bump whose height is what the blur leaves of it.
float glowDisc(float len, float R, float s) {
  float wide = 1.0 / (1.0 + exp(clamp(1.702 * (len - R) / s, -30.0, 30.0)));
  float narrow = (1.0 - exp(-R * R / (2.0 * s * s))) * exp(-len * len / (2.0 * s * s));
  return mix(narrow, wide, smoothstep(0.5 * s, 2.5 * s, R));
}

// The normal distribution's CDF, as the same logistic (error under 0.01)
float phi(float x) {
  return 1.0 / (1.0 + exp(clamp(-1.702 * x, -30.0, 30.0)));
}
`;

// ---------------------------------------------------------------------------
//  Grid: a full-screen quad, lines every `size` world units, `width` world units wide
// ---------------------------------------------------------------------------
export const GRID_VERT = `${HEAD}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_grid;   // size, width
layout(location = 2) in vec4 a_color;
out vec2 v_pos;
flat out vec4 v_grid;
flat out vec4 v_color;
void main() {
  v_pos = vec2((a_corner.x * 0.5 + 0.5) * u_viewport.x, (0.5 - a_corner.y * 0.5) * u_viewport.y);
  v_grid = a_grid;
  v_color = a_color;
  gl_Position = vec4(a_corner, 0.0, 1.0);
}
`;

export const GRID_FRAG = `${HEAD}${COVER}
in vec2 v_pos;
flat in vec4 v_grid;
flat in vec4 v_color;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  vec2 world = (v_pos - u_cam.xy) / zoom;
  vec2 dist = abs(world - floor(world / v_grid.x + 0.5) * v_grid.x) * zoom;
  float hw = v_grid.y * zoom * 0.5;
  float cover = max(coverBand(dist.x, hw, pix), coverBand(dist.y, hw, pix));
  outColor = vec4(v_color.rgb * v_color.a, v_color.a) * cover;
}
`;

// ---------------------------------------------------------------------------
//  Lanes: rounded rectangles, fill + stroke. The quad is clipped to the viewport.
// ---------------------------------------------------------------------------
export const LANE_VERT = `${HEAD}${TO_CLIP}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;    // x, y, w, h (world)
layout(location = 2) in vec4 a_fill;
layout(location = 3) in vec4 a_stroke;
layout(location = 4) in vec2 a_style;   // corner radius, stroke width (world)
out vec2 v_local;
flat out vec2 v_half;
flat out vec2 v_style;
flat out vec4 v_fill;
flat out vec4 v_stroke;
void main() {
  float zoom = u_cam.z;
  vec2 half_ = a_rect.zw * 0.5 * zoom;
  vec2 centre = u_cam.xy + (a_rect.xy + a_rect.zw * 0.5) * zoom;
  vec2 ext = half_ + a_style.y * zoom * 0.5 + 2.0;
  vec2 pos = clamp(centre + a_corner * ext, vec2(0.0), u_viewport);
  v_local = pos - centre;
  v_half = half_;
  v_style = a_style;
  v_fill = a_fill;
  v_stroke = a_stroke;
  gl_Position = toClip(pos);
}
`;

export const LANE_FRAG = `${HEAD}${COVER}
in vec2 v_local;
flat in vec2 v_half;
flat in vec2 v_style;
flat in vec4 v_fill;
flat in vec4 v_stroke;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float rad = min(v_style.x * zoom, min(v_half.x, v_half.y));
  vec2 q = abs(v_local) - v_half + rad;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  vec4 acc = vec4(0.0);
  over(acc, v_fill.rgb, v_fill.a * coverEdge(sd, pix));
  over(acc, v_stroke.rgb, v_stroke.a * coverBand(abs(sd), v_style.y * zoom * 0.5, pix));
  outColor = acc;
}
`;

// ---------------------------------------------------------------------------
//  Rings: dashed (or solid) circles. The quad is clipped to the viewport, so a huge ring costs
//  only the part on screen.
// ---------------------------------------------------------------------------
export const RING_VERT = `${HEAD}${TO_CLIP}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_geom;    // x, y, r, width (world)
layout(location = 2) in vec4 a_color;
layout(location = 3) in vec2 a_dash;    // on, off (world)
out vec2 v_local;
flat out vec4 v_geom;
flat out vec4 v_color;
flat out vec2 v_dash;
void main() {
  float zoom = u_cam.z;
  vec2 centre = u_cam.xy + a_geom.xy * zoom;
  float ext = (a_geom.z + a_geom.w * 0.5) * zoom + 2.0;
  vec2 pos = clamp(centre + a_corner * ext, vec2(0.0), u_viewport);
  v_local = pos - centre;
  v_geom = a_geom;
  v_color = a_color;
  v_dash = a_dash;
  gl_Position = toClip(pos);
}
`;

export const RING_FRAG = `${HEAD}${COVER}
in vec2 v_local;
flat in vec4 v_geom;
flat in vec4 v_color;
flat in vec2 v_dash;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float len = length(v_local);
  float cover = coverBand(abs(len - v_geom.z * zoom), v_geom.w * zoom * 0.5, pix);
  // Dashes run clockwise from angle 0, as Canvas 2D's arc() does
  float arc = mod(atan(v_local.y, v_local.x) + 6.2831853, 6.2831853) * v_geom.z;
  cover *= coverDash(arc, v_dash.x, v_dash.y, pix / zoom);
  outColor = vec4(v_color.rgb * v_color.a, v_color.a) * cover;
}
`;

// ---------------------------------------------------------------------------
//  Nodes: the circle, the white core, the glow, the halo and the mark, from one signed distance
// ---------------------------------------------------------------------------
export const NODE_VERT = `${HEAD}${TO_CLIP}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_geom;    // x, y, r (world), alpha
layout(location = 2) in vec4 a_color;   // r, g, b (0..1), glow (px)
layout(location = 3) in vec3 a_kind;    // halo code, mark code, colour alpha
uniform vec4 u_haloGeom[4];             // fillR, ringR, ringWidth (world)
uniform vec4 u_markGeom[5];             // per mark code: ringR, ringWidth (world), dash on, dash off
uniform vec3 u_markMin;                 // MARK_MIN_PX, in screen px: ring thickness, edge thickness, gap from the node
out vec2 v_local;
flat out vec4 v_geom;
flat out vec4 v_color;
flat out vec3 v_kind;
void main() {
  float zoom = u_cam.z;
  int halo = int(a_kind.x + 0.5);
  int mark = int(a_kind.y + 0.5);
  // The quad reaches as far as the farthest thing drawn: the glow (3 sigma), the halo ring, the mark ring
  float pad = a_color.w * 1.5 / u_dpr;
  if (halo > 0) pad = max(pad, (u_haloGeom[halo].y + u_haloGeom[halo].z * 0.5) * zoom);
  if (mark > 0) pad = max(pad, max(u_markGeom[mark].x * zoom, u_markMin.z) + max(u_markGeom[mark].y * zoom, u_markMin.x) + 1.5);
  float ext = a_geom.z * zoom + pad + 2.0;
  vec2 centre = u_cam.xy + a_geom.xy * zoom;
  v_local = a_corner * ext;
  v_geom = a_geom;
  v_color = a_color;
  v_kind = a_kind;
  gl_Position = toClip(centre + v_local);
}
`;

export const NODE_FRAG = `${HEAD}${COVER}
in vec2 v_local;
flat in vec4 v_geom;
flat in vec4 v_color;
flat in vec3 v_kind;
uniform vec4 u_haloFill[4];
uniform vec4 u_haloRing[4];
uniform vec4 u_haloGeom[4];
uniform vec4 u_markColor[5];
uniform vec4 u_markGeom[5];
uniform vec3 u_markMin;
uniform vec4 u_core;
uniform float u_coreRatio;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float rw = v_geom.z;
  float R = rw * zoom;
  float al = v_geom.w;
  float len = length(v_local);
  vec4 acc = vec4(0.0);

  // Halo: a translucent disc, then a ring
  int halo = int(v_kind.x + 0.5);
  if (halo > 0) {
    vec4 fill = u_haloFill[halo];
    if (fill.a > 0.0) over(acc, fill.rgb, fill.a * al * coverEdge(len - (rw + u_haloGeom[halo].x) * zoom, pix));
    vec4 ring = u_haloRing[halo];
    over(acc, ring.rgb, ring.a * al * coverBand(abs(len - (rw + u_haloGeom[halo].y) * zoom), u_haloGeom[halo].z * zoom * 0.5, pix));
  }

  // Glow: a blurred copy of the disc under it (see glowDisc)
  float glow = v_color.w;
  if (glow > 0.0) over(acc, v_color.rgb, v_kind.z * al * glowDisc(len, R, glow * 0.5 / u_dpr));

  // The circle and its white core
  over(acc, v_color.rgb, v_kind.z * al * coverEdge(len - R, pix));
  over(acc, u_core.rgb, u_core.a * al * coverEdge(len - R * u_coreRatio, pix));

  // Mark: a ring with the look of its own mark (dashed when its dash is set: added), and for removed a
  // strike through the node. However far out the camera is, the ring stays u_markMin.z px from the node
  // and u_markMin.x px thick (scene.js MARK_MIN_PX; renderer-canvas2d.js drawNode does the same).
  int mark = int(v_kind.y + 0.5);
  if (mark > 0) {
    vec4 mc = u_markColor[mark];
    vec4 mg = u_markGeom[mark];
    float ringW = rw + max(mg.x, u_markMin.z / zoom);
    float rr = ringW * zoom;
    float wpx = max(mg.y * zoom, u_markMin.x);
    float cover = coverBand(abs(len - rr), wpx * 0.5, pix);
    if (mg.z > 0.0 && mg.w > 0.0 && len > 0.5) {
      // a whole number of dashes round the ring, so the pattern closes
      float circ = 6.2831853 * ringW;
      float n = max(floor(circ / (mg.z + mg.w) + 0.5), 1.0);
      float period = circ / n;
      float on = period * mg.z / (mg.z + mg.w);
      float arc = mod(atan(v_local.y, v_local.x) + 6.2831853, 6.2831853) * ringW;
      cover *= coverDash(arc, on, period - on, pix / zoom);
    }
    if (mark == 3) cover = max(cover, coverBand(abs(v_local.y), wpx * 0.5, pix) * coverEdge(abs(v_local.x) - rr, pix));
    over(acc, mc.rgb, mc.a * al * cover);
  }

  outColor = acc;
}
`;

// ---------------------------------------------------------------------------
//  Edges (TOPO-04): a straight edge and a curved one are the same quadratic Bezier, a straight one
//  with its control point at the midpoint. So ONE vertex and ONE fragment shader draw both; the
//  straight pass is built with SEGS = 1 and the curved pass with SEGS = CURVE_SEGMENTS. No
//  corner buffer: the vertex shader makes a strip from gl_VertexID, a pair of vertices (one each
//  side of the line) per step along the curve, plus a pair at each end that reaches past it so the
//  glow's fade has room.
// ---------------------------------------------------------------------------

/** How many straight steps the strip takes along a curved edge */
export const CURVE_SEGMENTS = 24;

const BEZIER = `
vec2 bez(vec2 a, vec2 c, vec2 b, float t) {
  float u = 1.0 - t;
  return u * u * a + 2.0 * u * t * c + t * t * b;
}
vec2 bezD(vec2 a, vec2 c, vec2 b, float t) {
  return 2.0 * (1.0 - t) * (c - a) + 2.0 * t * (b - c);
}
// Arc length from 0 to t, in world units (midpoint rule, 8 steps: the speed is smooth)
float bezArc(vec2 a, vec2 c, vec2 b, float t) {
  float sum = 0.0;
  for (int j = 0; j < 8; j++) sum += length(bezD(a, c, b, (float(j) + 0.5) * t / 8.0));
  return sum * t / 8.0;
}
`;

/**
 * Where a packet is at `timeSec`: scene.js packetPoint(), term for term (`fract` is its `% 1`, as time,
 * speed and phase are never negative). `ends` = x1, y1, x2, y2; `mot` = control x, y, speed (trips per
 * second), phase. tests (edges-pack.test.ts) hold a JS twin of this against packetPoint.
 */
export const PACKET_POS = `
vec2 packetPos(vec4 ends, vec4 mot, float timeSec) {
  float k = fract(timeSec * mot.z + mot.w);
  return bez(ends.xy, mot.xy, ends.zw, k);
}
`;

/** @param {number} segs 1 for straight edges, CURVE_SEGMENTS for curved ones */
export const edgeVert = (segs) => `${HEAD}${BEZIER}
#define SEGS ${segs}
layout(location = 1) in vec4 a_ends;    // x1, y1, x2, y2 (world)
layout(location = 2) in vec4 a_geom;    // control x, y (world), width (world), glow blur (px)
layout(location = 3) in vec4 a_color;   // straight rgb, alpha (the edge's alpha folded in)
layout(location = 4) in vec4 a_glow;    // glow rgb, glow strength (colour alpha x edge alpha)
layout(location = 5) in vec2 a_dash;    // on, off (world); 0 = solid
layout(location = 6) in float a_marked; // 1 = a proposal's mark: never thinner than u_markMin.y px
uniform vec3 u_markMin;                 // MARK_MIN_PX in screen px: ring thickness, edge thickness, gap
out float v_across;                     // CSS px from the centre line, signed
out float v_arc;                        // world units along the edge from its start; below 0 and past the length on the end caps
flat out float v_len;
flat out float v_halfWidth;             // the stroke's half width in CSS px, minimum included
flat out vec4 v_geom;
flat out vec4 v_color;
flat out vec4 v_glow;
flat out vec2 v_dash;
void main() {
  float zoom = u_cam.z;
  vec2 a = a_ends.xy;
  vec2 b = a_ends.zw;
  vec2 c = a_geom.xy;
  int pair = gl_VertexID / 2;
  float side = (gl_VertexID - pair * 2 == 0) ? -1.0 : 1.0;
  float t = float(clamp(pair - 1, 0, SEGS)) / float(SEGS);
  vec2 dir = bezD(a, c, b, t);
  dir = dot(dir, dir) < 1e-9 ? vec2(1.0, 0.0) : normalize(dir);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = max(a_geom.z * zoom, a_marked * u_markMin.y) * 0.5;
  float pad = a_geom.w * 1.5 / u_dpr + 1.5;   // the glow's 3 sigma, and room to anti-alias
  float ext = pair == 0 ? -pad : (pair == SEGS + 2 ? pad : 0.0);
  vec2 pos = u_cam.xy + bez(a, c, b, t) * zoom + dir * ext + normal * side * (halfWidth + pad);
  v_across = side * (halfWidth + pad);
  v_arc = bezArc(a, c, b, t) + ext / zoom;
  v_len = bezArc(a, c, b, 1.0);
  v_halfWidth = halfWidth;
  v_geom = a_geom;
  v_color = a_color;
  v_glow = a_glow;
  v_dash = a_dash;
  gl_Position = vec4(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0, 0.0, 1.0);
}
`;

export const EDGE_FRAG = `${HEAD}${COVER}
in float v_across;
in float v_arc;
flat in float v_len;
flat in float v_halfWidth;
flat in vec4 v_geom;
flat in vec4 v_color;
flat in vec4 v_glow;
flat in vec2 v_dash;

// How much of a blurred copy of the stroke's dashes (sigma sw, world units) is under arc
float blurredDashes(float arc, float on, float off, float len, float sw) {
  float whole = phi((arc - 0.0) / sw) - phi((arc - len) / sw);
  if (on <= 0.0 || off <= 0.0) return whole;
  float period = on + off;
  float n = floor(arc / period);
  float near = 0.0;
  for (int j = -2; j <= 2; j++) {
    float lo = (n + float(j)) * period;
    float hi = min(lo + on, len);
    lo = max(lo, 0.0);
    if (hi > lo) near += phi((arc - lo) / sw) - phi((arc - hi) / sw);
  }
  // blurred wider than a few periods, the dashes are an even tint
  return mix(min(near, 1.0), whole * on / period, smoothstep(0.5, 1.5, sw / period));
}

void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float dist = abs(v_across);
  float halfWidth = v_halfWidth;
  vec4 acc = vec4(0.0);

  // Glow: Canvas 2D's shadowBlur of the stroke, dashes and all, under it (sigma = blur / 2 device px)
  if (v_geom.w > 0.0 && v_glow.a > 0.0) {
    float s = v_geom.w * 0.5 / u_dpr;
    float across = phi((halfWidth - dist) / s) + phi((halfWidth + dist) / s) - 1.0;
    float along = blurredDashes(v_arc, v_dash.x, v_dash.y, v_len, s / zoom);
    over(acc, v_glow.rgb, v_glow.a * clamp(across, 0.0, 1.0) * clamp(along, 0.0, 1.0));
  }

  // The stroke: a band, with square ends and the dash pattern in world units
  float cover = coverBand(dist, halfWidth, pix)
    * coverEdge(-v_arc * zoom, pix)
    * coverEdge((v_arc - v_len) * zoom, pix)
    * coverDash(v_arc, v_dash.x, v_dash.y, pix / zoom);
  over(acc, v_color.rgb, v_color.a * cover);
  outColor = acc;
}
`;

// ---------------------------------------------------------------------------
//  Tips: the arrowhead at the end of an edge and the strike across a removed edge. A small quad
//  at the anchor point, turned to face along the edge; both are a signed distance in a frame
//  whose x axis points the way the edge goes.
// ---------------------------------------------------------------------------
export const TIP_VERT = `${HEAD}${TO_CLIP}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_tip;     // x, y (world), direction x, y (unit)
layout(location = 2) in vec4 a_color;
layout(location = 3) in float a_kind;   // 1 = arrowhead (tip at x, y), 2 = strike (centred on x, y)
uniform vec4 u_tip;                     // arrow length, arrow spread (radians), strike half length, strike width (world)
out vec2 v_local;
flat out vec4 v_color;
flat out float v_kind;
void main() {
  float zoom = u_cam.z;
  float ext = max(u_tip.x, max(u_tip.z, u_tip.w)) * zoom + 3.0;
  vec2 dir = a_tip.zw;
  vec2 off = a_corner * ext;
  v_local = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
  v_color = a_color;
  v_kind = a_kind;
  gl_Position = toClip(u_cam.xy + a_tip.xy * zoom + off);
}
`;

export const TIP_FRAG = `${HEAD}${COVER}
in vec2 v_local;
flat in vec4 v_color;
flat in float v_kind;
uniform vec4 u_tip;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float sd;
  if (v_kind < 1.5) {
    // The triangle with its tip at the origin and two barbs L back, spread radians either side of the line
    float L = u_tip.x * zoom;
    float sn = sin(u_tip.y);
    float cs = cos(u_tip.y);
    sd = max(max(sn * v_local.x + cs * v_local.y, sn * v_local.x - cs * v_local.y), -v_local.x - L * cs);
  } else {
    // A box across the edge, at least 1.5 px thick so it stays visible zoomed out
    vec2 q = abs(v_local) - vec2(max(u_tip.w * zoom, 1.5) * 0.5, u_tip.z * zoom);
    sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  }
  outColor = vec4(v_color.rgb * v_color.a, v_color.a) * coverEdge(sd, pix);
}
`;

// ---------------------------------------------------------------------------
//  Packets: a dot on an edge, its place worked out here from the time (a uniform), so a frame of
//  moving packets uploads nothing. The dot is drawn under the nodes, as Canvas 2D does.
// ---------------------------------------------------------------------------
export const PACKET_VERT = `${HEAD}${TO_CLIP}${BEZIER}${PACKET_POS}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_ends;    // x1, y1, x2, y2 (world)
layout(location = 2) in vec4 a_mot;     // control x, y (world), speed (trips per second), phase
layout(location = 3) in vec4 a_color;   // the dot: straight rgb, alpha (edge alpha folded in)
layout(location = 4) in vec4 a_glow;    // its glow: rgb, strength
layout(location = 5) in vec2 a_size;    // radius (world), glow blur (px)
uniform float u_time;                   // seconds
out vec2 v_local;
flat out vec4 v_size;
flat out vec4 v_color;
flat out vec4 v_glow;
void main() {
  float zoom = u_cam.z;
  vec2 centre = u_cam.xy + packetPos(a_ends, a_mot, u_time) * zoom;
  v_local = a_corner * (a_size.x * zoom + a_size.y * 1.5 / u_dpr + 2.0);
  v_size = a_size.xyxy;
  v_color = a_color;
  v_glow = a_glow;
  gl_Position = toClip(centre + v_local);
}
`;

export const PACKET_FRAG = `${HEAD}${COVER}
in vec2 v_local;
flat in vec4 v_size;
flat in vec4 v_color;
flat in vec4 v_glow;
void main() {
  float zoom = u_cam.z;
  float pix = 1.0 / u_dpr;
  float len = length(v_local);
  float R = v_size.x * zoom;
  vec4 acc = vec4(0.0);
  if (v_size.y > 0.0) over(acc, v_glow.rgb, v_glow.a * glowDisc(len, R, v_size.y * 0.5 / u_dpr));
  over(acc, v_color.rgb, v_color.a * coverEdge(len - R, pix));
  outColor = acc;
}
`;
