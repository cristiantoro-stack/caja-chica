/* Custodia de la tarjeta: firma con el dedo, lectura del QR de la tarjeta y huella del QR (el contenido nunca sale del teléfono). */
const Custodia = (() => {

  // ---------- Firma en pantalla ----------

  /**
   * Panel de firma sobre un canvas: trazos suaves con el dedo, sin desplazar la página mientras se firma.
   * Los puntos se guardan en las medidas del panel al empezar a firmar (base); si el panel cambia de tamaño (girar el
   * teléfono) la firma se dibuja a escala, entera, y el PNG se arma desde los trazos, no desde lo visible.
   */
  class Firma {
    constructor(canvas, alCambiar) {
      this.canvas = canvas;
      this.alCambiar = alCambiar || (() => {});
      this.trazos = [];
      this.actual = null;
      this.base = null;
      this.preparar();
      canvas.addEventListener('pointerdown', e => this.empezar(e));
      canvas.addEventListener('pointermove', e => this.seguir(e));
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => canvas.addEventListener(t, () => this.terminar()));
    }

    /** Ajusta la resolución al tamaño en pantalla (nítida en pantallas de alta densidad) y redibuja. */
    preparar() {
      const r = this.canvas.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
      if (!r.width || !r.height) return;
      this.ancho = r.width;
      this.alto = r.height;
      this.dpr = dpr;
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
      this.redibujar();
    }

    /** Escala de la base (medidas al firmar) a la pantalla actual: uniforme, para que la firma no se deforme ni se corte. */
    escala() {
      return this.base ? Math.min(this.ancho / this.base.w, this.alto / this.base.h) : 1;
    }

    punto(e) {
      const r = this.canvas.getBoundingClientRect(), k = this.escala();
      return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
    }

    empezar(e) {
      if (!this.ancho) this.preparar();
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      if (!this.base) this.base = { w: this.ancho, h: this.alto };
      this.actual = [this.punto(e)];
      this.trazos.push(this.actual);
      this.redibujar();
    }

    seguir(e) {
      if (!this.actual) return;
      e.preventDefault();
      const p = this.punto(e), u = this.actual[this.actual.length - 1];
      if (Math.hypot(p.x - u.x, p.y - u.y) < 1.2) return;
      this.actual.push(p);
      this.redibujar();
    }

    terminar() {
      if (!this.actual) return;
      this.actual = null;
      this.alCambiar(this);
    }

    redibujar() {
      const ctx = this.canvas.getContext('2d'), k = this.escala() * (this.dpr || 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      Firma.trazar(ctx, this.trazos, 2.6);
    }

    /** Dibuja los trazos (en medidas de la base) con el contexto ya escalado. */
    static trazar(ctx, trazos, grosor) {
      ctx.lineWidth = grosor;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = '#12181f';
      ctx.fillStyle = '#12181f';
      trazos.forEach(t => {
        if (t.length === 1) { ctx.beginPath(); ctx.arc(t[0].x, t[0].y, 1.4, 0, Math.PI * 2); ctx.fill(); return; }
        ctx.beginPath();
        ctx.moveTo(t[0].x, t[0].y);
        for (let i = 1; i < t.length - 1; i++) {
          const m = { x: (t[i].x + t[i + 1].x) / 2, y: (t[i].y + t[i + 1].y) / 2 };
          ctx.quadraticCurveTo(t[i].x, t[i].y, m.x, m.y);
        }
        const f = t[t.length - 1];
        ctx.lineTo(f.x, f.y);
        ctx.stroke();
      });
    }

    borrar() {
      this.trazos = [];
      this.actual = null;
      this.base = null;
      this.redibujar();
      this.alCambiar(this);
    }

    /** Para guardar el borrador del acta en el teléfono y recuperarlo tal cual. */
    datos() {
      return { base: this.base, trazos: this.trazos.map(t => t.map(p => ({ x: p.x, y: p.y }))) };
    }

    cargar(d) {
      this.trazos = d && Array.isArray(d.trazos) ? d.trazos : [];
      this.base = d && d.base && this.trazos.length ? d.base : null;
      this.actual = null;
      this.redibujar();
      this.alCambiar(this);
    }

    /** Largo total del trazo en px de pantalla: una firma real supera fácilmente los 120 px. */
    largo() {
      return this.trazos.reduce((s, t) => s + t.reduce((a, p, i) => a + (i ? Math.hypot(p.x - t[i - 1].x, p.y - t[i - 1].y) : 0), 0), 0);
    }

    valida() {
      if (this.largo() < 120) return false;
      const xs = this.trazos.flat().map(p => p.x), ys = this.trazos.flat().map(p => p.y);
      return Math.max(...xs) - Math.min(...xs) > 40 || Math.max(...ys) - Math.min(...ys) > 25;
    }

    /** PNG con fondo blanco, armado desde los trazos (entero aunque se haya girado el teléfono) y sin márgenes vacíos. */
    aPng() {
      const pts = this.trazos.flat();
      if (!pts.length) return null;
      const m = 8, k = 2.5, xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m, x1 = Math.max(...xs) + m, y1 = Math.max(...ys) + m;
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((x1 - x0) * k));
      c.height = Math.max(1, Math.round((y1 - y0) * k));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
      Firma.trazar(ctx, this.trazos, 2.6);
      return c.toDataURL('image/png').split(',')[1];
    }
  }

  // ---------- Código QR de la tarjeta ----------

  const lectorDisponible = async () => {
    if (!('BarcodeDetector' in window)) return false;
    try {
      const formatos = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : ['qr_code'];
      return formatos.includes('qr_code');
    } catch (e) { return false; }
  };

  /** Busca un QR en el video cada ~250 ms. Devuelve el texto, o null si se canceló. */
  function leerQr(video, cancelado) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    return new Promise((ok, mal) => {
      const intentar = async () => {
        if (cancelado()) { ok(null); return; }
        try {
          if (video.readyState >= 2) {
            const r = await detector.detect(video);
            const valor = r && r[0] && r[0].rawValue;
            if (valor) { ok(valor); return; }
          }
        } catch (e) {
          if (e && e.name === 'NotSupportedError') { mal(e); return; }
        }
        setTimeout(intentar, 250);
      };
      intentar();
    });
  }

  function luhn(numero) {
    let s = 0;
    for (let i = 0; i < numero.length; i++) {
      let d = Number(numero[numero.length - 1 - i]);
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      s += d;
    }
    return s % 10 === 0;
  }

  /**
   * Qué se puede aprovechar del QR sin guardar su contenido: si trae un número de tarjeta completo, solo sus 4 últimos
   * dígitos; si es una dirección web, solo el dominio (para mostrarlo). Nunca se envía el texto leído.
   */
  function analizarQr(texto) {
    const t = String(texto || '').trim(), digitos = t.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(digitos) && luhn(digitos)) return { tipo: 'numero', ultimos4: digitos.slice(-4), dominio: '' };
    const url = t.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i);
    if (url) return { tipo: 'url', ultimos4: '', dominio: url[1].toLowerCase() };
    return { tipo: 'texto', ultimos4: '', dominio: '' };
  }

  /** SHA-256 en hexadecimal (identifica la tarjeta física sin guardar el contenido de su QR). */
  async function huella(texto) {
    const datos = new TextEncoder().encode(String(texto));
    const h = await crypto.subtle.digest('SHA-256', datos);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function huellaDeBase64(b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- Ubicación ----------

  /**
   * Mejor posición en hasta `ms` milisegundos (se queda con la más precisa). alMejorar recibe cada lectura mejor que la
   * anterior, así la pantalla y el acta pueden usar la mejor disponible sin esperar al final.
   */
  function ubicar(ms = 12000, alMejorar) {
    return new Promise(ok => {
      if (!navigator.geolocation) { ok({ error: 'El teléfono no entrega la ubicación' }); return; }
      let mejor = null, listo = false;
      const fin = r => { if (listo) return; listo = true; navigator.geolocation.clearWatch(vigilancia); clearTimeout(reloj); ok(r); };
      const vigilancia = navigator.geolocation.watchPosition(p => {
        const c = p.coords;
        if (!mejor || c.accuracy < mejor.precision) {
          mejor = { lat: Number(c.latitude.toFixed(6)), lon: Number(c.longitude.toFixed(6)), precision: Math.round(c.accuracy), ubicadoEn: new Date(p.timestamp).toISOString() };
          if (alMejorar && !listo) alMejorar(mejor);
        }
        if (c.accuracy <= 25) fin(mejor);
      }, e => {
        const textos = { 1: 'Sin permiso de ubicación', 2: 'Ubicación no disponible', 3: 'La ubicación tardó demasiado' };
        if (!mejor) fin({ error: textos[e.code] || 'Ubicación no disponible' });
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
      const reloj = setTimeout(() => fin(mejor || { error: 'La ubicación tardó demasiado' }), ms + 500);
    });
  }

  return { Firma, lectorDisponible, leerQr, analizarQr, huella, huellaDeBase64, ubicar, luhn };
})();
