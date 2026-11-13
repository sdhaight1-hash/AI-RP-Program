// Lightweight atmospheric WebGL preview. Not a 3D character/world renderer yet.
export function initAtmosphere(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
  if (!gl) return () => {};
  const vertex = `attribute vec2 position; varying vec2 uv; void main(){ uv=position*.5+.5; gl_Position=vec4(position,0.,1.); }`;
  const fragment = `precision mediump float; varying vec2 uv; uniform float time; uniform vec3 tint;
    float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){vec2 p=uv-vec2(.51,.59); p.x*=1.22;
      float d=length(p); float glow=pow(max(0.,1.-d),3.);
      float moon=smoothstep(.31,.30,length(p-vec2(.05,.08)));
      float cloud=sin(p.x*7.+time*.10)*sin(p.y*9.-time*.07)*.08;
      vec3 base=mix(vec3(.052,.048,.085),tint*.45,clamp(glow*.8+cloud,0.,1.));
      base+=tint*moon*.15; float stars=step(.997,hash(floor(uv*vec2(320.,180.))))*(.3+.4*sin(time*.5+uv.x*30.));
      base+=vec3(.7,.55,.95)*stars*(1.-glow*.7); base+=vec3(.07,.035,.10)*glow;
      base*=smoothstep(0.95,.2,d); gl_FragColor=vec4(base,1.);}`;
  const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  try {
    const program = gl.createProgram(); gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program,'position'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
    const time = gl.getUniformLocation(program,'time'), tint=gl.getUniformLocation(program,'tint');
    let shade=[.55,.38,.75], running=true, frame;
    const render = t => { if(!running)return; const w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight); if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h);}
      gl.uniform1f(time,t*.001); gl.uniform3fv(tint,shade); gl.drawArrays(gl.TRIANGLE_STRIP,0,4); frame=requestAnimationFrame(render); };
    frame=requestAnimationFrame(render);
    return color => { if(color==='stop'){running=false;cancelAnimationFrame(frame);return;}if(/^#[0-9a-f]{6}$/i.test(color||'')){shade=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);} };
  } catch (err) { console.warn('WebGL preview unavailable',err); return () => {}; }
}
