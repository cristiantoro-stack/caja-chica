/* Escáner: carga de fotos, detección del documento, recorte con corrección de perspectiva,
   mejora tipo "escaneo" (fondo blanco, texto oscuro) y unión de boletas largas fotografiadas por tramos.
   Todo ocurre en el teléfono. */
const Escaner = (() => {
  const MAX_PIX_FUENTE = 12.5e6, MAX_LADO_FUENTE = 8192;   // foto de trabajo: ~12 MP (las panorámicas no se achican de más)
  const MAX_CORTO = 2480, MAX_PIX_PAGINA = 9e6;             // página: hasta una hoja A4 a 300 ppp, sin agrandar
  const CALIDAD = 0.85, CALIDAD_TIRA = 0.88;
  const TIRA = { ancho: 2000, alto: 16000, pixeles: 18e6 };  // tope de la boleta larga unida
  const COMPLETA = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  function lienzo(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Libera la memoria de un canvas grande apenas deja de usarse (en el teléfono importa). */
  function soltar(c) {
    if (c) { c.width = 0; c.height = 0; }
  }

  async function decodificar(blob) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
      } catch (e2) {
        throw new Error('Formato de imagen no soportado (usa JPG o PNG)');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  }

  /** Imagen decodificada a un tamaño dado (sin pasar por el tamaño completo cuando el navegador lo permite). */
  async function decodificarA(blob, w, h) {
    try {
      return await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium', imageOrientation: 'from-image' });
    } catch (e) {
      const img = await decodificar(blob), c = lienzo(w, h), ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      if (img.close) img.close();
      return c;
    }
  }

  /** Imagen de trabajo como canvas, con tope por área (~12 MP). canvas.original = true si no se achicó. */
  async function cargar(blob) {
    const img = await decodificar(blob);
    const k = Math.min(1, Math.sqrt(MAX_PIX_FUENTE / (img.width * img.height)), MAX_LADO_FUENTE / Math.max(img.width, img.height));
    const c = lienzo(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    c.original = k === 1;
    return c;
  }

  function aJpeg(c, calidad) {
    return new Promise((ok, mal) => c.toBlob(b => (b ? ok(b) : mal(new Error('No se pudo comprimir la imagen'))),
      'image/jpeg', calidad || CALIDAD));
  }

  function escalar(c, ancho) {
    const k = Math.min(1, ancho / c.width), out = lienzo(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, out.width, out.height);
    return out;
  }

  // ---------- Detección del documento ----------

  function desenfocar(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / n;
        s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function otsuHistograma(hist) {
    let total = 0, suma = 0;
    for (let i = 0; i < hist.length; i++) { total += hist[i]; suma += i * hist[i]; }
    let sumaB = 0, pesoB = 0, mejor = 0, umbral = hist.length >> 1;
    for (let t = 0; t < hist.length; t++) {
      pesoB += hist[t];
      if (!pesoB) continue;
      const pesoF = total - pesoB;
      if (!pesoF) break;
      sumaB += t * hist[t];
      const mB = sumaB / pesoB, mF = (suma - sumaB) / pesoF, varianza = pesoB * pesoF * (mB - mF) * (mB - mF);
      if (varianza > mejor) { mejor = varianza; umbral = t; }
    }
    return umbral;
  }

  function otsu(valores) {
    const hist = new Float64Array(256);
    for (let i = 0; i < valores.length; i++) hist[Math.min(255, Math.max(0, valores[i] | 0))]++;
    return otsuHistograma(hist);
  }

  /** Componente conexo más grande de la máscara: lista de índices. */
  function mayorComponente(mascara, w, h) {
    const etiqueta = new Int32Array(w * h), cola = new Int32Array(w * h);
    let mejor = null, actual = 0;
    for (let i = 0; i < mascara.length; i++) {
      if (!mascara[i] || etiqueta[i]) continue;
      actual++;
      let ini = 0, fin = 0;
      cola[fin++] = i; etiqueta[i] = actual;
      while (ini < fin) {
        const p = cola[ini++], x = p % w, y = (p / w) | 0;
        if (x > 0 && mascara[p - 1] && !etiqueta[p - 1]) { etiqueta[p - 1] = actual; cola[fin++] = p - 1; }
        if (x < w - 1 && mascara[p + 1] && !etiqueta[p + 1]) { etiqueta[p + 1] = actual; cola[fin++] = p + 1; }
        if (y > 0 && mascara[p - w] && !etiqueta[p - w]) { etiqueta[p - w] = actual; cola[fin++] = p - w; }
        if (y < h - 1 && mascara[p + w] && !etiqueta[p + w]) { etiqueta[p + w] = actual; cola[fin++] = p + w; }
      }
      if (!mejor || fin > mejor.length) mejor = cola.slice(0, fin);
    }
    return mejor;
  }

  function areaCuadrilatero(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], s = q[(i + 1) % 4]; a += p.x * s.y - s.x * p.y; }
    return Math.abs(a) / 2;
  }

  /**
   * ¿El contorno del papel es un borde de verdad (papel contra mesa) o solo un cambio de luz sobre el mismo papel?
   * Compara el brillo a cada lado del contorno: con mesa la diferencia es grande; con una sombra suave, pequeña.
   */
  function bordeReal(comp, suave, w, h) {
    const n = w * h, doc = new Uint8Array(n), fuera = new Uint8Array(n), cola = new Int32Array(n);
    for (let i = 0; i < comp.length; i++) doc[comp[i]] = 1;
    // Exterior: lo que no es papel y toca el borde de la foto (las letras dentro del papel no cuentan)
    let fin = 0;
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const p = y * w + x; if (!doc[p] && !fuera[p]) { fuera[p] = 1; cola[fin++] = p; } }
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const p = y * w + x; if (!doc[p] && !fuera[p]) { fuera[p] = 1; cola[fin++] = p; } }
    for (let ini = 0; ini < fin;) {
      const p = cola[ini++], x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !doc[q] && !fuera[q]) { fuera[q] = 1; cola[fin++] = q; }
      }
    }
    if (!fin) return false;
    // Anillos de 2 px a cada lado del contorno
    let si = 0, ni = 0, so = 0, no = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        let vecinoFuera = false, vecinoDoc = false;
        for (let dy = -2; dy <= 2 && !(vecinoFuera && vecinoDoc); dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (fuera[yy * w + xx]) vecinoFuera = true; else vecinoDoc = true;
          }
        }
        if (fuera[p] && vecinoDoc) { so += suave[p]; no++; }
        else if (!fuera[p] && vecinoFuera) { si += suave[p]; ni++; }
      }
    }
    return ni > 0 && no > 0 && si / ni - so / no >= 30;
  }

  /** Recta x = a·y + b por mínimos cuadrados, descartando puntos sueltos (dedos, papel roto). */
  function ajustarRecta(puntos) {
    let usar = puntos;
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      if (usar.length < 12) return null;
      let sy = 0, sx = 0, syy = 0, sxy = 0;
      for (const [y, x] of usar) { sy += y; sx += x; syy += y * y; sxy += x * y; }
      const n = usar.length, den = n * syy - sy * sy;
      if (!den) return null;
      const a = (n * sxy - sx * sy) / den, b = (sx - a * sy) / n;
      if (vuelta === 1) return { a, b };
      const res = usar.map(([y, x]) => Math.abs(x - (a * y + b))).sort((p, q) => p - q);
      const limite = Math.max(1.5, 3 * res[res.length >> 1]);
      usar = usar.filter(([y, x]) => Math.abs(x - (a * y + b)) <= limite);
    }
    return null;
  }

  /**
   * Costado del papel con la precisión de la foto completa: cerca de la recta estimada en la imagen reducida
   * (x = a·y + b, escala k) busca fila por fila el salto de oscuro (mesa) a claro (papel) y ajusta una recta.
   * En fotos de cerca, un costado impreciso cambia el ancho de cada tramo y la boleta unida se ensancha.
   */
  function refinarCostado(fuente, recta, k, izquierdo, yIni, yFin) {
    const a = recta.a, b = recta.b / k, ventana = Math.ceil(4 / k), W = fuente.width;
    const Y0 = Math.max(2, Math.floor(yIni / k)), Y1 = Math.min(fuente.height - 3, Math.ceil(yFin / k));
    if (Y1 - Y0 < 40) return recta;
    const x0 = Math.max(0, Math.floor(Math.min(a * Y0 + b, a * Y1 + b)) - ventana - 4);
    const x1 = Math.min(W, Math.ceil(Math.max(a * Y0 + b, a * Y1 + b)) + ventana + 4), ancho = x1 - x0;
    if (ancho < 12) return recta;
    const datos = fuente.getContext('2d', { willReadFrequently: true }).getImageData(x0, Y0 - 2, ancho, Y1 - Y0 + 5).data;
    const lum = (x, y) => { const i = (y * ancho + x) * 4; return 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2]; };
    const puntos = [], perfil = new Float32Array(ancho), N = 60;
    const salto = x => { const v = perfil[x + 1] + perfil[x + 2] - perfil[x - 1] - perfil[x - 2]; return izquierdo ? v : -v; };
    for (let i = 0; i < N; i++) {
      const Y = Math.round(Y0 + (i + 0.5) * (Y1 - Y0) / N), yl = Y - Y0 + 2, xp = a * Y + b - x0;
      const lo = Math.max(3, Math.round(xp - ventana)), hi = Math.min(ancho - 4, Math.round(xp + ventana));
      if (hi <= lo) continue;
      for (let x = lo - 2; x <= hi + 2; x++) perfil[x] = (lum(x, yl - 2) + lum(x, yl - 1) + lum(x, yl) + lum(x, yl + 1) + lum(x, yl + 2)) / 5;
      let mejor = 0, pos = -1;
      for (let x = lo; x <= hi; x++) { const v = salto(x); if (v > mejor) { mejor = v; pos = x; } }
      if (pos < 0 || mejor < 30) continue;               // sin un salto claro en esta fila (dedo, sombra)
      const gm = pos > lo ? salto(pos - 1) : mejor, gp = pos < hi ? salto(pos + 1) : mejor, den = gm - 2 * mejor + gp;
      const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (gm - gp) / den)) : 0;
      puntos.push([Y, x0 + pos + delta + 0.5]);
    }
    const r = puntos.length >= N / 3 && ajustarRecta(puntos);
    return r ? { a: r.a, b: r.b * k } : recta;           // de vuelta a la imagen reducida
  }

  /**
   * Foto de cerca (la boleta se sale por arriba o por abajo): los bordes cortados no son los de la boleta.
   * Los costados se ajustan como rectas (afinadas en la foto completa) y el corte se hace perpendicular a ellos,
   * así los renglones quedan derechos. Un extremo que sí se ve (comienzo o final de la boleta) también se ajusta como recta.
   */
  function cuadroParcial(fuente, k, bordes, w, h, extremos, tocaArriba, tocaAbajo) {
    const { izq, der, arriba, abajo, yMin, yMax } = bordes;
    const margen = Math.round((yMax - yMin) * 0.06), filas = [];
    for (let y = yMin + margen; y <= yMax - margen; y++) if (der[y] >= 0) filas.push(y);
    if (filas.length < 12) return null;
    const tocaIzq = filas.filter(y => izq[y] <= 0).length > filas.length / 2;
    const tocaDer = filas.filter(y => der[y] >= w - 1).length > filas.length / 2;
    let L = tocaIzq ? { a: 0, b: 0 } : ajustarRecta(filas.filter(y => izq[y] > 0).map(y => [y, izq[y]]));
    let R = tocaDer ? { a: 0, b: w } : ajustarRecta(filas.filter(y => der[y] < w - 1).map(y => [y, der[y] + 1]));
    if (!L || !R || Math.abs(L.a) > 0.6 || Math.abs(R.a) > 0.6) return null;
    if (!tocaIzq) L = refinarCostado(fuente, L, k, true, yMin + margen, yMax - margen);
    if (!tocaDer) R = refinarCostado(fuente, R, k, false, yMin + margen, yMax - margen);
    const m = (L.a + R.a) / 2;                         // eje de la boleta: dirección (m, 1); corte: m·x + y = c
    const cruce = (e, c) => { const y = (c - m * e.b) / (1 + m * e.a); return [e.a * y + e.b, y]; };
    const enY = (e, y) => m * (e.a * y + e.b) + y;
    // Extremo visible: recta y = a·x + b por el borde superior (o inferior) del papel, lejos de las esquinas
    const extremo = (filaDe, y) => {
      const xa = L.a * y + L.b, xb = R.a * y + R.b, d = (xb - xa) * 0.12, pts = [];
      for (let x = Math.ceil(xa + d); x <= Math.floor(xb - d); x++) if (x >= 0 && x < w && filaDe[x] >= 0) pts.push([x, filaDe[x]]);
      const e = ajustarRecta(pts);
      if (!e) return null;
      const corte = lado => { const x = (lado.a * e.b + lado.b) / (1 - lado.a * e.a); return [x, e.a * x + e.b]; };
      return [corte(L), corte(R)];
    };
    let [tl, tr, br, bl] = extremos;
    if (tocaArriba) {
      const c = Math.max(enY(L, 0), enY(R, 0)) + 0.5;
      tl = cruce(L, c); tr = cruce(R, c);
    } else {
      const e = extremo(arriba, yMin);
      if (e) [tl, tr] = e;
    }
    if (tocaAbajo) {
      const c = Math.min(enY(L, h - 1), enY(R, h - 1)) - 0.5;
      bl = cruce(L, c); br = cruce(R, c);
    } else {
      const e = extremo(abajo, yMax);
      if (e) [bl, br] = e;
    }
    const q = [tl, tr, br, bl];
    if (q.some(([x, y]) => x < -2 || x > w + 1 || y < -2 || y > h + 1)) return null;
    return q;
  }

  /** Esquinas del documento [sup-izq, sup-der, inf-der, inf-izq] normalizadas 0..1, o null si no se distingue. */
  function detectar(fuente) {
    const k = 320 / Math.max(fuente.width, fuente.height);
    const w = Math.max(8, Math.round(fuente.width * k)), h = Math.max(8, Math.round(fuente.height * k));
    const c = lienzo(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(fuente, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, gris = new Float32Array(w * h);
    for (let i = 0, j = 0; j < gris.length; i += 4, j++) gris[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const suave = desenfocar(gris, w, h, 2), umbral = otsu(suave), mascara = new Uint8Array(w * h);
    for (let i = 0; i < mascara.length; i++) mascara[i] = suave[i] > umbral ? 1 : 0;
    const comp = mayorComponente(mascara, w, h);
    if (!comp || comp.length < 0.08 * w * h || comp.length > 0.97 * w * h) return null;
    if (!bordeReal(comp, suave, w, h)) return null;      // el papel llena la foto: lo "oscuro" es solo sombra

    const izq = new Int32Array(h).fill(w), der = new Int32Array(h).fill(-1);
    const arriba = new Int32Array(w).fill(-1), abajo = new Int32Array(w).fill(-1);
    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity, tl, tr, br, bl, yMin = h, yMax = -1;
    for (let i = 0; i < comp.length; i++) {
      const p = comp[i], x = p % w, y = (p / w) | 0, s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = [x, y]; }
      if (s > sMax) { sMax = s; br = [x, y]; }
      if (d > dMax) { dMax = d; tr = [x, y]; }
      if (d < dMin) { dMin = d; bl = [x, y]; }
      if (x < izq[y]) izq[y] = x;
      if (x > der[y]) der[y] = x;
      if (arriba[x] < 0 || y < arriba[x]) arriba[x] = y;
      if (y + 1 > abajo[x]) abajo[x] = y + 1;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    const extremos = [tl, tr, br, bl].map(([x, y]) => [x + 0.5, y + 0.5]);
    const tocaArriba = yMin <= 1, tocaAbajo = yMax >= h - 2;
    const bordes = { izq, der, arriba, abajo, yMin, yMax };
    const pts = (tocaArriba || tocaAbajo) && cuadroParcial(fuente, w / fuente.width, bordes, w, h, extremos, tocaArriba, tocaAbajo) || extremos;
    const q = pts.map(([x, y]) => ({ x: Math.min(1, Math.max(0, x / w)), y: Math.min(1, Math.max(0, y / h)) }));
    if (areaCuadrilatero(q) < 0.08) return null;
    // Se entra un poco hacia el centro para no arrastrar el borde de la mesa.
    const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
    return q.map(p => ({ x: p.x + (cx - p.x) * 0.012, y: p.y + (cy - p.y) * 0.012 }));
  }

  // ---------- Recorte con perspectiva ----------

  function resolver(A, b) {
    const n = b.length, M = A.map((fila, i) => fila.concat(b[i]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let f = c + 1; f < n; f++) if (Math.abs(M[f][c]) > Math.abs(M[piv][c])) piv = f;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let f = 0; f < n; f++) {
        if (f === c) continue;
        const factor = M[f][c] / M[c][c];
        for (let k = c; k <= n; k++) M[f][k] -= factor * M[c][k];
      }
    }
    return M.map((fila, i) => fila[n] / fila[i]);
  }

  /** Homografía que lleva el rectángulo destino (0,0)-(W,H) al cuadrilátero de origen. */
  function homografia(W, H, P) {
    const dst = [[0, 0], [W, 0], [W, H], [0, H]], A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dst[i], u = P[i].x, v = P[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    return resolver(A, b);
  }

  /** Tamaño de la página enderezada (sin agrandar; hasta A4 a 300 ppp) y la homografía hacia la foto. */
  function geometria(fuente, quad) {
    const sw = fuente.width, sh = fuente.height, P = quad.map(p => ({ x: p.x * sw, y: p.y * sh }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), H = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
    const k = Math.min(1, MAX_CORTO / Math.max(1, Math.min(W, H)), Math.sqrt(MAX_PIX_PAGINA / Math.max(1, W * H)));
    W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));
    // Solo se lee el rectángulo que contiene al documento: en fotos de 12 MP ahorra memoria y tiempo.
    const bx = Math.max(0, Math.floor(Math.min(...P.map(p => p.x))) - 1), by = Math.max(0, Math.floor(Math.min(...P.map(p => p.y))) - 1);
    const bw = Math.max(2, Math.min(sw, Math.ceil(Math.max(...P.map(p => p.x))) + 2) - bx);
    const bh = Math.max(2, Math.min(sh, Math.ceil(Math.max(...P.map(p => p.y))) + 2) - by);
    return { W, H, m: homografia(W, H, P), bx, by, bw, bh };
  }

  /**
   * Recorre la página destino fila por fila y entrega, para cada píxel, la posición en la zona leída de la foto.
   * A lo largo de una fila, numeradores y denominador de la homografía crecen linealmente con x.
   */
  function recorrer(g, alPixel) {
    const { W, H, m, bx, by, bw, bh } = g, maxU = bw - 1.001, maxV = bh - 1.001;
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5;
      let nu = m[0] * 0.5 + m[1] * yc + m[2], nv = m[3] * 0.5 + m[4] * yc + m[5], den = m[6] * 0.5 + m[7] * yc + 1;
      for (let x = 0, j = y * W; x < W; x++, j++, nu += m[0], nv += m[3], den += m[6]) {
        const inv = 1 / den;
        let u = nu * inv - 0.5 - bx, v = nv * inv - 0.5 - by;
        u = u < 0 ? 0 : u > maxU ? maxU : u;
        v = v < 0 ? 0 : v > maxV ? maxV : v;
        alPixel(j, u, v);
      }
    }
  }

  /** Página enderezada en color (canvas). */
  function enderezar(fuente, quad) {
    const g = geometria(fuente, quad), { W, H, bw } = g;
    const src = fuente.getContext('2d', { willReadFrequently: true }).getImageData(g.bx, g.by, bw, g.bh).data;
    const out = lienzo(W, H), octx = out.getContext('2d'), img = octx.createImageData(W, H), o = img.data, fila = bw * 4;
    recorrer(g, (j, u, v) => {
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = (y0 * bw + x0) * 4, k = j * 4;
      for (let c = 0; c < 3; c++) {
        const a = src[i + c] + (src[i + 4 + c] - src[i + c]) * fx;
        const b = src[i + fila + c] + (src[i + fila + 4 + c] - src[i + fila + c]) * fx;
        o[k + c] = a + (b - a) * fy;
      }
      o[k + 3] = 255;
    });
    octx.putImageData(img, 0, 0);
    return out;
  }

  /** Página enderezada en gris (luminancia 0..255): un solo canal, un tercio del trabajo. */
  function enderezarGris(fuente, quad) {
    const g = geometria(fuente, quad), { W, H, bw, bh } = g;
    const rgba = fuente.getContext('2d', { willReadFrequently: true }).getImageData(g.bx, g.by, bw, bh).data;
    const src = new Uint8Array(bw * bh);
    for (let i = 0, j = 0; j < src.length; i += 4, j++) src[j] = (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2] + 128) >> 8;
    const v = new Float32Array(W * H);
    recorrer(g, (j, u, w) => {
      const x0 = u | 0, y0 = w | 0, fx = u - x0, fy = w - y0, i = y0 * bw + x0;
      const a = src[i] + (src[i + 1] - src[i]) * fx, b = src[i + bw] + (src[i + bw + 1] - src[i + bw]) * fx;
      v[j] = a + (b - a) * fy;
    });
    return { W, H, v };
  }

  function girar(c, grados) {
    if (!grados) return c;
    const recto = grados % 180 !== 0, out = lienzo(recto ? c.height : c.width, recto ? c.width : c.height);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(grados * Math.PI / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
    soltar(c);
    return out;
  }

  // ---------- Mejora tipo escaneo ----------

  function maximoLocal(src, w, h, r) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const v = src[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
            if (v > m) m = v;
          }
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function percentil(valores, p) {
    const orden = Float32Array.from(valores).sort();
    return orden[Math.min(orden.length - 1, Math.max(0, Math.round(p * (orden.length - 1))))];
  }

  /** Desenfoque de caja con una sola copia grande (para imágenes de varios megapíxeles). */
  function desenfocarGrande(src, w, h, r) {
    const out = new Float32Array(w * h), n = 2 * r + 1, col = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      const f = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[f + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        out[f + x] = s / n;
        s += src[f + Math.min(w - 1, x + r + 1)] - src[f + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) col[y] = out[y * w + x];
      let s = 0;
      for (let y = -r; y <= r; y++) s += col[Math.min(h - 1, Math.max(0, y))];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / n;
        s += col[Math.min(h - 1, y + r + 1)] - col[Math.max(0, y - r)];
      }
    }
    return out;
  }

  /**
   * Fondo blanco y texto oscuro sin perder los trazos tenues del papel térmico (entra la luminancia, sale un canvas):
   * 1) divide por la luz estimada del papel (quita sombras), 2) realza bordes,
   * 3) niveles automáticos: el papel (con su textura) pasa a blanco y la tinta, aunque sea gris claro, a oscuro.
   */
  function mejorar({ W, H, v }) {
    const n = W * H;
    // 1) Luz del papel: máximo local en una grilla reducida, suavizado; con piso para que un logo grande no pase por papel
    let f = Math.max(4, Math.round(Math.sqrt(n) / 110));
    f = Math.max(1, Math.min(f, Math.floor(Math.min(W, H) / 4)));
    const w2 = Math.ceil(W / f), h2 = Math.ceil(H / f), peq = new Float32Array(w2 * h2);
    for (let y = 0; y < H; y++) {
      const fy = ((y / f) | 0) * w2;
      for (let x = 0, j = y * W; x < W; x++, j++) { const k = fy + ((x / f) | 0); if (v[j] > peq[k]) peq[k] = v[j]; }
    }
    const fondo = desenfocar(maximoLocal(peq, w2, h2, 2), w2, h2, 3);
    const piso = Math.max(30, 0.5 * percentil(peq, 0.9));
    for (let i = 0; i < fondo.length; i++) if (fondo[i] < piso) fondo[i] = piso;
    // Interpolación bilineal de la luz: pesos por columna una sola vez
    const cx0 = new Int32Array(W), cx1 = new Int32Array(W), tx = new Float32Array(W), filaLuz = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const fx = Math.min(w2 - 1, Math.max(0, x / f - 0.5));
      cx0[x] = fx | 0; cx1[x] = Math.min(w2 - 1, cx0[x] + 1); tx[x] = fx - cx0[x];
    }
    for (let y = 0; y < H; y++) {
      const fy = Math.min(h2 - 1, Math.max(0, y / f - 0.5)), y0 = fy | 0, y1 = Math.min(h2 - 1, y0 + 1), ty = fy - y0;
      const r0 = y0 * w2, r1 = y1 * w2;
      for (let x = 0; x < W; x++) {
        const a = fondo[r0 + cx0[x]] + (fondo[r0 + cx1[x]] - fondo[r0 + cx0[x]]) * tx[x];
        const b = fondo[r1 + cx0[x]] + (fondo[r1 + cx1[x]] - fondo[r1 + cx0[x]]) * tx[x];
        filaLuz[x] = 1 / (a + (b - a) * ty);
      }
      for (let x = 0, j = y * W; x < W; x++, j++) {
        const q = v[j] * filaLuz[x];
        v[j] = q > 1.25 ? 1.25 : q;
      }
    }

    // 2) Nitidez (máscara de enfoque suave) y 3) niveles automáticos desde el histograma de una muestra
    const r = Math.max(1, Math.round(Math.min(W, H) / 600)), borroso = desenfocarGrande(v, W, H, r);
    const B = 256, kb = (B - 1) / 1.25, hist = new Float64Array(B), salto = n > 2e6 ? 3 : 1;
    for (let j = 0; j < n; j += salto) {
      const q = (v[j] + 0.6 * (v[j] - borroso[j])) * kb;
      hist[q <= 0 ? 0 : q >= B - 1 ? B - 1 : q | 0]++;
    }
    const t = otsuHistograma(hist);
    let np = 0, sp = 0, spp = 0, ni = 0;
    for (let i = t; i < B; i++) { np += hist[i]; sp += i * hist[i]; spp += i * i * hist[i]; }
    for (let i = 0; i < t; i++) ni += hist[i];
    const mp = np ? sp / np : B - 1, dp = np ? Math.sqrt(Math.max(0, spp / np - mp * mp)) : 0;
    let blanco = Math.max(mp - 2 * dp, (t + mp) / 2);
    blanco = Math.min(blanco, mp - 0.01 * kb, 0.98 * kb);
    let negro = 0;
    if (ni < 0.002 * (np + ni)) {
      negro = blanco - 0.5 * kb;                        // casi sin tinta (hoja en blanco): solo se limpia el papel
    } else {
      let acum = 0;
      for (let i = 0; i < t; i++) { acum += hist[i]; if (acum >= 0.1 * ni) { negro = i; break; } }
    }
    negro = Math.max(0, Math.min(negro, blanco - 0.15 * kb));
    // Curva final en tabla (2048 tramos para v en 0..2): evita una potencia por píxel
    const n0 = negro / kb, rango = (blanco - negro) / kb, curva = new Uint8ClampedArray(2048);
    for (let i = 0; i < 2048; i++) {
      const y = (i / 1024 - n0) / rango;
      curva[i] = y <= 0 ? 0 : y >= 1 ? 255 : Math.round(Math.pow(y, 1.35) * 255);
    }
    const c = lienzo(W, H), ctx = c.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
    for (let j = 0, i = 0; j < n; j++, i += 4) {
      const q = (v[j] + 0.6 * (v[j] - borroso[j])) * 1024;
      d[i] = d[i + 1] = d[i + 2] = curva[q <= 0 ? 0 : q >= 2047 ? 2047 : q | 0];
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- Página completa ----------

  /** pagina: { quad, rot, modo } → { salida (JPEG), mini (JPEG), ancho, alto } */
  async function procesar(fuente, pagina) {
    const quad = pagina.quad || COMPLETA;
    let c = pagina.modo === 'color' ? enderezar(fuente, quad) : mejorar(enderezarGris(fuente, quad));
    c = girar(c, pagina.rot || 0);
    const mini = escalar(c, 260);
    const r = { salida: await aJpeg(c, CALIDAD), mini: await aJpeg(mini, 0.7), ancho: c.width, alto: c.height };
    soltar(mini);
    soltar(c);
    return r;
  }

  // ---------- Boletas largas: unión de fotos de cerca con traslape ----------

  /** Gris (0 negro … 255 blanco) de una imagen reducida a 'ancho' px. */
  function gris(img, ancho) {
    const w = Math.max(8, Math.round(ancho)), h = Math.max(8, Math.round(img.height * w / img.width));
    const c = lienzo(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, v = new Float32Array(w * h);
    for (let i = 0, j = 0; j < v.length; i += 4, j++) v[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    soltar(c);
    return { w, h, v };
  }

  /** Copia del gris a escala s (y, si se indica, otra escala vertical sy). Bilineal. */
  function escalarGris(g, s, sy) {
    const w = Math.max(4, Math.round(g.w * s)), h = Math.max(4, Math.round(g.h * (sy || s))), v = new Float32Array(w * h);
    const kx = g.w / w, ky = g.h / h;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(g.h - 1.001, Math.max(0, (y + 0.5) * ky - 0.5)), y0 = fy | 0, ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(g.w - 1.001, Math.max(0, (x + 0.5) * kx - 0.5)), x0 = fx | 0, tx = fx - x0, i = y0 * g.w + x0;
        const a = g.v[i] + (g.v[i + 1] - g.v[i]) * tx, b = g.v[i + g.w] + (g.v[i + g.w + 1] - g.v[i + g.w]) * tx;
        v[y * w + x] = a + (b - a) * ty;
      }
    }
    return { w, h, v };
  }

  /** Muestra de la columna x en la fila (fraccionaria) yo; fuera de la imagen es papel blanco. */
  function enFila(g, x, yo) {
    const y0 = Math.floor(yo);
    if (y0 < 0 || y0 + 1 >= g.h) return 255;
    const t = yo - y0, i = y0 * g.w + x;
    return g.v[i] + (g.v[i + g.w] - g.v[i]) * t;
  }

  /** Inclinación de los renglones: sh = tan α (α medido como cizalle, y_original = y + sh·(x − w/2); luego se gira). */
  function estimarCizalla(g) {
    const x0 = Math.round(g.w * 0.2), x1 = g.w - x0;
    const puntaje = sh => {
      const perfil = new Float64Array(g.h);
      for (let x = x0; x < x1; x++) {
        const desp = sh * (x - g.w / 2);
        for (let y = 0; y < g.h; y++) perfil[y] += 255 - enFila(g, x, y + desp);
      }
      let s = 0;
      for (let y = 0; y < g.h; y++) s += perfil[y] * perfil[y];
      return s;
    };
    const base = puntaje(0);
    let mejor = 0, mejorP = base;
    for (let sh = -0.08; sh <= 0.0801; sh += 0.005) { const p = puntaje(sh); if (p > mejorP) { mejorP = p; mejor = sh; } }
    const centro = mejor;
    for (let sh = centro - 0.004; sh <= centro + 0.0041; sh += 0.001) { const p = puntaje(sh); if (p > mejorP) { mejorP = p; mejor = sh; } }
    return mejorP > base * 1.002 ? Math.round(mejor * 1000) / 1000 : 0;
  }

  /**
   * Gira el gris para que los renglones (inclinados sh = tan α) queden horizontales. Es un giro de verdad y no un
   * cizalle: si dos fotos están giradas distinto, el cizalle dejaría las letras corridas de lado dentro del traslape.
   */
  function descizallar(g, sh) {
    if (!sh) return g;
    const a = Math.atan(sh), co = Math.cos(a), si = Math.sin(a), cx = g.w / 2, cy = g.h / 2, v = new Float32Array(g.w * g.h);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const u = cx + co * (x - cx) - si * (y - cy), w = cy + si * (x - cx) + co * (y - cy);
        const x0 = Math.floor(u), y0 = Math.floor(w);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= g.w || y0 + 1 >= g.h) { v[y * g.w + x] = 255; continue; }
        const tx = u - x0, ty = w - y0, i = y0 * g.w + x0;
        const p = g.v[i] + (g.v[i + 1] - g.v[i]) * tx, q = g.v[i + g.w] + (g.v[i + g.w + 1] - g.v[i + g.w]) * tx;
        v[y * g.w + x] = p + (q - p) * ty;
      }
    }
    return { w: g.w, h: g.h, v };
  }

  /** Banda de la plantilla en B: la primera desde arriba que tenga texto (una franja en blanco no sirve para calzar). */
  function bandaPlantilla(B) {
    const T = Math.max(8, Math.round(B.h * 0.09)), limite = Math.max(0, Math.round(B.h * 0.35) - T);
    const varianzas = [];
    for (let y0 = 0; y0 <= limite; y0 += 2) {
      let s = 0, ss = 0, n = 0;
      for (let y = y0; y < y0 + T; y++) for (let x = Math.round(B.w * 0.06); x < B.w - Math.round(B.w * 0.06); x++) {
        const t = B.v[y * B.w + x]; s += t; ss += t * t; n++;
      }
      varianzas.push({ y0, v: ss / n - (s / n) * (s / n) });
    }
    const max = Math.max(...varianzas.map(b => b.v));
    if (!(max > 25)) return null;
    const elegida = varianzas.find(b => b.v >= 0.3 * max);
    return { y0: elegida.y0, T };
  }

  /**
   * Distancia entre renglones (en filas): primer pico del parecido del perfil de tinta consigo mismo corrido.
   * Sirve para medir el traslape en renglones y para buscar repeticiones. Sin un pico claro, ~1/36 del alto.
   */
  function interlineado(G) {
    const x0 = Math.round(G.w * 0.06), x1 = G.w - x0, perfil = new Float64Array(G.h);
    for (let y = 0; y < G.h; y++) {
      let t = 0;
      for (let x = x0; x < x1; x++) t += 255 - G.v[y * G.w + x];
      perfil[y] = t;
    }
    const media = perfil.reduce((a, b) => a + b, 0) / G.h;
    let c0 = 0;
    for (let y = 0; y < G.h; y++) { perfil[y] -= media; c0 += perfil[y] * perfil[y]; }
    const porDefecto = Math.max(4, Math.round(G.h / 36));
    if (!c0) return porDefecto;
    const r = lag => { let s = 0; for (let y = 0; y + lag < G.h; y++) s += perfil[y] * perfil[y + lag]; return s / c0; };
    const desde = Math.max(3, Math.round(G.h * 0.01)), hasta = Math.round(G.h * 0.1);
    let antes = r(desde - 1), ahora = r(desde);
    for (let lag = desde; lag <= hasta; lag++) {
      const despues = r(lag + 1);
      if (ahora > antes && ahora >= despues && ahora > 0.2) return lag;
      antes = ahora; ahora = despues;
    }
    return porDefecto;
  }

  /**
   * Búsqueda gruesa: la parte de arriba de B recorriendo A (escala, desplazamiento lateral y vertical). Cerca del final
   * de A la plantilla se acorta a la zona común (hasta 'hmin' filas, ~1 renglón): así entran los traslapes chicos.
   */
  function buscarGrueso(A, B0, banda, hmin, sMin, sMax) {
    const W1 = A.w + 1, S1 = new Float64Array(W1 * (A.h + 1)), S2 = new Float64Array(W1 * (A.h + 1));
    for (let y = 0; y < A.h; y++) {
      let f1 = 0, f2 = 0;
      for (let x = 0; x < A.w; x++) {
        const a = A.v[y * A.w + x];
        f1 += a; f2 += a * a;
        S1[(y + 1) * W1 + x + 1] = S1[y * W1 + x + 1] + f1;
        S2[(y + 1) * W1 + x + 1] = S2[y * W1 + x + 1] + f2;
      }
    }
    const suma = (S, x0, y0, x1, y1) => S[y1 * W1 + x1] - S[y0 * W1 + x1] - S[y1 * W1 + x0] + S[y0 * W1 + x0];
    const mA = Math.round(A.w * 0.06), res = [];
    for (let s = sMin; s <= sMax * 1.001; s *= 1.035) {
      const B = escalarGris(B0, s), y0 = Math.round(banda.y0 * s), Tmax = Math.max(hmin, Math.round(banda.T * s));
      if (y0 + hmin > B.h) continue;
      const base = Math.round((A.w - B.w) / 2), rango = Math.round(A.w * 0.12), mB = Math.round(B.w * 0.06);
      for (let dx = -rango; dx <= rango; dx++) {
        const ox = base + dx, c0 = Math.max(mB, mA - ox), c1 = Math.min(B.w - mB, A.w - mA - ox);
        if (c1 - c0 < A.w * 0.4) continue;
        // Sumas acumuladas por fila de la plantilla, para recortarla a cualquier alto
        const tope = Math.min(Tmax, B.h - y0), ts = new Float64Array(tope + 1), tss = new Float64Array(tope + 1);
        for (let y = 0; y < tope; y++) {
          let f1 = 0, f2 = 0;
          for (let x = c0; x < c1; x++) { const t = B.v[(y0 + y) * B.w + x]; f1 += t; f2 += t * t; }
          ts[y + 1] = ts[y] + f1; tss[y + 1] = tss[y] + f2;
        }
        const oyMin = Math.max(-y0, Math.round(A.h * 0.03)), oyMax = A.h - y0 - hmin;
        for (let oy = oyMin; oy <= oyMax; oy++) {
          const T = Math.min(tope, A.h - oy - y0);
          if (T < hmin) continue;
          const n = T * (c1 - c0), st = ts[T], vt = tss[T] - st * st / n;
          if (vt <= 9 * n) continue;
          const ya = oy + y0, sa = suma(S1, c0 + ox, ya, c1 + ox, ya + T), va = suma(S2, c0 + ox, ya, c1 + ox, ya + T) - sa * sa / n;
          if (va <= 9 * n) continue;
          let sab = 0;
          for (let y = 0; y < T; y++) {
            const fa = (ya + y) * A.w + ox, fb = (y0 + y) * B.w;
            for (let x = c0; x < c1; x++) sab += A.v[fa + x] * B.v[fb + x];
          }
          res.push({ ncc: (sab - sa * st / n) / Math.sqrt(va * vt), s, ox, oy });
        }
      }
    }
    return res;
  }

  /** Correlación de toda la zona común: B (ya escalado) con su esquina superior izquierda en (ox, oy) de A. */
  function nccSolape(A, B, ox, oy, paso) {
    const x0 = Math.max(Math.round(A.w * 0.06), ox + Math.round(B.w * 0.06));
    const x1 = Math.min(A.w - Math.round(A.w * 0.06), ox + B.w - Math.round(B.w * 0.06));
    const y0 = Math.max(0, oy), y1 = Math.min(A.h, oy + B.h);
    if (x1 - x0 < A.w * 0.4 || y1 - y0 < 4) return -1;
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = y0; y < y1; y += paso) {
      const fa = y * A.w, fb = (y - oy) * B.w - ox;
      for (let x = x0; x < x1; x += paso) {
        const a = A.v[fa + x], b = B.v[fb + x];
        n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
      }
    }
    const va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    if (va <= 9 * n || vb <= 9 * n) return -1;          // zona casi en blanco: no informa
    return (sab - sa * sb / n) / Math.sqrt(va * vb);
  }

  /** La mejor correlación de la zona común moviendo B hasta r filas o columnas. */
  function mejorLocal(A, B, ox, oy, r) {
    let mejor = -1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) mejor = Math.max(mejor, nccSolape(A, B, ox + dx, oy + dy, 2));
    return mejor;
  }

  // Pasos del ajuste fino: [escala, proporción vertical, x, y]
  const VECINOS = [[0, 0, 0, 1], [0, 0, 0, -1], [0, 0, 1, 0], [0, 0, -1, 0], [1, 0, 0, 0], [-1, 0, 0, 0], [0, 1, 0, 0], [0, -1, 0, 0],
    [0, 0, 1, 1], [0, 0, -1, -1], [0, 0, 1, -1], [0, 0, -1, 1], [0, 1, 0, -1], [0, -1, 0, 1]];

  /**
   * Ajuste fino por ascenso: escala, proporción vertical (una foto inclinada estira o encoge el alto),
   * desplazamiento lateral y vertical, hasta que la correlación deja de mejorar.
   */
  function refinar(A, Bbase, ini, paso, pasoEscala) {
    const cache = new Map();
    const escalado = (s, ay) => {
      const k = s.toFixed(4) + '|' + ay.toFixed(4);
      if (!cache.has(k)) cache.set(k, escalarGris(Bbase, s, s * ay));
      return cache.get(k);
    };
    const ay0 = ini.ay || 1;
    let mejor = Object.assign({}, ini, { ay: ay0, ncc: nccSolape(A, escalado(ini.s, ay0), ini.ox, ini.oy, paso) });
    for (let it = 0; it < 40; it++) {
      let cambio = false;
      for (const [ds, da, dx, dy] of VECINOS) {
        const c = { s: mejor.s * (1 + ds * pasoEscala), ay: mejor.ay * (1 + da * pasoEscala * 0.5), ox: mejor.ox + dx, oy: mejor.oy + dy };
        if (Math.abs(c.ay - 1) > 0.08) continue;
        const v = nccSolape(A, escalado(c.s, c.ay), c.ox, c.oy, paso);
        if (v > mejor.ncc + 1e-6) { mejor = Object.assign(c, { ncc: v }); cambio = true; }
      }
      if (!cambio) break;
    }
    return mejor;
  }

  // Calce aceptado. Regla de oro: una unión nunca puede quitar renglones que no estén repetidos. Creer que el
  // traslape es mayor de lo que es borra renglones; creerlo menor solo los repite (inofensivo). Por eso:
  // - correlación mínima en la búsqueda y de toda la zona común en fino;
  // - cada renglón de la zona común debe coincidir letra por letra (franja; algo menos el primero y el último, junto al
  //   borde de una foto) y uno con texto en una foto y blanco en la otra rechaza;
  // - ninguna otra altura (otro candidato, o corrida 1–2 renglones) puede quedar cerca; con menos traslape se exige más;
  // - traslape entre 1,4 renglones y 80 % de la foto. Lo que no pasa se pone una tras otra (no se pierde nada).
  const UMBRAL = {
    busqueda: 0.45, fina: 0.75, franja: 0.75, franjaPunta: 0.6, rival: 0.1, rivalMenor: 0.15, renglones: 1.4, traslapeMax: 0.8,
    dudosa: { ncc: 0.85, margen: 0.2, franja: 0.8 }    // aceptada, pero conviene que la persona la mire
  };

  /**
   * Revisión renglón por renglón de la zona común (resolución fina, franjas de ~1 renglón). Una franja con texto en una
   * foto y en blanco en la otra, o con texto distinto, rechaza. Si el traslape estimado fuera mayor que el real, todas
   * las franjas compararían renglones distintos. Se omite un cuarto de renglón en cada punta (borde de la foto, el más
   * deformado, que nunca se muestra porque el corte va al medio). Devuelve { ok, peor, n } (n = franjas con texto).
   */
  function franjasSolape(A, B, ox, oy, renglon) {
    const recorte = Math.round(renglon / 4), alto = Math.max(4, Math.round(renglon)), r = Math.max(2, Math.round(renglon * 0.12));
    const y0 = Math.max(0, oy) + recorte, y1 = Math.min(A.h, oy + B.h) - recorte;
    const x0 = Math.max(Math.round(A.w * 0.06), ox + Math.round(B.w * 0.06));
    const x1 = Math.min(A.w - Math.round(A.w * 0.06), ox + B.w - Math.round(B.w * 0.06));
    if (y1 - y0 < 4 || x1 - x0 < A.w * 0.4) return { ok: false, peor: 0, n: 0 };
    let peor = 1, n = 0;
    for (let ya = y0; ya < y1;) {
      let yb = Math.min(y1, ya + alto);
      if (y1 - yb < alto / 2) yb = y1;                   // el resto chico va en la última franja
      const punta = ya === y0 || yb === y1;              // primera o última: junto al borde de una foto (más deformado)
      // Cada franja se compara con un corrimiento local de hasta ~0,12 renglón (el borde de una foto se deforma
      // un poco); nunca alcanza para confundir un renglón con el siguiente.
      let mejor = null;
      const medir = (dy, dx) => {
        // Correlación con la media de cada fila descontada: queda solo el dibujo de las letras a lo largo del
        // renglón (dos renglones distintos con la misma letra y el mismo largo se parecen mucho si no)
        let m = 0, va = 0, vb = 0, cov = 0;
        for (let y = ya; y < yb; y++) {
          const yB = y - oy - dy;
          if (yB < 0 || yB >= B.h) continue;
          const fa = y * A.w, fb = yB * B.w - ox - dx, xi = Math.max(x0, ox + dx), xf = Math.min(x1, ox + dx + B.w);
          let k = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
          for (let x = xi; x < xf; x++) {
            const a = A.v[fa + x], b = B.v[fb + x];
            k++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
          }
          if (!k) continue;
          m += k; va += saa - sa * sa / k; vb += sbb - sb * sb / k; cov += sab - sa * sb / k;
        }
        if (m < 16) return;
        va = Math.max(0, va); vb = Math.max(0, vb);
        const c = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
        if (!mejor || c > mejor.c) mejor = { c, da: Math.sqrt(va / m), db: Math.sqrt(vb / m), dy, dx };
      };
      for (let dy = -r; dy <= r; dy++) medir(dy, 0);
      if (mejor) { const dy = mejor.dy; for (let dx = -r; dx <= r; dx++) if (dx) medir(dy, dx); }
      ya = yb;
      if (!mejor) continue;
      const { c, da, db } = mejor;
      if (da < 10 && db < 10) continue;                  // blanco en ambas
      if ((da >= 22 && db < 10) || (db >= 22 && da < 10)) return { ok: false, peor: 0, n };
      if (da < 10 || db < 10) continue;                  // muy poco texto: no decide
      peor = Math.min(peor, c);
      n++;
      if (c < (punta ? UMBRAL.franjaPunta : UMBRAL.franja)) return { ok: false, peor: c, n };
    }
    return { ok: n > 0, peor, n };
  }

  /**
   * Fila de A donde conviene cortar (B ya escalado, con su esquina en ox, oy): la más blanca en ambas fotos dentro
   * de la parte central del traslape. Cortar entre renglones esconde cualquier diferencia de un par de píxeles.
   */
  function corteLimpio(A, B, ox, oy) {
    const y0 = Math.max(0, oy), y1 = Math.min(A.h, oy + B.h), largo = y1 - y0;
    const x0 = Math.max(Math.round(A.w * 0.06), ox + Math.round(B.w * 0.06));
    const x1 = Math.min(A.w - Math.round(A.w * 0.06), ox + B.w - Math.round(B.w * 0.06));
    if (largo < 6 || x1 <= x0) return y0 + largo / 2;
    const tinta = new Float64Array(largo);
    for (let y = y0; y < y1; y++) {
      let t = 0;
      for (let x = x0; x < x1; x++) t += 510 - A.v[y * A.w + x] - B.v[(y - oy) * B.w + x - ox];
      tinta[y - y0] = t;
    }
    const desde = Math.round(largo * 0.15), hasta = Math.round(largo * 0.85), medio = largo / 2;
    let mejor = medio, valor = Infinity;
    for (let i = Math.max(2, desde); i <= Math.min(largo - 3, hasta); i++) {
      // franja de 5 filas; a igual blancura, la más cercana al medio
      const v = tinta[i - 2] + tinta[i - 1] + tinta[i] + tinta[i + 1] + tinta[i + 2] + Math.abs(i - medio) * 0.02 * (x1 - x0);
      if (v < valor) { valor = v; mejor = i; }
    }
    return y0 + mejor + 0.5;
  }

  /** Los de mayor correlación, sin repetir alturas (dos a menos de 'd' filas son el mismo calce). */
  function unicos(lista, d) {
    const out = [];
    lista.slice().sort((p, q) => q.ncc - p.ncc).forEach(c => { if (out.every(o => Math.abs(o.oy - c.oy) >= d)) out.push(c); });
    return out;
  }

  const redondear = v => Math.round(v * 1000) / 1000;

  /**
   * Dónde va la página b bajo la página a. Devuelve { ok, dudosa, s, ay, ox, oy, corte, ncc, margen, solape, motivo }:
   * s = ancho de b en anchos de a; ay = proporción vertical de b respecto de a; ox, oy = esquina sup-izq de b y
   * corte = fila donde se pasa de a a b, en píxeles de a divididos por el ancho de a; ncc = correlación de la zona común.
   * ok = false si no hay un calce seguro: esas dos fotos se ponen una tras otra (motivo dice por qué).
   */
  function calzar(a, b) {
    const pasos = pasosCalce(a, b);
    let paso = pasos.next();
    while (!paso.done) paso = pasos.next();
    return paso.value;
  }

  /** El calce en etapas: cada yield es un buen momento para ceder el turno a la pantalla (o cancelar). */
  function* pasosCalce(a, b) {
    const banda = bandaPlantilla(b.c);
    if (!banda) return { ok: false, motivo: 'sin_texto', ncc: 0, margen: 0, solape: 0 };
    const cerca = yield* calzarEntre(a, b, banda, 0.9, 1.11);
    if (cerca.ok || cerca.motivo !== 'sin_calce') return cerca;
    yield;
    return yield* calzarEntre(a, b, banda, 0.6, 1.62);
  }

  function* calzarEntre(a, b, banda, sMin, sMax) {
    const kc = a.c.w / a.f.w, km = a.m.w / a.f.w;
    const todos = buscarGrueso(a.c, b.c, banda, Math.max(3, Math.round(a.paso * kc)), sMin, sMax);
    yield;
    const porAltura = new Map();
    for (const c of todos) { const p = porAltura.get(c.oy); if (!p || c.ncc > p.ncc) porAltura.set(c.oy, c); }
    const lista = [...porAltura.values()].sort((p, q) => q.ncc - p.ncc), cands = [];
    const agregar = c => { if (cands.every(d => Math.abs(d.oy - c.oy) >= 2)) cands.push(c); };
    for (const c of lista) { if (cands.length >= 9) break; agregar(c); }
    // Los traslapes chicos se miden con menos filas y pueden quedar abajo en la lista: los 4 mejores entran siempre
    lista.filter(c => a.c.h - c.oy <= a.c.h * 0.15).slice(0, 4).forEach(agregar);
    if (!cands.length) return { ok: false, motivo: 'sin_calce', ncc: 0, margen: 0, solape: 0 };

    const fm = a.m.w / a.c.w, refinados = [];
    for (const c of cands) {
      refinados.push(refinar(a.m, b.m, { s: c.s, ox: Math.round(c.ox * fm), oy: Math.round(c.oy * fm) }, 2, 0.01));
      if (refinados.length % 4 === 0) yield;
    }
    const medios = unicos(refinados, 0.5 * a.paso * km);
    const mejor = medios[0];
    const r = { ok: false, ncc: redondear(mejor.ncc), margen: 0, solape: redondear((a.m.h - mejor.oy) / a.m.h) };
    if (!(mejor.ncc >= UMBRAL.busqueda)) return Object.assign(r, { motivo: 'sin_calce' });

    // Resolución fina (las dos al mismo ancho): se ajustan el mejor y los que quedaron cerca, y se comparan ahí
    let Af = a.f, Bf = b.f;
    if (Af.w !== Bf.w) {
      const w = Math.min(Af.w, Bf.w);
      Af = Af.w > w ? escalarGris(Af, w / Af.w) : Af;
      Bf = Bf.w > w ? escalarGris(Bf, w / Bf.w) : Bf;
    }
    const ff = Af.w / a.m.w, renglon = a.paso * Af.w / a.f.w;
    // El mejor se ajusta del todo; los que quedaron cerca, con un ajuste local a su propia escala (basta para compararlos)
    const fino = refinar(Af, Bf, { s: mejor.s, ay: mejor.ay, ox: Math.round(mejor.ox * ff), oy: Math.round(mejor.oy * ff) }, 2, 0.003);
    yield;
    const rivales = medios.slice(1).filter(m => m.ncc >= mejor.ncc - 0.25).slice(0, 3).map(m => ({
      oy: Math.round(m.oy * ff), ncc: mejorLocal(Af, escalarGris(Bf, m.s, m.s * m.ay), Math.round(m.ox * ff), Math.round(m.oy * ff), 2)
    }));
    const finos = unicos([fino].concat(rivales), 0.5 * renglon), f = fino;
    yield;
    Object.assign(r, { ncc: redondear(f.ncc), solape: redondear((Af.h - f.oy) / Af.h) });
    // ¿Otra altura casi igual de buena? Quedarse con la de más traslape quitaría renglones: con menos traslape se exige más.
    let margen = 1;
    const empata = (ncc, menos) => {
      const v = f.ncc - ncc;
      margen = Math.min(margen, v);
      return v < (menos ? UMBRAL.rivalMenor : UMBRAL.rival);
    };
    for (const o of finos) {
      if (o !== f && empata(o.ncc, o.oy > f.oy)) return Object.assign(r, { motivo: 'ambiguo', margen: redondear(margen) });
    }
    // Renglones repetidos: corrido 1 o 2 renglones (más o menos traslape) no puede calzar casi igual
    const Bx = escalarGris(Bf, f.s, f.s * f.ay);
    for (const k of [-2, -1, 1, 2]) {
      const oy = f.oy + Math.round(k * renglon);
      if (oy < 0 || Af.h - oy < renglon * 0.8) continue;
      if (empata(mejorLocal(Af, Bx, f.ox, oy, 2), k > 0)) return Object.assign(r, { motivo: 'repetido', margen: redondear(margen) });
    }
    r.margen = redondear(margen);
    yield;
    const h = Af.h - f.oy;
    if (h < UMBRAL.renglones * renglon || h > UMBRAL.traslapeMax * Af.h) return Object.assign(r, { motivo: 'traslape' });
    if (f.ncc < UMBRAL.fina) return Object.assign(r, { motivo: 'no_coincide' });
    const fr = franjasSolape(Af, Bx, f.ox, f.oy, renglon);
    if (!fr.ok) return Object.assign(r, { motivo: 'renglon_distinto' });
    const D = UMBRAL.dudosa, corte = corteLimpio(Af, Bx, f.ox, f.oy);
    return Object.assign(r, {
      ok: true, dudosa: f.ncc < D.ncc || margen < D.margen || fr.peor < D.franja,
      s: f.s, ay: f.ay, ox: f.ox / Af.w, oy: f.oy / Af.w, corte: corte / Af.w
    });
  }

  /**
   * Rectángulo de la boleta dentro de la tira: solo quita lo que se parece a la MESA. La mesa se reconoce a los
   * costados (franjas sin papel); arriba y abajo solo se quitan filas parecidas a esa mesa y donde no asoma papel ni
   * letras blancas (logo invertido, timbre). Sin mesa a los costados, o ante la duda, la tira completa.
   */
  function recorteAuto(c) {
    const completo = { x0: 0, y0: 0, x1: 1, y1: 1 }, { w, h, v } = gris(c, 160);
    if (w < 16 || h < 16) return completo;
    const suavizar = (a, r) => a.map((_, i) => {
      let s = 0, n = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(a.length - 1, i + r); k++) { s += a[k]; n++; }
      return s / n;
    });
    const col = new Array(w).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (v[y * w + x] > 200) col[x]++;
    const cs = suavizar(col.map(n => n / h), 1), max = Math.max(...cs);
    if (max < 0.6) return completo;
    const uc = Math.max(0.55, max - 0.25);
    let x0 = 0, x1 = w;
    while (x0 < w - 1 && cs[x0] < uc) x0++;
    while (x1 > x0 + 1 && cs[x1 - 1] < uc) x1--;
    // Mesa a los costados: al menos 3 % del ancho y claramente sin papel
    const minimo = Math.max(2, Math.round(w * 0.03)), promedio = (a, b) => cs.slice(a, b).reduce((s, x) => s + x, 0) / Math.max(1, b - a);
    const izq = x0 >= minimo && promedio(0, x0) <= 0.5, der = w - x1 >= minimo && promedio(x1, w) <= 0.5;
    if (!izq && !der) return completo;
    if (!izq) x0 = 0;
    if (!der) x1 = w;
    // Arriba y abajo: fila de mesa = sin papel a la vista (4 px blancos seguidos), sin más blanco que la mesa
    // del costado en esa fila (letras blancas) y con un gris parecido al de esa mesa
    const lados = [];
    if (izq) lados.push([0, x0]);
    if (der) lados.push([x1, w]);
    const esMesa = y => {
      let seguidos = 0, sF = 0, blancosF = 0, sL = 0, nL = 0, blancosL = 0;
      for (let x = x0; x < x1; x++) {
        const g = v[y * w + x];
        sF += g;
        if (g > 200) { blancosF++; if (++seguidos >= 4) return false; } else seguidos = 0;
      }
      for (const [a, b] of lados) for (let x = a; x < b; x++) { const g = v[y * w + x]; sL += g; nL++; if (g > 200) blancosL++; }
      const ancho = x1 - x0;
      return blancosF / ancho <= blancosL / nL + 0.1 && Math.abs(sF / ancho - sL / nL) <= 30;
    };
    const tope = Math.round(h * 0.15);
    let y0 = 0, y1 = h;
    while (y0 < tope && esMesa(y0)) y0++;
    while (y1 > h - tope && esMesa(y1 - 1)) y1--;
    const r = { x0: x0 / w, y0: y0 / h, x1: x1 / w, y1: y1 / h };
    if (r.x1 - r.x0 < 0.3) return completo;
    Object.keys(r).forEach(k => { r[k] = Math.round(r[k] * 10000) / 10000; });
    return r;
  }

  // Calces y análisis recientes por página (clave = id+versión que pone la app). La app vuelve a unir tras cada foto:
  // así solo se calcula el par nuevo.
  const memoria = { pares: new Map(), paginas: new Map(), cizalla: new Map() };
  function recordar(mapa, clave, valor, max) {
    mapa.delete(clave);
    mapa.set(clave, valor);
    while (mapa.size > max) mapa.delete(mapa.keys().next().value);
  }

  /** Cede el turno al navegador (una tarea nueva, sin la espera mínima de setTimeout): la pantalla sigue respondiendo. */
  function pausa() {
    return new Promise(ok => {
      if (typeof MessageChannel === 'undefined') { setTimeout(ok, 0); return; }
      const canal = new MessageChannel();
      canal.port1.onmessage = () => { canal.port1.close(); ok(); };
      canal.port2.postMessage(0);
    });
  }

  /** Grises reducidos (≤ 640 px de ancho), inclinación e interlineado de una página, para calzarla con sus vecinas. */
  async function analizar(p, it) {
    const kb = Math.min(1, 640 / it.w);
    const base = await decodificarA(p.salida, Math.max(1, Math.round(it.w * kb)), Math.max(1, Math.round(it.h * kb)));
    it.sh = estimarCizalla(gris(base, 240));
    it.c = descizallar(gris(base, 96), it.sh);
    it.m = descizallar(gris(base, 192), it.sh);
    it.f = descizallar(gris(base, base.width), it.sh);
    it.paso = interlineado(it.f);
    if (base.close) base.close(); else soltar(base);
  }

  /**
   * Une varias páginas en una sola imagen vertical (boleta larga fotografiada de arriba hacia abajo).
   * modo 'auto': busca el traslape entre fotos seguidas y lo quita solo si el calce es seguro; si no, esas dos fotos
   * quedan una tras otra (uniones[i].ok = false; nunca se pierde texto). dudosa = unida, pero conviene mirarla.
   * modo 'simple': una tras otra al mismo ancho. opciones.cancelado(): si devuelve true entre pasos, se deja y
   * se entrega null. Las páginas pueden traer 'clave' (id + versión) para reutilizar lo ya calculado.
   */
  async function unirTira(paginas, opciones) {
    const o = opciones || {}, modo = o.modo === 'simple' ? 'simple' : 'auto';
    const cancelado = () => typeof o.cancelado === 'function' && !!o.cancelado();
    if (!paginas || !paginas.length) throw new Error('No hay páginas para unir');
    const auto = modo === 'auto' && paginas.length > 1;
    const info = [];
    for (const p of paginas) {
      const it = { w: p.ancho, h: p.alto, sh: 0, clave: p.clave ? String(p.clave) : '' };
      if (!(it.w > 0 && it.h > 0)) {
        const img = await decodificar(p.salida);
        it.w = img.width; it.h = img.height;
        if (img.close) img.close();
      }
      info.push(it);
    }
    const preparar = async i => {
      const it = info[i];
      if (it.f) return;
      const guardado = it.clave && memoria.paginas.get(it.clave);
      if (guardado) { Object.assign(it, guardado); return; }
      await analizar(paginas[i], it);
      if (it.clave) {
        recordar(memoria.paginas, it.clave, { sh: it.sh, c: it.c, m: it.m, f: it.f, paso: it.paso }, 6);
        recordar(memoria.cizalla, it.clave, it.sh, 200);
      }
      await pausa();
    };

    // Posición de cada página en un marco común (unidad = ancho de la primera). AY: proporción vertical acumulada.
    const pos = [{ X: 0, Y: 0, S: 1, AY: 1 }], uniones = [];
    for (let i = 1; i < info.length; i++) {
      if (cancelado()) return null;
      const a = info[i - 1], pa = pos[i - 1];
      let r = null;
      if (auto) {
        const clave = a.clave && info[i].clave ? a.clave + '|' + info[i].clave + '|' + modo : '';
        r = clave ? memoria.pares.get(clave) : null;
        if (!r) {
          await preparar(i - 1);
          await preparar(i);
          const pasos = pasosCalce(a, info[i]);
          let paso = pasos.next();
          while (!paso.done) {
            await pausa();
            if (cancelado()) return null;
            paso = pasos.next();
          }
          r = paso.value;
          if (clave) recordar(memoria.pares, clave, r, 40);
          await pausa();
        }
      }
      if (r && r.ok) {
        pos.push({ X: pa.X + pa.S * r.ox, Y: pa.Y + pa.S * pa.AY * r.oy, S: pa.S * r.s, AY: pa.AY * r.ay, corte: pa.Y + pa.S * pa.AY * r.corte });
      } else {
        const Y = pa.Y + pa.S * pa.AY * a.h / a.w;
        pos.push({ X: pa.X, Y, S: pa.S, AY: pa.AY, corte: Y });
      }
      uniones.push(!auto ? { ok: true, simple: true }
        : r.ok ? { ok: true, dudosa: !!r.dudosa, confianza: r.ncc, margen: r.margen, solape: r.solape }
          : { ok: false, confianza: r.ncc, margen: r.margen, solape: 0, motivo: r.motivo });
    }
    // Inclinación para dibujar: la de esta vuelta, la recordada o se calcula
    if (auto) {
      for (let i = 0; i < info.length; i++) {
        const it = info[i];
        if (it.f) continue;
        const sh = it.clave ? memoria.cizalla.get(it.clave) : undefined;
        if (sh !== undefined) it.sh = sh; else await preparar(i);
      }
    }
    info.forEach(it => { delete it.c; delete it.m; delete it.f; });
    if (cancelado()) return null;

    // Tamaño final: la resolución de la página más nítida, dentro de los topes
    const alto = i => pos[i].S * pos[i].AY * info[i].h / info[i].w;
    const xMin = Math.min(...pos.map(p => p.X)), xMax = Math.max(...pos.map(p => p.X + p.S));
    const yMin = Math.min(...pos.map(p => p.Y)), yMax = Math.max(...pos.map((p, i) => p.Y + alto(i)));
    const fw = xMax - xMin, fh = yMax - yMin;
    let P = Math.max(...info.map((it, i) => it.w / pos[i].S));
    P = Math.min(P, TIRA.ancho / fw, TIRA.alto / fh, Math.sqrt(TIRA.pixeles / (fw * fh)));
    const W = Math.max(1, Math.round(P * fw)), H = Math.max(1, Math.round(P * fh));
    const c = lienzo(W, H), ctx = c.getContext('2d');
    // Copia chica dibujada a la par: de ella sale el recorte sugerido sin releer la tira grande
    const wc = Math.min(160, W), chica = lienzo(wc, Math.max(1, Math.round(H * wc / W))), ctxc = chica.getContext('2d');
    for (const [cx, k] of [[ctx, 1], [ctxc, wc / W]]) {
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, W * k, H * k);
      cx.imageSmoothingQuality = 'high';
    }

    // Cada página (con los renglones enderezados) se dibuja desde su corte con la anterior
    for (let i = 0; i < paginas.length; i++) {
      if (cancelado()) { soltar(c); soltar(chica); return null; }
      const it = info[i], p = pos[i], k = p.S * P / it.w;
      const img = await decodificar(paginas[i].salida);
      const ki = k * it.w / img.width, kiy = ki * p.AY * (it.h / it.w) / (img.height / img.width);
      const tx = (p.X - xMin) * P, ty = (p.Y - yMin) * P;
      for (const [cx, e] of [[ctx, 1], [ctxc, wc / W]]) {
        cx.save();
        if (i > 0) {
          const yc = Math.max(0, (p.corte - yMin) * P * e);
          cx.beginPath();
          cx.rect(0, yc, W * e, H * e - yc);
          cx.clip();
        }
        // Giro alrededor del centro de la foto (renglones derechos), luego escala (con su proporción vertical) y posición
        const ang = Math.atan(it.sh), co = Math.cos(ang), si = Math.sin(ang), mx = img.width / 2, my = img.height / 2;
        cx.setTransform(ki * co * e, -kiy * si * e, ki * si * e, kiy * co * e,
          (tx + ki * (mx - co * mx - si * my)) * e, (ty + kiy * (my + si * mx - co * my)) * e);
        cx.drawImage(img, 0, 0);
        cx.restore();
      }
      if (img.close) img.close();
    }
    const recorteSugerido = auto ? recorteAuto(chica) : { x0: 0, y0: 0, x1: 1, y1: 1 };
    soltar(chica);
    if (cancelado()) { soltar(c); return null; }
    const salida = await aJpeg(c, CALIDAD_TIRA);
    soltar(c);
    return { salida, ancho: W, alto: H, uniones, recorteSugerido, modo };
  }

  /** Recorta la tira (u otra imagen) al rectángulo normalizado { x0, y0, x1, y1 }. */
  async function recortar(tira, recorte) {
    const img = await decodificar(tira.salida), r = recorte || {};
    // Un valor que no es número toma el borde completo; si vienen invertidos, se ordenan
    const lim = (v, defecto) => { const n = v === null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : defecto; };
    const [fx0, fx1] = [lim(r.x0, 0), lim(r.x1, 1)].sort((a, b) => a - b), [fy0, fy1] = [lim(r.y0, 0), lim(r.y1, 1)].sort((a, b) => a - b);
    const x0 = Math.min(img.width - 1, Math.round(fx0 * img.width)), y0 = Math.min(img.height - 1, Math.round(fy0 * img.height));
    const x1 = Math.max(x0 + 1, Math.round(fx1 * img.width)), y1 = Math.max(y0 + 1, Math.round(fy1 * img.height));
    const c = lienzo(x1 - x0, y1 - y0);
    c.getContext('2d').drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    if (img.close) img.close();
    const salida = await aJpeg(c, CALIDAD_TIRA), res = { salida, ancho: c.width, alto: c.height };
    soltar(c);
    return res;
  }

  /** Copia más liviana (para leer el texto en el servidor): a lo más maxPixeles; si ya es menor, el mismo archivo. */
  async function reducir(blob, maxPixeles, calidad) {
    const img = await decodificar(blob), k = Math.min(1, Math.sqrt(maxPixeles / (img.width * img.height)));
    if (k >= 1) { if (img.close) img.close(); return blob; }
    const c = lienzo(Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))), ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    const r = await aJpeg(c, calidad || CALIDAD);
    soltar(c);
    return r;
  }

  return { COMPLETA, cargar, detectar, procesar, unirTira, recortar, reducir, aJpeg, escalar };
})();
