/* Escáner: carga de fotos, detección del documento, recorte con corrección de perspectiva
   y mejora tipo "escaneo" (fondo blanco, texto oscuro). Todo ocurre en el teléfono. */
const Escaner = (() => {
  const MAX_FUENTE = 2400;                         // lado mayor de la imagen de trabajo
  const MAX_ANCHO = 1400, MAX_ALTO = 2200;         // tamaño máximo de cada página del PDF
  const COMPLETA = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  function lienzo(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
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

  /** Imagen de trabajo (lado mayor ≤ 2400 px) como canvas. */
  async function cargar(blob) {
    const img = await decodificar(blob);
    const k = Math.min(1, MAX_FUENTE / Math.max(img.width, img.height));
    const c = lienzo(Math.round(img.width * k), Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    if (img.close) img.close();
    return c;
  }

  function aJpeg(c, calidad) {
    return new Promise((ok, mal) => c.toBlob(b => (b ? ok(b) : mal(new Error('No se pudo comprimir la imagen'))),
      'image/jpeg', calidad || 0.72));
  }

  function escalar(c, ancho) {
    const k = Math.min(1, ancho / c.width), out = lienzo(Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
    out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
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

  function otsu(valores) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < valores.length; i++) hist[Math.min(255, Math.max(0, valores[i] | 0))]++;
    const total = valores.length;
    let suma = 0;
    for (let i = 0; i < 256; i++) suma += i * hist[i];
    let sumaB = 0, pesoB = 0, mejor = 0, umbral = 128;
    for (let t = 0; t < 256; t++) {
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
        const vecinos = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const v of vecinos) {
          if (v >= 0 && mascara[v] && !etiqueta[v]) { etiqueta[v] = actual; cola[fin++] = v; }
        }
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

    let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity, tl, tr, br, bl;
    for (let i = 0; i < comp.length; i++) {
      const p = comp[i], x = p % w, y = (p / w) | 0, s = x + y, d = x - y;
      if (s < sMin) { sMin = s; tl = [x, y]; }
      if (s > sMax) { sMax = s; br = [x, y]; }
      if (d > dMax) { dMax = d; tr = [x, y]; }
      if (d < dMin) { dMin = d; bl = [x, y]; }
    }
    const q = [tl, tr, br, bl].map(([x, y]) => ({ x: (x + 0.5) / w, y: (y + 0.5) / h }));
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

  function enderezar(fuente, quad) {
    const sw = fuente.width, sh = fuente.height, P = quad.map(p => ({ x: p.x * sw, y: p.y * sh }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(dist(P[0], P[1]), dist(P[3], P[2])), H = Math.max(dist(P[0], P[3]), dist(P[1], P[2]));
    const k = Math.min(1, MAX_ANCHO / W, MAX_ALTO / H);
    W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));
    const m = homografia(W, H, P);
    const src = fuente.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = lienzo(W, H), octx = out.getContext('2d'), img = octx.createImageData(W, H), o = img.data;
    const maxU = sw - 1.001, maxV = sh - 1.001, fila = sw * 4;
    for (let y = 0; y < H; y++) {
      const yc = y + 0.5;
      for (let x = 0; x < W; x++) {
        const xc = x + 0.5, den = m[6] * xc + m[7] * yc + 1;
        let u = (m[0] * xc + m[1] * yc + m[2]) / den - 0.5, v = (m[3] * xc + m[4] * yc + m[5]) / den - 0.5;
        u = u < 0 ? 0 : u > maxU ? maxU : u;
        v = v < 0 ? 0 : v > maxV ? maxV : v;
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i = (y0 * sw + x0) * 4, j = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = src[i + c] + (src[i + 4 + c] - src[i + c]) * fx;
          const b = src[i + fila + c] + (src[i + fila + 4 + c] - src[i + fila + c]) * fx;
          o[j + c] = a + (b - a) * fy;
        }
        o[j + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function girar(c, grados) {
    if (!grados) return c;
    const recto = grados % 180 !== 0, out = lienzo(recto ? c.height : c.width, recto ? c.width : c.height);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(grados * Math.PI / 180);
    ctx.drawImage(c, -c.width / 2, -c.height / 2);
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

  /** Quita sombras y deja el papel blanco: divide por la iluminación estimada y estira el contraste. */
  function mejorar(c) {
    const W = c.width, H = c.height, ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, W, H), d = img.data, n = W * H, g = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    let f = Math.max(4, Math.round(Math.max(W, H) / 160));
    f = Math.max(1, Math.min(f, Math.floor(Math.min(W, H) / 4)));
    const w2 = Math.ceil(W / f), h2 = Math.ceil(H / f), peq = new Float32Array(w2 * h2);
    for (let y = 0; y < H; y++) {
      const fy = ((y / f) | 0) * w2;
      for (let x = 0; x < W; x++) { const k = fy + ((x / f) | 0), v = g[y * W + x]; if (v > peq[k]) peq[k] = v; }
    }
    const fondo = desenfocar(maximoLocal(peq, w2, h2, 2), w2, h2, 3);

    for (let y = 0; y < H; y++) {
      const fy = Math.min(h2 - 1.001, Math.max(0, y / f - 0.5)), y0 = fy | 0, ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.min(w2 - 1.001, Math.max(0, x / f - 0.5)), x0 = fx | 0, tx = fx - x0, k = y0 * w2 + x0;
        const k1 = Math.min(k + 1, w2 * h2 - 1), k2 = Math.min(k + w2, w2 * h2 - 1), k3 = Math.min(k + w2 + 1, w2 * h2 - 1);
        const a = fondo[k] + (fondo[k1] - fondo[k]) * tx, b = fondo[k2] + (fondo[k3] - fondo[k2]) * tx;
        let v = g[y * W + x] / Math.max(30, a + (b - a) * ty);
        v = (v - 0.45) / 0.47;
        v = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1.6);
        const j = (y * W + x) * 4;
        d[j] = d[j + 1] = d[j + 2] = v * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // ---------- Página completa ----------

  /** pagina: { quad, rot, modo } → { salida (JPEG), mini (JPEG), ancho, alto } */
  async function procesar(fuente, pagina) {
    let c = enderezar(fuente, pagina.quad || COMPLETA);
    c = girar(c, pagina.rot || 0);
    if (pagina.modo !== 'color') mejorar(c);
    return {
      salida: await aJpeg(c, 0.72),
      mini: await aJpeg(escalar(c, 260), 0.7),
      ancho: c.width,
      alto: c.height
    };
  }

  /** Une varias páginas en una sola tira vertical (boletas largas). */
  async function unirTira(paginas) {
    const imgs = [];
    for (const p of paginas) imgs.push(await decodificar(p.salida));
    const W = Math.min(MAX_ANCHO, Math.max(...imgs.map(i => i.width)));
    const altos = imgs.map(i => Math.round(i.height * W / i.width));
    const total = altos.reduce((a, b) => a + b, 0), k = Math.min(1, 16000 / total);
    const c = lienzo(Math.round(W * k), Math.round(total * k)), ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    let y = 0;
    imgs.forEach((im, i) => { const h = Math.round(altos[i] * k); ctx.drawImage(im, 0, y, c.width, h); y += h; });
    return { salida: await aJpeg(c, 0.75), ancho: c.width, alto: c.height };
  }

  return { COMPLETA, cargar, detectar, procesar, unirTira, aJpeg, escalar };
})();
