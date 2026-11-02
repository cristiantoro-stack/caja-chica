/*
 * Presentación del logo al abrir la app: una red de nodos que converge, los bloques del símbolo que se ensamblan, las dos
 * barras que crecen como un gráfico, ondas de señal, un barrido de luz, la marca letra a letra y, al final, el símbolo
 * vuela al logo de la barra superior. Se carga en <head> para decidir antes de pintar.
 * No aparece en pruebas automáticas, al compartir un archivo, con el atajo "Escanear", al vincular, al retomar un trabajo
 * a medias ni al recargar en la misma sesión. Un toque (o una tecla) la salta. Con "reducir movimiento", solo aparece y se va.
 * Forzarla: ?intro=1
 */
(() => {
  let mostrar = false;
  try {
    const q = location.search, forzar = /[?&]intro=1(&|$)/.test(q);
    mostrar = forzar || (!navigator.webdriver && !/[?&](accion|compartido)=/.test(q) && !/vincular=/.test(location.hash)
      && localStorage.getItem('cc.trabajando') !== '1' && !sessionStorage.getItem('cc.intro'));
    sessionStorage.setItem('cc.intro', '1');
  } catch (e) { mostrar = false; }
  const raiz = document.documentElement;
  if (mostrar) raiz.classList.add('con-intro');
  const quieto = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const DURA = quieto ? 1100 : 2450;          // hasta que empieza la salida

  document.addEventListener('DOMContentLoaded', () => {
    const intro = document.getElementById('intro');
    if (!intro) { raiz.classList.remove('con-intro'); return; }
    if (!mostrar) { intro.remove(); return; }
    let fin = false, cuadro = 0, apretado = false, pendiente = false;

    // Se retira cuando termina la salida, pero nunca con el dedo apoyado: el toque no debe llegar a la app de abajo
    const retirar = () => {
      if (apretado) { pendiente = true; return; }
      intro.remove();
      raiz.classList.remove('con-intro');
    };
    const salir = rapido => {
      if (fin) return;
      fin = true;
      cancelAnimationFrame(cuadro);
      const vuela = !rapido && !quieto && volar();
      intro.classList.add(vuela ? 'vuela' : 'sale');
      setTimeout(retirar, vuela ? 760 : 520);
    };
    intro.addEventListener('pointerdown', () => { apretado = true; salir(true); });
    const soltar = () => { apretado = false; if (pendiente) setTimeout(retirar, 350); };
    intro.addEventListener('pointerup', soltar);
    intro.addEventListener('pointercancel', soltar);
    const tecla = () => { document.removeEventListener('keydown', tecla, true); salir(true); };
    document.addEventListener('keydown', tecla, true);
    setTimeout(() => salir(false), DURA);
    if (!quieto) red(document.getElementById('introRed'));

    /** El símbolo vuela hasta el logo de la barra superior (mismo dibujo: al retirarse la capa, queda ahí). */
    function volar() {
      const destino = document.getElementById('barraLogo'), simbolo = intro.querySelector('.intro-simbolo'), logo = intro.querySelector('.intro-logo');
      if (!destino || !simbolo || !logo) return false;
      const d = destino.getBoundingClientRect(), s = simbolo.getBoundingClientRect(), l = logo.getBoundingClientRect();
      if (!d.width || !d.height || !s.height || d.bottom <= 0) return false;
      // logo-simbolo.svg: viewBox 687 -21 1622×1858, centrado en su caja; las 5 piezas ocupan x 757–2238, y 50–1767
      const k = Math.min(d.width / 1622, d.height / 1858);
      const x0 = d.left + (d.width - 1622 * k) / 2 + (757 - 687) * k, y0 = d.top + (d.height - 1858 * k) / 2 + (50 + 21) * k;
      const ancho = 1481 * k, alto = 1717 * k, cx = s.left + s.width / 2, cy = s.top + s.height / 2;
      logo.style.transformOrigin = `${cx - l.left}px ${cy - l.top}px`;
      logo.style.transform = `translate(${x0 + ancho / 2 - cx}px, ${y0 + alto / 2 - cy}px) scale(${alto / s.height})`;
      return true;
    }

    /** Red de nodos dorados (conectividad) y pulsos de datos que viajan hacia el logo mientras se arma. */
    function red(canvas) {
      const ctx = canvas && canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;
      const w = innerWidth, h = innerHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.scale(dpr, dpr);
      const cx = w / 2, cy = h * 0.44, lado = Math.max(w, h);
      const n = Math.round(Math.min(80, Math.max(44, (w * h) / 6500)));
      const nodos = Array.from({ length: n }, () => ({            // repartidos por toda la pantalla (y un poco más allá)
        x: (Math.random() * 1.2 - 0.1) * w, y: (Math.random() * 1.2 - 0.1) * h, vx: (Math.random() - 0.5) * 18, vy: (Math.random() - 0.5) * 18,
        r: 0.7 + Math.random() * 1.5, fase: Math.random() * 6.3
      }));
      const pulsos = Array.from({ length: 16 }, (_, i) => ({ a: (i / 16) * Math.PI * 2 + Math.random() * 0.3,
        r0: lado * (0.45 + Math.random() * 0.25), espera: 0.08 + Math.random() * 0.5, dura: 0.6 + Math.random() * 0.35 }));
      const alcance = Math.min(150, w / 3), t0 = performance.now();
      let antes = t0;
      const dibujar = t => {
        const s = (t - t0) / 1000, dt = Math.min(0.05, (t - antes) / 1000);   // por tiempo: igual en pantallas de 60 o 120 Hz
        antes = t;
        ctx.clearRect(0, 0, w, h);
        const atrae = (s < 1.1 ? 0.085 : 0.02) * dt;          // mientras se arma el logo, la red se acerca
        for (const p of nodos) {
          p.x += p.vx * dt + (cx - p.x) * atrae;
          p.y += p.vy * dt + (cy - p.y) * atrae;
        }
        ctx.lineWidth = 0.8;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = nodos[i].x - nodos[j].x, dy = nodos[i].y - nodos[j].y, d = Math.hypot(dx, dy);
            if (d > alcance) continue;
            ctx.strokeStyle = `rgba(201,154,63,${((1 - d / alcance) * 0.32).toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(nodos[i].x, nodos[i].y);
            ctx.lineTo(nodos[j].x, nodos[j].y);
            ctx.stroke();
          }
        }
        for (const p of nodos) {
          ctx.fillStyle = `rgba(233,207,147,${(0.45 + 0.4 * Math.sin(s * 3 + p.fase)).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
        // Pulsos de datos: llegan desde afuera al centro, con estela
        for (const q of pulsos) {
          const k = (s - q.espera) / q.dura;
          if (k <= 0 || k >= 1) continue;
          const e = k * k * (3 - 2 * k), r = q.r0 * (1 - e) + 40 * e, cola = 34 + 40 * (1 - e);
          const x = cx + Math.cos(q.a) * r, y = cy + Math.sin(q.a) * r, xc = cx + Math.cos(q.a) * (r + cola), yc = cy + Math.sin(q.a) * (r + cola);
          const g = ctx.createLinearGradient(xc, yc, x, y);
          g.addColorStop(0, 'rgba(233,207,147,0)');
          g.addColorStop(1, `rgba(255,236,190,${(0.9 * (1 - k * 0.6)).toFixed(3)})`);
          ctx.strokeStyle = g;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(xc, yc);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        if (!fin && s < 3) cuadro = requestAnimationFrame(dibujar);
      };
      cuadro = requestAnimationFrame(dibujar);
    }
  });
})();
