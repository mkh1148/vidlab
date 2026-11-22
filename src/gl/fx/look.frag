#version 300 es
precision highp float;
precision highp sampler3D;

// Every shipped film look renders through this one shader. The look's colour
// identity is the .cube it binds, generated from src/gl/looks/lookFormulas.ts; the
// only things this shader adds are the two a 3D LUT cannot express (grain and
// vignette) and the intensity mix.
//
// No BT.709 encode/decode sandwich, unlike lut.frag: the source texture, the
// drawing buffer and the LUT are all sRGB-coded (src/gl/colorPipeline.ts), so the
// LUT is sampled with the code value the texture already holds.
uniform sampler2D u_input;
uniform sampler3D u_lut;
uniform float u_intensity;
uniform float u_grain;
uniform float u_vignette;
uniform float u_time;

in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 base = clamp(src.rgb, 0.0, 1.0);
  vec3 graded = texture(u_lut, base).rgb;
  float n = (hash(v_texCoord * 420.0 + floor(u_time * 20.0)) - 0.5) * u_grain;
  graded = clamp(graded + n, 0.0, 1.0);
  vec2 uv = v_texCoord * 2.0 - 1.0;
  float falloff = smoothstep(1.4, 0.35, length(uv));
  graded *= mix(1.0, falloff, clamp(u_vignette, 0.0, 1.0));
  fragColor = vec4(mix(base, graded, clamp(u_intensity, 0.0, 1.0)), src.a);
}
