#version 300 es
precision highp float;

// D4 · face retouching: smooth skin, even tone, optional reshape — inside a skin
// region that comes from the "Analyze face" atlas, or from the landmark box when
// there is no atlas.
//
// The region is the whole contract with the analyzer:
//   * with a mask, the cell for THIS source frame is sampled out of the atlas and
//     the cell covers exactly the landmark box, so the mask moves with the face;
//   * without one, the same ellipse the analyzer uses to cut a mask is evaluated
//     here, so attaching an atlas does not change the region, only its precision.
// Everything outside the region is returned untouched — a retouch that leaks onto
// the background is the failure mode this file exists to avoid.
uniform sampler2D u_input;
uniform sampler2D u_face_atlas;

uniform vec4 u_face_box;      // x, y, w, h — normalized, top-left origin
uniform float u_face_mask;    // 1 = atlas available, 0 = landmark fallback
uniform vec2 u_face_cell;     // atlas cell column, row
uniform vec2 u_face_grid;     // atlas columns, rows
uniform float u_face_cell_px; // atlas cell edge in pixels

uniform float u_smoothness;   // 0..1
uniform float u_even_tone;    // 0..1
uniform float u_reshape;      // 0..1, 0 = off
uniform vec2 u_resolution;

in vec2 v_texCoord;
out vec4 fragColor;

const float REGION_RADIUS = 1.05;
const float REGION_FEATHER = 0.35;

float smoothstep01(float edge0, float edge1, float value) {
  float t = clamp((value - edge0) / max(edge1 - edge0, 1e-5), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// Weight of the skin region at one point of the frame, 0..1.
//
// u_face_box is measured on the frame the way a person sees it (y down, the
// analyzer's own coordinates). v_texCoord runs bottom-up, because the source is
// uploaded flipped so it lands upright. One conversion, here: without it the
// region lands on the mirrored half of the frame.
vec2 faceBoxMin() {
  return vec2(u_face_box.x, 1.0 - (u_face_box.y + u_face_box.w));
}

float faceWeight(vec2 uv) {
  if (u_face_box.z <= 0.0 || u_face_box.w <= 0.0) return 0.0;
  vec2 local = (uv - faceBoxMin()) / u_face_box.zw;
  if (local.x < 0.0 || local.x > 1.0 || local.y < 0.0 || local.y > 1.0) return 0.0;
  if (u_face_mask > 0.5) {
    // The cell covers the box; the atlas is uploaded flipped like the picture, so
    // the bottom-up local.y indexes the cell from its own bottom edge.
    vec2 atlasSize = u_face_grid * u_face_cell_px;
    vec2 cellOrigin = u_face_cell * u_face_cell_px;
    vec2 pixel = cellOrigin + clamp(local, 0.0, 1.0) * (u_face_cell_px - 1.0);
    return texture(u_face_atlas, (pixel + 0.5) / atlasSize).r;
  }
  vec2 n = local * 2.0 - 1.0;
  float distance = length(n) / REGION_RADIUS;
  return 1.0 - smoothstep01(1.0 - REGION_FEATHER, 1.0, distance);
}

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  vec2 uv = v_texCoord;
  float weight = faceWeight(uv);
  vec4 source = texture(u_input, uv);
  if (weight <= 0.0) {
    fragColor = source;
    return;
  }

  // Reshape: a horizontal squeeze that fades out at the top and bottom of the box,
  // so the chin and the hairline stay where they are. It moves the SAMPLING, not
  // the region: the mask still describes the face's place in the frame.
  vec2 sampleUv = uv;
  if (u_reshape > 0.0) {
    float centre = u_face_box.x + u_face_box.z * 0.5;
    float vertical = clamp((uv.y - faceBoxMin().y) / u_face_box.w, 0.0, 1.0);
    float taper = sin(vertical * 3.14159265);
    float squeeze = u_reshape * 0.10 * taper;
    sampleUv.x = centre + (uv.x - centre) * (1.0 - squeeze);
  }

  vec3 base = texture(u_input, sampleUv).rgb;
  float baseAlpha = source.a;

  // Smoothness: a small range-weighted blur. The range weight keeps eyes, lips and
  // the hairline crisp while flat skin averages — a plain blur would erase them.
  vec3 smoothed = base;
  if (u_smoothness > 0.0) {
    vec2 px = (1.0 + 11.0 * u_smoothness) / max(u_resolution, vec2(1.0));
    vec3 centre = base;
    vec3 acc = centre * 0.28;
    float total = 0.28;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.7853981634;
      vec2 offset = vec2(cos(angle), sin(angle)) * px;
      vec3 tap = texture(u_input, sampleUv + offset).rgb;
      float range = 1.0 - smoothstep(0.06, 0.22, abs(luma(tap) - luma(centre)));
      float w = 0.09 * range;
      acc += tap * w;
      total += w;
    }
    smoothed = acc / max(total, 1e-4);
  }

  // Even tone: pull the skin's low-frequency luminance toward its local mean and
  // keep the chroma, which is what "even" means on a face — the mottling goes, the
  // colour does not.
  vec3 toned = smoothed;
  if (u_even_tone > 0.0) {
    vec2 px = (2.0 + 12.0 * u_even_tone) / max(u_resolution, vec2(1.0));
    float mean = luma(smoothed) * 0.4;
    mean += luma(texture(u_input, sampleUv + vec2(px.x, 0.0)).rgb) * 0.15;
    mean += luma(texture(u_input, sampleUv - vec2(px.x, 0.0)).rgb) * 0.15;
    mean += luma(texture(u_input, sampleUv + vec2(0.0, px.y)).rgb) * 0.15;
    mean += luma(texture(u_input, sampleUv - vec2(0.0, px.y)).rgb) * 0.15;
    float current = luma(smoothed);
    float target = mix(current, mean, u_even_tone * 0.75);
    toned = smoothed * (target / max(current, 1e-3));
  }

  vec3 result = mix(base, toned, weight);
  fragColor = vec4(result * baseAlpha, baseAlpha);
}
