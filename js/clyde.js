// Starlight's lighting, ported to WebGL2 from its engine and content code:
//  RobustToolbox (ss14Starlight/RobustToolbox 5278296), Clyde.LightRendering.cs and its shaders:
//   shadow-depth.vert/.frag (polar shadow and FOV depth maps), light_shared + light-soft.swsl (point lights,
//   soft shadows, masks), fov.swsl / fov-lighting.swsl, light-blur.swsl (light.blur), wall-bleed-blur.swsl and
//   wall-merge.swsl (BlurOntoWalls / MergeWallLayer), base-default.frag (sprites times the light map)
//  Starlight content: GlobalIlluminationOverlay (gi_seed, gi_jump_flood, gi_trace, gi_copy, gi_composite),
//   LightTonemapOverlay (light_tonemap), AmbientOcclusionOverlay, ScreenPostProcessOverlay (bloom_extract,
//   screen_postprocess: night vision, bloom, vignette, film grain)
// Everything works in "world" units of the view: x right, y up, 1 = one tile.

const FOV_W = 2048, SHADOW_W = 512;
const ARBITRARY_DISTANCE_MAX = 1234;

// ---------------------------------------------------------------- shaders
const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;
const PI_DEF = `const highp float PI = 3.1415926535897932384626433;\n`;

// shadow-depth.vert / .frag (HAS_DFDX, float textures)
const DEPTH_VS = HEAD + `
in vec4 aPos;
in vec2 subVertex;
out vec3 fragControl;
uniform vec2 shadowLightCentre;
uniform float shadowOverlapSide;
${PI_DEF}
const highp float DEPTH_LEFTRIGHT_EXPAND_BIAS = 0.001;
const highp float DEPTH_ZBUFFER_PREDIV_BIAS = 1.0;
void main() {
  vec2 pA = aPos.zw - shadowLightCentre;
  vec2 pB = aPos.xy - shadowLightCentre;
  float xA = atan(pA.y, -pA.x);
  float xB = atan(pB.y, -pB.x);
  float lrSignBias = sign(xB - xA) * DEPTH_LEFTRIGHT_EXPAND_BIAS;
  xA -= lrSignBias;
  xB += lrSignBias;
  if (abs(xA - xB) >= PI) {
    if (shadowOverlapSide < 0.5) xA += sign(xB - xA) * PI * 2.0;
    else xB += sign(xA - xB) * PI * 2.0;
  }
  float targetAngle = mix(xA, xB, subVertex.x);
  vec2 lineNormal = pB - pA;
  lineNormal /= length(lineNormal);
  fragControl = vec3(targetAngle, atan(lineNormal.x, lineNormal.y), dot(vec2(lineNormal.y, -lineNormal.x), pA));
  float zbufferDepth = 1.0 - (1.0 / (length(mix(pA, pB, subVertex.x)) + DEPTH_ZBUFFER_PREDIV_BIAS));
  gl_Position = vec4(targetAngle / PI, mix(1.0, -1.0, subVertex.y), zbufferDepth, 1.0);
}`;
const DEPTH_FS = HEAD + `
in highp vec3 fragControl;
out vec4 fragColor;
void main() {
  highp float dist = abs(fragControl.z / cos(fragControl.x - fragControl.y));
  highp float dx = dFdx(dist);
  highp float dy = dFdy(dist);
  fragColor = vec4(dist, dist * dist + 0.25 * (dx * dx + dy * dy), 0.0, 1.0);
}`;

// shadow_cast_shared.swsl; the depth maps are sampled with linear filtering done here (REPEAT across x)
const SHADOW_SHARED = PI_DEF + `
vec2 depthTexel(sampler2D m, float u, float v, bool linear) {
  vec2 size = vec2(textureSize(m, 0));
  int row = clamp(int(floor(v * size.y)), 0, int(size.y) - 1);
  if (!linear) {
    int i = int(floor(fract(u) * size.x));
    return texelFetch(m, ivec2(clamp(i, 0, int(size.x) - 1), row), 0).xy;
  }
  float t = u * size.x - 0.5;
  float i0 = floor(t), f = t - i0;
  int a = int(mod(i0, size.x)), b = int(mod(i0 + 1.0, size.x));
  return mix(texelFetch(m, ivec2(a, row), 0).xy, texelFetch(m, ivec2(b, row), 0).xy, f);
}
highp vec2 occludeDepthL(highp vec2 rel, sampler2D shadowMap, highp float mapOffsetY, bool linear) {
  highp float deflect = (atan(rel.y, -rel.x) / PI);
  highp float mapOffsetX = (deflect + 1.0) / 2.0;
  return depthTexel(shadowMap, mapOffsetX, mapOffsetY, linear);
}
const highp float g_MinVariance = 0.0;
highp float ChebyshevUpperBound(highp vec2 moments, highp float t) {
  highp float p = float(t <= moments.x);
  highp float variance = moments.y - (moments.x * moments.x);
  variance = max(variance, g_MinVariance);
  highp float d = t - moments.x;
  highp float p_max = variance / (variance + d * d);
  return max(p, p_max);
}
`;

// a quad over the whole target; uv (0..1, y up) and the world position under the pixel
const QUAD_VS = HEAD + `
in vec2 aQuad;
out vec2 vUv;
out vec2 vWorld;
uniform mat3 uClipToWorld;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  vWorld = (uClipToWorld * vec3(aQuad, 1.0)).xy;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}`;

// fov-lighting.swsl (linear filtered depth) and fov.swsl (nearest), occludeColor black
const FOV_LIGHT_FS = HEAD + SHADOW_SHARED + `
in vec2 vUv; in vec2 vWorld;
out vec4 fragColor;
uniform sampler2D fovTex;
uniform vec2 eye;
void main() {
  vec2 worldSpaceDiff = vWorld - eye;
  highp float ourDist = length(worldSpaceDiff);
  highp vec2 occlDist = occludeDepthL(worldSpaceDiff, fovTex, 0.25, true);
  highp float occlusion = ChebyshevUpperBound(occlDist, ourDist);
  if (occlusion >= 1.0) discard;
  fragColor = vec4(0.0, 0.0, 0.0, 1.0 - occlusion);
}`;

// light_shared.swsl + light-soft.swsl
const LIGHT_VS = HEAD + `
in vec2 aQuad;
out vec2 worldPosition;
out vec2 UV;
uniform vec2 lightCenter;
uniform float lightRange;
uniform float maskRot;
uniform mat3 uWorldToClip;
void main() {
  vec2 local = mix(vec2(-lightRange), vec2(lightRange), aQuad);
  float c = cos(maskRot), s = sin(maskRot);
  worldPosition = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + lightCenter;
  UV = vec2(aQuad.x, 1.0 - aQuad.y);
  gl_Position = vec4((uWorldToClip * vec3(worldPosition, 1.0)).xy, 0.0, 1.0);
}`;
const LIGHT_FS = HEAD + SHADOW_SHARED + `
const highp float LIGHTING_HEIGHT = 1.0;
in vec2 worldPosition;
in vec2 UV;
out vec4 fragColor;
uniform highp vec4 lightColor;
uniform highp vec2 lightCenter;
uniform highp float lightRange;
uniform highp float lightPower;
uniform highp float lightSoftness;
uniform highp float lightFalloff;
uniform highp float lightCurveFactor;
uniform highp float lightIndex;
uniform sampler2D shadowMap;
uniform sampler2D maskTex;
highp vec2 occludeDepth(highp vec2 rel) { return occludeDepthL(rel, shadowMap, lightIndex, true); }
highp vec4 calcGaussianWeights(highp float sigma, highp vec4 offset) {
  highp vec4 eExp = offset * offset / (2.0 * sigma * sigma);
  return exp(-eExp) / (sigma * sqrt(2.0 * PI));
}
highp float createOcclusion(highp vec2 diff) {
  highp vec2 perpendicular = normalize(cross(vec3(diff, 0.0), vec3(0.0, 0.0, 1.0)).xy) * 1.0 / 32.0;
  highp float ourDist = length(diff);
  perpendicular *= lightSoftness * 1.5;
  highp vec2 sample1 = occludeDepth(diff);
  highp vec2 sample2 = occludeDepth(diff + perpendicular);
  highp vec2 sample3 = occludeDepth(diff - perpendicular);
  highp vec2 sample4 = occludeDepth(diff + perpendicular * 2.0);
  highp vec2 sample5 = occludeDepth(diff - perpendicular * 2.0);
  highp vec2 sample6 = occludeDepth(diff + perpendicular * 3.0);
  highp vec2 sample7 = occludeDepth(diff - perpendicular * 3.0);
  highp float mindist = min(sample1.x, min(sample2.x, min(sample3.x, min(sample4.x, min(sample5.x, min(sample6.x, sample7.x))))));
  mindist = max(0.001, mindist);
  highp float distRatio = (ourDist - mindist);
  highp float sigma = max(0.001, distRatio * 0.75);
  highp vec4 weights = calcGaussianWeights(sigma, vec4(0.0, 1.0, 2.0, 3.0));
  highp float totalWeigths = weights.x + weights.y * 2.0 + weights.z * 2.0 + weights.w * 2.0;
  highp float occlusion = 0.0;
  occlusion += ChebyshevUpperBound(sample1, ourDist) * weights.x;
  occlusion += ChebyshevUpperBound(sample2, ourDist) * weights.y;
  occlusion += ChebyshevUpperBound(sample3, ourDist) * weights.y;
  occlusion += ChebyshevUpperBound(sample4, ourDist) * weights.z;
  occlusion += ChebyshevUpperBound(sample5, ourDist) * weights.z;
  occlusion += ChebyshevUpperBound(sample6, ourDist) * weights.w;
  occlusion += ChebyshevUpperBound(sample7, ourDist) * weights.w;
  return occlusion / totalWeigths;
}
void main() {
  highp float mask = texture(maskTex, UV).r;
  highp vec2 diff = worldPosition - lightCenter;
  highp float occlusion = lightIndex < 0.0 ? 1.0 : createOcclusion(diff);
  if (occlusion == 0.0) discard;
  highp float sqr_dist = dot(diff, diff) + LIGHTING_HEIGHT;
  highp float s = clamp(sqrt(sqr_dist) / lightRange, 0.0, 1.0);
  highp float s2 = s * s;
  highp float curveFactor = mix(s, s2, clamp(lightCurveFactor, 0.0, 1.0));
  highp float val = clamp(((1.0 - s2) * (1.0 - s2)) / (1.0 + lightFalloff * curveFactor), 0.0, 1.0);
  val *= lightPower;
  val *= mask;
  fragColor = vec4(lightColor.rgb, val * occlusion);
}`;

// light-blur.swsl / wall-bleed-blur.swsl (gain 1.1)
const BLUR_VS = HEAD + `
in vec2 aQuad;
uniform vec2 direction;
uniform vec2 size;
uniform float radius;
out vec2 pos;
out vec4 blurPos1;
out vec4 blurPos2;
void main() {
  float aspect = size.y / size.x;
  float horRadius = aspect * radius;
  vec2 offset = vec2(horRadius, radius) * direction;
  pos = (aQuad + vec2(1.0)) / 2.0;
  blurPos1.xy = pos + offset;
  blurPos1.zw = pos - offset;
  blurPos2.xy = pos + offset * 2.0;
  blurPos2.zw = pos - offset * 2.0;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}`;
const BLUR_FS = HEAD + `
in vec2 pos; in vec4 blurPos1; in vec4 blurPos2;
out vec4 fragColor;
uniform sampler2D tex;
uniform float gain;
void main() {
  vec4 sum = texture(tex, pos) * 0.375;
  sum += texture(tex, blurPos1.xy) * 0.25;
  sum += texture(tex, blurPos1.zw) * 0.25;
  sum += texture(tex, blurPos2.xy) * 0.0625;
  sum += texture(tex, blurPos2.zw) * 0.0625;
  fragColor = sum * gain;
}`;

// polygons in world space (wall-merge, gi_seed, AO source)
const POLY_VS = HEAD + `
in vec2 aWorld;
uniform mat3 uWorldToClip;
out vec2 pos;
void main() {
  vec2 c = (uWorldToClip * vec3(aWorld, 1.0)).xy;
  pos = (c + vec2(1.0)) / 2.0;
  gl_Position = vec4(c, 0.0, 1.0);
}`;
const MERGE_FS = HEAD + `in vec2 pos; out vec4 fragColor; uniform sampler2D tex; void main() { fragColor = texture(tex, pos); }`;
const SEED_FS = HEAD + `out vec4 fragColor; void main() { fragColor = vec4(gl_FragCoord.xy, 0.0, 1.0); }`;
const WHITE_FS = HEAD + `out vec4 fragColor; void main() { fragColor = vec4(1.0); }`;

const GI_JUMP_FS = HEAD + `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tex;
uniform highp vec2 targetSize;
uniform highp float stepSize;
void main() {
  highp vec2 p0 = gl_FragCoord.xy;
  highp vec4 best = vec4(0.0);
  highp float bestDist = 1000000000.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    highp vec2 p = p0 + vec2(float(x), float(y)) * stepSize;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= targetSize.x || p.y >= targetSize.y) continue;
    highp vec4 seed = texture(tex, p / targetSize);
    if (seed.x < 0.25) continue;
    highp vec2 d = seed.xy - p0;
    highp float dist = dot(d, d);
    if (dist < bestDist) { bestDist = dist; best = seed; }
  }
  fragColor = best;
}`;
const GI_TRACE_FS = HEAD + `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tex;
uniform sampler2D LIGHT_TEXTURE;
uniform highp vec2 targetSize;
uniform highp float maxDistance;
uniform lowp int rays;
uniform sampler2D HISTORY_TEXTURE;
uniform highp float historyWeight;
uniform highp float feedback;
uniform highp float frame;
uniform highp vec2 lightUvScale;   // this target's uv to the light map's uv (the GI target is rounded up)
const lowp int MAX_RAYS = 32;
const lowp int MAX_STEPS = 32;
const highp float TAU = 6.28318530718;
highp float ign(highp vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
highp float wallDistance(highp vec2 p, out highp vec2 wall) {
  highp vec4 seed = texture(tex, (floor(p) + 0.5) / targetSize);
  wall = seed.xy;
  if (seed.x < 0.25) return maxDistance;
  return distance(seed.xy, p);
}
void main() {
  highp vec2 origin = gl_FragCoord.xy;
  highp vec2 wall;
  highp vec3 sum = vec3(0.0);
  highp float count = float(rays);
  highp float escaped = 0.0;
  if (wallDistance(origin, wall) >= 0.5) {
    highp float jitter = fract(ign(origin) + frame * 0.61803398875);
    for (int i = 0; i < MAX_RAYS; i++) {
      if (i >= rays) break;
      highp float angle = (float(i) + jitter) / count * TAU;
      highp vec2 dir = vec2(cos(angle), sin(angle));
      highp float travelled = 0.0;
      for (int j = 0; j < MAX_STEPS; j++) {
        highp vec2 p = origin + dir * travelled;
        if (p.x < 0.0 || p.y < 0.0 || p.x >= targetSize.x || p.y >= targetSize.y) { escaped += 1.0; break; }
        highp float d = wallDistance(p, wall);
        if (d < 1.0) {
          highp vec3 bounced = texture(LIGHT_TEXTURE, wall / targetSize * lightUvScale).rgb;
          if (feedback > 0.0) {
            highp vec2 front = clamp(p - dir * 1.5, vec2(0.5), targetSize - 0.5);
            highp vec4 previous = texture(HISTORY_TEXTURE, front / targetSize);
            bounced += previous.rgb * previous.a * feedback;
          }
          sum += bounced;
          break;
        }
        travelled += max(d - 0.5, 1.0);
        if (travelled > maxDistance) break;
      }
    }
  }
  highp vec4 history = texture(HISTORY_TEXTURE, origin / targetSize);
  highp float known = count - escaped;
  highp vec3 traced = known > 0.5 ? sum / known : vec3(0.0);
  fragColor = vec4(mix(traced, history.rgb, historyWeight * history.a), 1.0);
}`;
// gi_copy: last frame's bounce light moved into this frame's view (world-space reprojection)
const GI_REPROJECT_FS = HEAD + `
in vec2 vUv; in vec2 vWorld; out vec4 fragColor;
uniform sampler2D tex;
uniform mat3 uPrevWorldToUv;
void main() {
  vec2 uv = (uPrevWorldToUv * vec3(vWorld, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { fragColor = vec4(0.0); return; }
  fragColor = texture(tex, uv);
}`;
const COPY_FS = HEAD + `in vec2 vUv; out vec4 fragColor; uniform sampler2D tex; uniform vec2 uvScale; void main() { fragColor = texture(tex, vUv * uvScale); }`;
const GI_COMPOSITE_FS = HEAD + `in vec2 vUv; out vec4 fragColor; uniform sampler2D tex; uniform float strength; uniform vec2 uvScale;
void main() { fragColor = vec4(texture(tex, vUv * uvScale).rgb * strength, 1.0); }`;

// light_tonemap.swsl
const TONEMAP_FS = HEAD + `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D tex;
uniform highp float exposure;
uniform highp float knee;
uniform highp float maxLight;
highp float compress(highp float value) {
  highp float range = max(maxLight - knee, 0.0001);
  return knee + range * (1.0 - exp(-(value - knee) / range));
}
void main() {
  highp vec3 rgb = texture(tex, vUv).rgb * exposure;
  highp float peak = max(rgb.r, max(rgb.g, rgb.b));
  if (peak > knee) rgb *= compress(peak) / peak;
  fragColor = vec4(rgb, 1.0);
}`;

// The world as the engine draws it: parallax (unlit), tiles and decals times the light, ambient occlusion
// (#04080FAA, lit, on non-space tiles), entities times the light, unshaded layers as they are; then fov.swsl.
// The 2D map canvases are sRGB with straight alpha; layers are pulled apart from the canvas composite.
const WORLD_FS = HEAD + SHADOW_SHARED + `
in vec2 vUv; in vec2 vWorld; out vec4 fragColor;
uniform sampler2D mapTex, tileTex, entTex, glowTex, aoTex, lightTex, fovTex;
uniform int useAO, useFov, haveLayers;
uniform vec2 eye;
uniform vec4 aoColor;
vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
void main() {
  vec4 map = texture(mapTex, vUv);
  vec4 T = texture(tileTex, vUv), E = haveLayers == 1 ? texture(entTex, vUv) : vec4(0.0), G = texture(glowTex, vUv);
  vec3 L = texture(lightTex, vUv).rgb;
  float t = T.a, e = E.a;
  float a = e + t * (1.0 - e);
  vec3 Wp = E.rgb * e + T.rgb * t * (1.0 - e);                // what the grids added to the canvas (sRGB)
  vec3 P = a < 0.999 ? clamp((map.rgb - Wp) / (1.0 - a), 0.0, 1.0) : vec3(0.0);
  vec3 c = lin(P);
  c = mix(c, lin(T.rgb) * L, t);
  if (useAO == 1 && t > 0.0) c = mix(c, lin(aoColor.rgb) * L, texture(aoTex, vUv).a * aoColor.a);
  c = mix(c, lin(E.rgb) * L, e);
  c = mix(c, lin(G.rgb), G.a);
  if (useFov == 1) {
    vec2 d = vWorld - eye;
    if (occludeDepthL(d, fovTex, 0.75, false).x + (-0.75 / 32.0) < length(d)) c = vec3(0.0);
  }
  fragColor = vec4(c, 1.0);
}`;

// bloom_extract.swsl
const BLOOM_FS = HEAD + `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D screenTex, lightTex;
uniform highp float threshold;
const highp float LIT_ALBEDO = 0.8;
void main() {
  highp vec3 screen = texture(screenTex, vUv).rgb;
  highp vec3 light = texture(lightTex, vUv).rgb;
  highp vec3 glow = max(screen - light * LIT_ALBEDO, 0.0);
  highp float peak = max(glow.r, max(glow.g, glow.b));
  glow *= smoothstep(threshold, threshold + 0.25, peak);
  fragColor = vec4(glow, 1.0);
}`;

// screen_postprocess.swsl, output encoded to sRGB for the page
const POST_FS = HEAD + `
in vec2 vUv; out vec4 fragColor;
uniform sampler2D SCREEN_TEXTURE, LIGHT_TEXTURE, BLOOM_TEXTURE;
uniform highp float lightAvailable, nightVision, bloom, vignette, brightness, grain, TIME;
uniform highp vec2 SCREEN_PIXEL_SIZE;
const highp vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const highp vec3 SCOTOPIC = vec3(0.05, 0.55, 0.40);
const highp vec3 NIGHT_TINT = vec3(0.78, 0.92, 1.18);
const highp float NIGHT_DARK = 0.03;
const highp float NIGHT_LIT = 0.2;
highp float hash(highp vec2 p) {
  highp vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  highp vec2 Pos = vUv;
  highp vec4 screen = texture(SCREEN_TEXTURE, Pos);
  highp vec3 color = screen.rgb;
  if (nightVision > 0.0 && lightAvailable > 0.5) {
    highp vec3 lightRgb = texture(LIGHT_TEXTURE, Pos).rgb;
    highp float light = max(lightRgb.r, max(lightRgb.g, lightRgb.b));
    highp float night = (1.0 - smoothstep(NIGHT_DARK, NIGHT_LIT, light)) * nightVision;
    highp float glow = max(max(color.r, max(color.g, color.b)) - light, 0.0);
    night *= 1.0 - smoothstep(0.1, 0.4, glow);
    color = mix(color, vec3(dot(color, SCOTOPIC)) * NIGHT_TINT, night);
  }
  if (bloom > 0.0) {
    highp vec3 halo = texture(BLOOM_TEXTURE, Pos).rgb * bloom;
    color = 1.0 - (1.0 - color) * (1.0 - clamp(halo, 0.0, 1.0));
  }
  if (brightness != 1.0) color = pow(clamp(color, 0.0, 1.0), vec3(1.0 / brightness));
  if (vignette > 0.0) {
    highp float aspect = SCREEN_PIXEL_SIZE.y / SCREEN_PIXEL_SIZE.x;
    highp vec2 centered = (Pos - 0.5) * vec2(aspect, 1.0);
    highp float dist = length(centered) / length(vec2(0.5 * aspect, 0.5));
    color *= 1.0 - vignette * smoothstep(0.4, 1.0, dist);
  }
  if (grain > 0.0) {
    highp float frame = mod(floor(TIME * 24.0), 241.0);
    highp vec2 cell = mod(gl_FragCoord.xy, 1024.0) + frame * vec2(17.0, 31.0);
    highp float noise = hash(cell) - 0.5;
    highp float luma = dot(color, LUMA);
    color += noise * grain * smoothstep(0.0, 0.25, luma) * (1.0 - 0.5 * luma);
  }
  fragColor = vec4(toSrgb(clamp(color, 0.0, 1.0)), 1.0);
}`;

// ---------------------------------------------------------------- GL helpers
function compile(gl, vs, fs, attribs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

export class ClydeLighting {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false, stencil: false, depth: false });
    if (!gl) throw new Error('WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('float render targets are not available');
    this.gl = gl;
    this.canvas = canvas;
    this.P = {
      depth: compile(gl, DEPTH_VS, DEPTH_FS, ['aPos', 'subVertex']),
      fovLight: compile(gl, QUAD_VS, FOV_LIGHT_FS, ['aQuad']),
      light: compile(gl, LIGHT_VS, LIGHT_FS, ['aQuad']),
      blur: compile(gl, BLUR_VS, BLUR_FS, ['aQuad']),
      merge: compile(gl, POLY_VS, MERGE_FS, ['aWorld']),
      seed: compile(gl, POLY_VS, SEED_FS, ['aWorld']),
      white: compile(gl, POLY_VS, WHITE_FS, ['aWorld']),
      jump: compile(gl, QUAD_VS, GI_JUMP_FS, ['aQuad']),
      trace: compile(gl, QUAD_VS, GI_TRACE_FS, ['aQuad']),
      reproject: compile(gl, QUAD_VS, GI_REPROJECT_FS, ['aQuad']),
      copy: compile(gl, QUAD_VS, COPY_FS, ['aQuad']),
      giComposite: compile(gl, QUAD_VS, GI_COMPOSITE_FS, ['aQuad']),
      tonemap: compile(gl, QUAD_VS, TONEMAP_FS, ['aQuad']),
      world: compile(gl, QUAD_VS, WORLD_FS, ['aQuad']),
      bloom: compile(gl, QUAD_VS, BLOOM_FS, ['aQuad']),
      post: compile(gl, QUAD_VS, POST_FS, ['aQuad']),
    };
    // a full-target quad (triangle strip) and a 0..1 quad for lights
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.unitQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.edgeBuf = gl.createBuffer(); this.subBuf = gl.createBuffer(); this.idxBuf = gl.createBuffer();
    this.polyBuf = gl.createBuffer();
    this.targets = {};
    this.tex = {};
    this.white = this.texFrom1px([255, 255, 255, 255]);
    this.masks = new Map();
    this.gi = { valid: false, frame: 0 };
  }

  texFrom1px(px) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t;
  }

  // light mask textures (sRGB, sampled linear as Clyde's zTexture)
  maskTexture(key, img) {
    if (this.masks.has(key)) return this.masks.get(key);
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.masks.set(key, t);
    return t;
  }

  // a render target: texture (+ optional depth or depth-stencil), reused while the size and format stay
  target(name, w, h, fmt, opts = {}) {
    const gl = this.gl;
    let t = this.targets[name];
    if (t && t.w === w && t.h === h) return t;
    if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); if (t.rb) gl.deleteRenderbuffer(t.rb); }
    const F = { rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT], rg32f: [gl.RG32F, gl.RG, gl.FLOAT], srgb: [gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE] }[fmt];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, F[0], w, h, 0, F[1], F[2], null);
    const filt = opts.nearest ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let rb = null;
    if (opts.depth || opts.stencil) {
      rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
    }
    t = { tex, fb, rb, w, h };
    this.targets[name] = t;
    return t;
  }

  bind(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
  }

  // a 2D canvas as an sRGB texture, rows flipped so uv (0,0) is the bottom left like the GL targets
  upload(name, cv) {
    const gl = this.gl;
    let t = this.tex[name];
    if (!t) { t = this.tex[name] = gl.createTexture(); }
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);   // raw sRGB values, decoded in the shader
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  quadDraw(prog) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  useTex(prog, name, unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog.u[name] != null) gl.uniform1i(prog.u[name], unit);
  }

  // BlurRenderTarget / BlurOntoWalls: 3 iterations of a horizontal then a vertical 5-tap pass
  blur(src, buf, dst, multiplierUv, gain) {
    const gl = this.gl, pr = this.P.blur;
    gl.useProgram(pr.p);
    gl.uniform1f(pr.u.gain, gain);
    let from = src;
    for (let i = 3; i > 0; i--) {
      gl.uniform1f(pr.u.radius, (i + 1) * multiplierUv);
      this.bind(buf);
      gl.uniform2f(pr.u.size, buf.w, buf.h);
      gl.uniform2f(pr.u.direction, 1, 0);
      this.useTex(pr, 'tex', 0, from.tex);
      this.quadDraw(pr);
      this.bind(dst);
      gl.uniform2f(pr.u.size, dst.w, dst.h);
      gl.uniform2f(pr.u.direction, 0, 1);
      this.useTex(pr, 'tex', 0, buf.tex);
      this.quadDraw(pr);
      from = dst;
    }
  }

  polys(prog, polys, worldToClip) {
    const gl = this.gl;
    const tris = [];
    for (const v of polys) for (let i = 1; i < v.length - 1; i++) tris.push(v[0][0], v[0][1], v[i][0], v[i][1], v[i + 1][0], v[i + 1][1]);
    if (!tris.length) return;
    gl.useProgram(prog.p);
    gl.uniformMatrix3fv(prog.u.uWorldToClip, false, worldToClip);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.polyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, tris.length / 2);
  }

  // UploadSourceOcclusionDepthGeometry: 4 vertices per edge (deflection, height) = DddD / HHhh
  uploadEdges(edges) {
    const gl = this.gl, n = edges.length;
    const pos = new Float32Array(n * 16), sub = new Uint8Array(n * 8), idx = new Uint32Array(n * 6);
    for (let k = 0; k < n; k++) {
      const e = edges[k];
      for (let vi = 0; vi < 4; vi++) {
        pos.set(e, (k * 4 + vi) * 4);
        sub[(k * 4 + vi) * 2] = ((vi + 1) & 2) !== 0 ? 0 : 255;
        sub[(k * 4 + vi) * 2 + 1] = (vi & 2) !== 0 ? 0 : 255;
      }
      const b = k * 4;   // the fan 0 1 2 3 as triangles
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.subBuf); gl.bufferData(gl.ARRAY_BUFFER, sub, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
    this.edgeCount = n;
  }

  // PrepareDepthDraw + DrawOcclusionDepth rows
  depthRows(t, sources, culls) {
    const gl = this.gl, pr = this.P.depth;
    this.bind(t);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
    gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW);
    gl.clearBufferfv(gl.COLOR, 0, [ARBITRARY_DISTANCE_MAX, ARBITRARY_DISTANCE_MAX * ARBITRARY_DISTANCE_MAX, 0, 1]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    if (this.edgeCount) {
      gl.useProgram(pr.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuf);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.subBuf);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      sources.forEach((src, row) => {
        if (!src) return;
        gl.cullFace(culls[row]);
        gl.viewport(0, row, t.w, 1);
        gl.uniform2f(pr.u.shadowLightCentre, src[0], src[1]);
        for (const side of [0, 1]) {
          gl.uniform1f(pr.u.shadowOverlapSide, side);
          gl.drawElements(gl.TRIANGLES, this.edgeCount * 6, gl.UNSIGNED_INT, 0);
        }
      });
      gl.disableVertexAttribArray(1);
    }
    gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
  }

  // ---------------------------------------------------------------- one frame
  // f: { w, h (canvas px), k (px per tile), worldToClip, clipToWorld, eye: [x,y], drawFov, edges, lights,
  //      occluderPolys, aoPolys, layers: { map, tile, ent, glow }, haveLayers, opts, ambient }
  render(f) {
    const gl = this.gl, P = this.P;
    const lw = Math.ceil(f.w * 0.5), lh = Math.ceil(f.h * 0.5);          // light.resolution_scale 0.5
    const qw = Math.ceil(f.w * 0.25), qh = Math.ceil(f.h * 0.25);
    const cameraSize = f.h / f.k;
    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);

    // depth maps: FOV (2 rows) and one row per shadow-casting light
    this.uploadEdges(f.edges);
    const fov = this.target('fov', FOV_W, 2, 'rg32f', { depth: true, nearest: true, repeat: true });
    this.depthRows(fov, f.drawFov ? [f.eye, f.eye] : [], [gl.BACK, gl.FRONT]);
    const shadowLights = f.lights.filter(l => l.shadowRow >= 0);
    const shadow = this.target('shadow', SHADOW_W, Math.max(1, shadowLights.length), 'rg32f', { depth: true, nearest: true, repeat: true });
    const rows = []; for (const l of shadowLights) rows[l.shadowRow] = l.pos;
    this.depthRows(shadow, rows, rows.map(() => gl.BACK));

    // the light target: clear colour, lighting FOV (stencil), lights
    const light = this.target('light', lw, lh, 'rgba16f', { stencil: true });
    this.bind(light);
    gl.clearColor(f.ambient[0], f.ambient[1], f.ambient[2], 1);
    gl.clearStencil(0xFF); gl.stencilMask(0xFF);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.stencilFunc(gl.ALWAYS, 0, 0); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.useProgram(P.fovLight.p);
    gl.uniformMatrix3fv(P.fovLight.u.uClipToWorld, false, f.clipToWorld);
    gl.uniform2f(P.fovLight.u.eye, f.eye[0], f.eye[1]);
    this.useTex(P.fovLight, 'fovTex', 0, fov.tex);
    this.quadDraw(P.fovLight);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.stencilFunc(gl.EQUAL, 0xFF, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    const pl = P.light;
    gl.useProgram(pl.p);
    gl.uniformMatrix3fv(pl.u.uWorldToClip, false, f.worldToClip);
    this.useTex(pl, 'shadowMap', 0, shadow.tex);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitQuad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const l of f.lights) {
      this.useTex(pl, 'maskTex', 1, l.mask || this.white);
      gl.uniform4f(pl.u.lightColor, l.color[0], l.color[1], l.color[2], 1);
      gl.uniform2f(pl.u.lightCenter, l.pos[0], l.pos[1]);
      gl.uniform1f(pl.u.lightRange, l.radius);
      gl.uniform1f(pl.u.lightPower, l.energy);
      gl.uniform1f(pl.u.lightSoftness, l.softness);
      gl.uniform1f(pl.u.lightFalloff, l.falloff);
      gl.uniform1f(pl.u.lightCurveFactor, l.curve);
      gl.uniform1f(pl.u.maskRot, l.mask ? l.maskRot : 0);
      gl.uniform1f(pl.u.lightIndex, l.shadowRow >= 0 ? (l.shadowRow + 0.5) / shadow.h : -1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND);

    // light.blur (multiplier 14), BlurOntoWalls (7e-3 x 14, gain 1.1) and MergeWallLayer
    const lightBlur = this.target('lightBlur', lw, lh, 'rgba16f');
    this.blur(light, lightBlur, light, 0.001 * 14 / cameraSize, 1);
    const wb1 = this.target('wb1', qw, qh, 'rgba16f'), wb2 = this.target('wb2', qw, qh, 'rgba16f');
    this.blur(light, wb1, wb2, 7e-3 * 14 / cameraSize, 1.1);
    this.bind(light);
    gl.useProgram(P.merge.p);
    this.useTex(P.merge, 'tex', 0, wb2.tex);
    this.polys(P.merge, f.occluderPolys, f.worldToClip);

    // global illumination (Starlight), before the tonemap
    if (f.opts.gi) this.globalIllumination(f, light, lw, lh, cameraSize);

    // LightTonemapOverlay: exposure 1, knee 0.7, max 1.15
    const lightCopy = this.target('lightCopy', lw, lh, 'rgba16f');
    this.bind(lightCopy);
    gl.useProgram(P.copy.p); gl.uniform2f(P.copy.u.uvScale, 1, 1);
    this.useTex(P.copy, 'tex', 0, light.tex); this.quadDraw(P.copy);
    this.bind(light);
    gl.useProgram(P.tonemap.p);
    gl.uniform1f(P.tonemap.u.exposure, 1); gl.uniform1f(P.tonemap.u.knee, 0.7); gl.uniform1f(P.tonemap.u.maxLight, 1.15);
    this.useTex(P.tonemap, 'tex', 0, lightCopy.tex); this.quadDraw(P.tonemap);

    // ambient occlusion source: occluders grown by 4 px, at half resolution, light-blurred x7
    const aoT = this.target('ao', lw, lh, 'srgb'), aoB = this.target('aoBlur', lw, lh, 'srgb');
    if (f.opts.ao) {
      this.bind(aoT);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      this.polys(P.white, f.aoPolys, f.worldToClip);
      this.blur(aoT, aoB, aoT, 0.001 * 7 / cameraSize, 1);
    }

    // the world
    const screen = this.target('screen', f.w, f.h, 'rgba16f');
    this.bind(screen);
    const pw = P.world;
    gl.useProgram(pw.p);
    gl.uniformMatrix3fv(pw.u.uClipToWorld, false, f.clipToWorld);
    this.useTex(pw, 'mapTex', 0, this.upload('map', f.layers.map));
    this.useTex(pw, 'tileTex', 1, this.upload('tile', f.layers.tile));
    this.useTex(pw, 'entTex', 2, this.upload('ent', f.layers.ent));
    this.useTex(pw, 'glowTex', 3, this.upload('glow', f.layers.glow));
    this.useTex(pw, 'aoTex', 4, aoT.tex);
    this.useTex(pw, 'lightTex', 5, light.tex);
    this.useTex(pw, 'fovTex', 6, fov.tex);
    gl.uniform1i(pw.u.useAO, f.opts.ao ? 1 : 0);
    gl.uniform1i(pw.u.useFov, f.drawFov ? 1 : 0);
    gl.uniform1i(pw.u.haveLayers, f.haveLayers ? 1 : 0);
    gl.uniform2f(pw.u.eye, f.eye[0], f.eye[1]);
    gl.uniform4f(pw.u.aoColor, 0x04 / 255, 0x08 / 255, 0x0F / 255, 0xAA / 255);
    this.quadDraw(pw);

    // bloom (ScreenPostProcessOverlay: half size, Rgba8Srgb, blurred with bloom radius 10)
    const bw = Math.ceil(f.w * 0.5), bh = Math.ceil(f.h * 0.5);
    const bloomT = this.target('bloom', bw, bh, 'srgb'), bloomB = this.target('bloomBlur', bw, bh, 'srgb');
    if (f.opts.bloom) {
      this.bind(bloomT);
      gl.useProgram(P.bloom.p);
      gl.uniform1f(P.bloom.u.threshold, 0.15);
      this.useTex(P.bloom, 'screenTex', 0, screen.tex);
      this.useTex(P.bloom, 'lightTex', 1, light.tex);
      this.quadDraw(P.bloom);
      this.blur(bloomT, bloomB, bloomT, 0.001 * 10 / cameraSize, 1);
    }
    this.last = { f, screen, light, bloomT };
    this.post(performance.now() / 1000);
  }

  // ScreenPostProcessOverlay's final pass (rerun on its own for the film grain)
  post(time) {
    if (!this.last) return;
    const gl = this.gl, P = this.P, { f, screen, light, bloomT } = this.last;
    this.bind(null);
    gl.disable(gl.BLEND);
    const pp = P.post;
    gl.useProgram(pp.p);
    this.useTex(pp, 'SCREEN_TEXTURE', 0, screen.tex);
    this.useTex(pp, 'LIGHT_TEXTURE', 1, light.tex);
    this.useTex(pp, 'BLOOM_TEXTURE', 2, f.opts.bloom ? bloomT.tex : screen.tex);
    gl.uniform1f(pp.u.lightAvailable, 1);
    gl.uniform1f(pp.u.nightVision, f.opts.nightVision ? 0.7 : 0);
    gl.uniform1f(pp.u.bloom, f.opts.bloom ? 0.7 : 0);
    gl.uniform1f(pp.u.vignette, f.opts.vignette ? 0.5 : 0);
    gl.uniform1f(pp.u.brightness, 1);
    gl.uniform1f(pp.u.grain, f.opts.grain ? 0.05 : 0);
    gl.uniform1f(pp.u.TIME, time);
    gl.uniform2f(pp.u.SCREEN_PIXEL_SIZE, 1 / f.w, 1 / f.h);
    this.quadDraw(pp);
  }

  // GlobalIlluminationOverlay: resolution 0.5, 12 rays, 6 tiles, strength 0.6, blur 4, history 0.85
  globalIllumination(f, light, lw, lh, cameraSize) {
    const gl = this.gl, P = this.P, gi = this.gi;
    const gw = Math.max(1, Math.ceil(lw * 0.5)), gh = Math.max(1, Math.ceil(lh * 0.5));
    const seedA = this.target('giSeedA', gw, gh, 'rg32f', { nearest: true });
    const seedB = this.target('giSeedB', gw, gh, 'rg32f', { nearest: true });
    const hist = this.target('giHistory', gw, gh, 'rgba16f');
    const acc = this.target('giAcc', gw, gh, 'rgba16f');
    const acc2 = this.target('giAcc2', gw, gh, 'rgba16f');
    const bounce = this.target('giBounce', gw, gh, 'rgba16f');
    const bounceBlur = this.target('giBounceBlur', gw, gh, 'rgba16f');
    // the GI target covers the view like the light map, at half its resolution
    const pixelsPerTile = f.k * gw / f.w;
    const maxDistance = Math.max(1, 6 * pixelsPerTile);
    // 1. seeds (occluder polygons) — drawn in the GI target's own pixels
    const giWorldToClip = f.worldToClip;
    this.bind(seedA);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    this.polys(P.seed, f.occluderPolys, giWorldToClip);
    // 2. jump flood
    let step = 1;
    while (step < maxDistance && step < Math.max(gw, gh)) step <<= 1;
    let src = seedA, dst = seedB;
    gl.useProgram(P.jump.p);
    gl.uniform2f(P.jump.u.targetSize, gw, gh);
    for (; step >= 1; step >>= 1) {
      this.bind(dst);
      gl.uniform1f(P.jump.u.stepSize, step);
      this.useTex(P.jump, 'tex', 0, src.tex);
      this.quadDraw(P.jump);
      [src, dst] = [dst, src];
    }
    const sdf = src;
    // world -> GI uv of this frame (for the next frame's reprojection)
    const clipToWorldGi = f.clipToWorld;
    const worldToUv = [giWorldToClip[0] / 2, giWorldToClip[1] / 2, 0, giWorldToClip[3] / 2, giWorldToClip[4] / 2, 0, (giWorldToClip[6] + 1) / 2, (giWorldToClip[7] + 1) / 2, 1];
    // a standing view: the engine keeps tracing every frame; run frames until the history has settled
    const iterations = gi.valid ? 4 : 24;
    for (let it = 0; it < iterations; it++) {
      // 3. history: last accumulated result moved into this view
      this.bind(hist);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (gi.valid && gi.accT) {
        gl.useProgram(P.reproject.p);
        gl.uniformMatrix3fv(P.reproject.u.uClipToWorld, false, clipToWorldGi);
        gl.uniformMatrix3fv(P.reproject.u.uPrevWorldToUv, false, gi.prevWorldToUv);
        this.useTex(P.reproject, 'tex', 0, gi.accT.tex);
        this.quadDraw(P.reproject);
      }
      // 4. trace
      const out = gi.accT === acc ? acc2 : acc;
      this.bind(out);
      const pt = P.trace;
      gl.useProgram(pt.p);
      this.useTex(pt, 'tex', 0, sdf.tex);
      this.useTex(pt, 'LIGHT_TEXTURE', 1, light.tex);
      this.useTex(pt, 'HISTORY_TEXTURE', 2, hist.tex);
      gl.uniform2f(pt.u.targetSize, gw, gh);
      gl.uniform2f(pt.u.lightUvScale, 1, 1);
      gl.uniform1f(pt.u.maxDistance, maxDistance);
      gl.uniform1i(pt.u.rays, 12);
      gl.uniform1f(pt.u.historyWeight, 0.85);
      gl.uniform1f(pt.u.feedback, Math.min(0.6, 0.8));
      gi.frame = (gi.frame + 1) % 64;
      gl.uniform1f(pt.u.frame, gi.frame);
      this.quadDraw(pt);
      gi.accT = out; gi.valid = true; gi.prevWorldToUv = worldToUv;
    }
    // 5. blurred copy, added onto the light map with strength 0.6
    this.bind(bounce);
    gl.useProgram(P.copy.p); gl.uniform2f(P.copy.u.uvScale, 1, 1);
    this.useTex(P.copy, 'tex', 0, gi.accT.tex); this.quadDraw(P.copy);
    this.blur(bounce, bounceBlur, bounce, 0.001 * 4 / cameraSize, 1);
    this.bind(light);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(P.giComposite.p);
    gl.uniform1f(P.giComposite.u.strength, 0.6);
    gl.uniform2f(P.giComposite.u.uvScale, 1, 1);
    this.useTex(P.giComposite, 'tex', 0, bounce.tex);
    this.quadDraw(P.giComposite);
    gl.disable(gl.BLEND);
  }

  resetHistory() { this.gi.valid = false; }
}

export function invert3(m) {   // column-major 3x3 affine
  const a = m[0], b = m[1], c = m[3], d = m[4], e = m[6], f = m[7];
  const det = a * d - b * c;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, 0, ic, id, 0, -(ia * e + ic * f), -(ib * e + id * f), 1];
}
