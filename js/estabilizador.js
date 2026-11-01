/*
 * Estabilizador de la cámara. Mide en vivo cuán quieto está el teléfono (giroscopio) y la nitidez de cada cuadro
 * del video, para tomar la foto en el momento justo y quedarse con el cuadro más nítido de una ráfaga corta.
 * Sin dependencias: la usa app.js.
 */
const Estabilizador = (() => {
  const giro = { muestras: [], disponible: false, escuchando: false };
  const UMBRAL_QUIETO = 4;            // °/s: por debajo, la mano está firme (el temblor normal es de 1 a 3 °/s)

  function alMoverse(e) {
    const r = e.rotationRate;
    if (!r || (r.alpha === null && r.beta === null && r.gamma === null)) return;
    const t = performance.now();
    giro.disponible = true;
    giro.muestras.push({ t, w: Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) });
    while (giro.muestras.length && t - giro.muestras[0].t > 1500) giro.muestras.shift();
  }

  function escucharGiro(activo) {
    if (!('DeviceMotionEvent' in window) || activo === giro.escuchando) return;
    giro.escuchando = activo;
    giro.muestras = [];
    if (activo) window.addEventListener('devicemotion', alMoverse);
    else window.removeEventListener('devicemotion', alMoverse);
  }

  /** Giro promedio (°/s) de los últimos ms; null si el teléfono no informa el giroscopio. */
  function giroReciente(ms = 200) {
    if (!giro.disponible) return null;
    const desde = performance.now() - ms, ultimas = giro.muestras.filter(m => m.t >= desde);
    if (!ultimas.length) return null;
    return ultimas.reduce((s, m) => s + m.w, 0) / ultimas.length;
  }

  const quieto = (ms = 200) => { const g = giroReciente(ms); return g !== null && g < UMBRAL_QUIETO; };

  /**
   * Reduce una zona de la imagen en un lienzo de la GPU y recién ahí la lee en uno de la CPU: así solo se copian unos
   * cientos de miles de píxeles por medida, no el cuadro completo de 12 MP (eso trabaría la vista previa en el teléfono).
   */
  function leerReducido(fuente, sx, sy, sw, sh, w, h, lienzo) {
    const gpu = lienzo.__gpu || (lienzo.__gpu = document.createElement('canvas'));
    if (gpu.width !== w || gpu.height !== h) { gpu.width = w; gpu.height = h; }
    const g = gpu.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(fuente, sx, sy, sw, sh, 0, 0, w, h);
    if (lienzo.width !== w || lienzo.height !== h) { lienzo.width = w; lienzo.height = h; }
    const ctx = lienzo.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(gpu, 0, 0);
    return ctx.getImageData(0, 0, w, h).data;
  }

  /**
   * Nitidez (energía de bordes, Tenengrad) y luz del centro de una imagen o del cuadro actual del video.
   * El recorte es el 36 % central (ahí está el texto) a ~1:2: un borroneo de 2–3 px se nota claramente.
   * anchoRef: mide a la misma escala que otra medida (para comparar una foto con un cuadro del video).
   */
  function medir(fuente, lienzo, anchoRef) {
    const fw = fuente.videoWidth || fuente.width, fh = fuente.videoHeight || fuente.height;
    if (!fw || !fh) return null;
    const sw = Math.round(fw * 0.36), sh = Math.round(fh * 0.36), sx = Math.round((fw - sw) / 2), sy = Math.round((fh - sh) / 2);
    const w = Math.max(16, Math.min(sw, anchoRef || 560)), h = Math.max(16, Math.round(sh * w / sw));
    const d = leerReducido(fuente, sx, sy, sw, sh, w, h, lienzo), g = new Float32Array(w * h);
    let luz = 0;
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      g[j] = v;
      luz += v;
    }
    let e = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, k = y * w + 1; x < w - 1; x++, k++) {
        const gx = g[k + 1] - g[k - 1], gy = g[k + w] - g[k - w];
        e += gx * gx + gy * gy;
      }
    }
    return { nitidez: e / ((w - 2) * (h - 2)), luz: luz / g.length, ancho: w };
  }

  /** Luz promedio del cuadro actual (barato: 160 × 120 px), para sugerir la linterna. */
  function luzDe(video, lienzo) {
    if (!video.videoWidth) return null;
    const d = leerReducido(video, 0, 0, video.videoWidth, video.videoHeight, 160, 120, lienzo);
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    return s / (d.length / 4);
  }

  /**
   * Ráfaga: desde el toque, mide cada cuadro y copia a resolución completa el más nítido. Termina cuando el
   * teléfono lleva 300 ms quieto (con giroscopio) o a los 700 ms (sin él); como máximo 2,5 s. alCambiar(estado)
   * informa 'firme' mientras espera la quietud. Devuelve { lienzo, nitidez, ancho, alto, espera, cuadros, giro } o null.
   */
  function rafaga(video, opciones = {}) {
    const max = opciones.max || 2500, conGiro = giro.disponible;
    return new Promise(resolver => {
      const inicio = performance.now(), medida = document.createElement('canvas');
      let mejor = null, cuadros = 0, quietoDesde = null, listo = false, aviso = null;
      const terminar = () => {
        if (listo) return;
        listo = true;
        clearTimeout(seguro);
        resolver(mejor ? Object.assign(mejor, { espera: Math.round(performance.now() - inicio), cuadros }) : null);
      };
      const seguro = setTimeout(terminar, max + 1500);   // el video se detuvo (cámara cerrada o tomada por otra app)
      const siguiente = () => {
        if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(paso);
        else requestAnimationFrame(paso);
      };
      const paso = () => {
        if (listo) return;
        if (opciones.cancelado && opciones.cancelado()) { terminar(); return; }
        const ahora = performance.now(), m = medir(video, medida);
        if (m) {
          cuadros++;
          const g = giroReciente(120);
          if (!mejor || m.nitidez > mejor.nitidez) {
            // Misma vuelta del ciclo: el cuadro copiado es el mismo que se acaba de medir
            const L = mejor ? mejor.lienzo : document.createElement('canvas');
            if (L.width !== video.videoWidth || L.height !== video.videoHeight) { L.width = video.videoWidth; L.height = video.videoHeight; }
            L.getContext('2d').drawImage(video, 0, 0, L.width, L.height);
            mejor = { lienzo: L, nitidez: m.nitidez, medidaAncho: m.ancho, ancho: L.width, alto: L.height, luz: m.luz, giro: g };
          }
          const firme = !conGiro || (g !== null && g < UMBRAL_QUIETO);
          quietoDesde = firme ? (quietoDesde === null ? ahora : quietoDesde) : null;
          const estado = firme ? 'quieto' : 'firme';
          if (estado !== aviso && opciones.alCambiar) { aviso = estado; opciones.alCambiar(estado); }
        }
        const t = ahora - inicio;
        const basta = conGiro ? quietoDesde !== null && ahora - quietoDesde >= 300 && cuadros >= 5 : t >= 700 && cuadros >= 6;
        if (cuadros && (basta || t >= max)) terminar(); else siguiente();
      };
      siguiente();
    });
  }

  return { escucharGiro, giroReciente, quieto, medir, luzDe, rafaga, hayGiro: () => giro.disponible, UMBRAL_QUIETO };
})();
