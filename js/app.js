/* App Caja Chica · flujo: capturar → revisar páginas → datos del gasto → guardar en Drive y en la planilla. */
(() => {
  const VERSION = '1.0.2';
  const MAX_BYTES = 20 * 1048576;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const TITULOS = { inicio: 'Caja Chica', paginas: 'Páginas del documento', datos: 'Datos del gasto', listo: 'Resultado', ajustes: 'Ajustes' };
  const GASTOS = ['Desembolso MP', 'Rendición Santander'];
  const CAMPOS = { fFecha: 'fecha', fMonto: 'monto', fTipo: 'tipoDoc', fNumero: 'numero', fProveedor: 'proveedor', fRut: 'rut', fMedio: 'medio', fCeco: 'ceco', fDetalle: 'detalle' };
  const URL_SERVIDOR = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/;
  const PREFIJO = Api.demo ? 'cc-demo.' : 'cc.';

  const est = {
    vista: 'inicio', capa: null, trasCerrar: null, dialogo: null, volviendo: false, alLlegarAlInicio: null,
    paginas: [], pdf: null, origen: null, capturadoEn: null,
    lectura: null, lecturaId: 0,
    listas: null, tarjetas: {},
    movimiento: 'Desembolso MP', categoria: '', tocados: new Set(),
    guardando: false
  };
  let cadena = Promise.resolve();      // las fotos se procesan de a una (cuida la memoria del teléfono)

  // ---------- Utilidades ----------

  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enlaceSeguro = u => (/^https:\/\//.test(String(u || '')) ? u : '#');
  const miles = n => Math.round(Number(n) || 0).toLocaleString('es-CL');
  const clp = n => '$' + miles(n);
  const soloDigitos = s => String(s || '').replace(/\D/g, '');
  const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fechaCorta = iso => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');
  const opciones = sel => Array.from($(sel).options).map(o => o.value);
  const listas = () => est.listas || Demo.listas;
  const hayDocumento = () => !!est.pdf || est.paginas.length > 0;
  const paginasTexto = n => (n === 1 ? '1 página' : `${n} páginas`);

  function leerLocal(clave) { try { return JSON.parse(localStorage.getItem(PREFIJO + clave)); } catch (e) { return null; } }
  function guardarLocal(clave, valor) { try { localStorage.setItem(PREFIJO + clave, JSON.stringify(valor)); } catch (e) { /* sin espacio */ } }

  function aBase64(blob) {
    return new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1]);
      r.onerror = () => mal(r.error);
      r.readAsDataURL(blob);
    });
  }

  function rutInfo(rut) {
    const l = String(rut).toUpperCase().replace(/[^0-9K]/g, '');
    if (l.length < 7) return null;
    const cuerpo = l.slice(0, -1).replace(/^0+/, ''), dv = l.slice(-1);
    if (!/^\d{6,8}$/.test(cuerpo)) return null;
    let s = 0, m = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) { s += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
    const r = 11 - (s % 11), esperado = r === 11 ? '0' : r === 10 ? 'K' : String(r);
    return { ok: esperado === dv, texto: cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv };
  }

  function toast(mensaje, ms = 3200) {
    const t = $('#toast');
    t.textContent = mensaje;
    t.classList.add('visible');
    clearTimeout(toast.reloj);
    toast.reloj = setTimeout(() => t.classList.remove('visible'), ms);
  }

  // ---------- Navegación: cada entrada del historial lleva su profundidad desde el inicio ----------

  const estadoActual = () => history.state || { vista: 'inicio', prof: 0 };
  const profundidad = () => estadoActual().prof || 0;

  function mostrar(vista) {
    est.vista = vista;
    $$('.vista').forEach(v => v.classList.toggle('activa', v.id === 'v-' + vista));
    $('#tituloVista').textContent = TITULOS[vista];
    $('#btnVolver').hidden = vista === 'inicio';
    $('#barraLogo').hidden = vista !== 'inicio';
    $('#btnAjustes').hidden = vista !== 'inicio';
    window.scrollTo(0, 0);
    if (vista === 'inicio') cargarInicio();
    if (vista === 'ajustes') cargarAjustes();
  }

  function ir(vista) {
    history.pushState({ vista, prof: profundidad() + 1 }, '');
    mostrar(vista);
  }

  /** Vuelve al inicio sacando del historial las pantallas intermedias; "despues" corre al llegar. */
  function volverInicio(despues) {
    const prof = profundidad();
    if (prof > 0) {
      est.volviendo = true;
      est.alLlegarAlInicio = despues || null;
      history.go(-prof);
    } else {
      mostrar('inicio');
      if (despues) despues();
    }
  }

  function abrirCapa(nombre) {
    est.capa = nombre;
    history.pushState({ vista: est.vista, prof: profundidad() + 1, capa: nombre }, '');
  }

  function cerrarCapa(despues) {
    est.trasCerrar = despues || null;
    if (est.capa) history.back();
  }

  function cerrarCapaSinHistorial() {
    if (est.capa === 'camara') detenerCamara();
    if (est.capa === 'editor') ocultarEditor();
    est.capa = null;
  }

  /** Diálogo de confirmación. El botón "atrás" equivale a cancelar. */
  function preguntar(titulo, texto, si = 'Aceptar', no = 'Cancelar') {
    return new Promise(ok => {
      const previo = document.activeElement;
      let resultado = false;
      $('#dialogoTitulo').textContent = titulo;
      $('#dialogoTexto').textContent = texto;
      $('#dialogoSi').textContent = si;
      $('#dialogoNo').textContent = no || '';
      $('#dialogoNo').hidden = !no;
      est.dialogo = () => {
        $('#dialogo').hidden = true;
        $('#dialogoSi').onclick = $('#dialogoNo').onclick = null;
        if (previo && previo.focus) previo.focus();
        ok(resultado);
      };
      let respondido = false;                       // un doble toque no debe retroceder dos veces
      const responder = v => { if (respondido) return; respondido = true; resultado = v; history.back(); };
      $('#dialogoSi').onclick = () => responder(true);
      $('#dialogoNo').onclick = () => responder(false);
      $('#dialogo').hidden = false;
      history.pushState({ vista: est.vista, prof: profundidad() + 1, dialogo: true }, '');
      $('#dialogoSi').focus();
    });
  }

  window.addEventListener('popstate', e => {
    const st = e.state || { vista: 'inicio', prof: 0 };
    if (est.volviendo) {
      est.volviendo = false;
      cerrarCapaSinHistorial();
      mostrar('inicio');
      const despues = est.alLlegarAlInicio;
      est.alLlegarAlInicio = null;
      if (despues) despues();
      return;
    }
    if (est.dialogo) {
      const cerrar = est.dialogo;
      est.dialogo = null;
      cerrar();
      return;
    }
    if (est.capa) {
      const capa = est.capa;
      cerrarCapaSinHistorial();
      let siguiente = est.trasCerrar;
      est.trasCerrar = null;
      if (capa === 'camara' && !siguiente && est.paginas.length) siguiente = 'paginas';   // "atrás" con fotos tomadas
      if (siguiente === 'inicio') volverInicio();
      else if (siguiente && siguiente !== est.vista) ir(siguiente);
      else if (est.vista === 'paginas') pintarPaginas();
      return;
    }
    if (est.guardando) {
      history.pushState({ vista: est.vista, prof: (st.prof || 0) + 1 }, '');
      toast('Espera a que termine de guardar');
      return;
    }
    let v = st.vista || 'inicio';
    if (est.vista === 'listo' || v === 'listo' || (v === 'datos' && !hayDocumento()) || (v === 'paginas' && !est.paginas.length)) {
      if ((st.prof || 0) > 0) { volverInicio(); return; }
      v = 'inicio';
    }
    mostrar(v);
  });

  // ---------- Inicio ----------

  function cargarInicio() {
    $('#avisoConfig').hidden = Api.configurada();
    pintarCola();
    revisarSesion();
    const previo = leerLocal('resumen');
    if (previo) pintarResumen(previo);
    refrescarResumen(false);
  }

  async function refrescarResumen(avisar) {
    if (!Api.configurada()) return;
    try {
      const r = await Api.llamar('resumen');
      guardarLocal('resumen', r);
      pintarResumen(r);
      if (avisar) toast('Actualizado');
    } catch (e) {
      if (avisar || e.codigo === 'clave') toast(e.message, 5000);
    }
  }

  function pintarResumen(r) {
    const m = r.mes || {}, partes = String(m.mes || '').split('-');
    $('#kpiMes').textContent = partes[1] ? `${MESES[Number(partes[1]) - 1]} ${partes[0]}` : 'Este mes';
    $('#kpiMonto').textContent = clp(m.desembolsos || 0);
    $('#kpiDocs').textContent = m.documentos || 0;
    $('#kpiTarjeta').textContent = m.conTarjeta ? `${m.tarjetaOk}/${m.conTarjeta}` : '—';
    $('#kpiSaldo').textContent = clp(r.saldo || 0);
    const ul = $('#ultimos');
    ul.innerHTML = '';
    if (!r.ultimos || !r.ultimos.length) {
      ul.innerHTML = '<li class="lista-vacia">Aún no hay registros este año</li>';
    } else {
      r.ultimos.forEach(f => {
        const chip = { 'Conciliado': 'ok', 'Observado': 'alerta', 'Pendiente revisión': 'pendiente' }[f.estado] || '';
        const li = document.createElement('li');
        li.innerHTML = `<a href="${esc(enlaceSeguro(f.respaldoUrl))}" target="_blank" rel="noopener">
          <span class="lista-prov">${esc(f.proveedor || f.detalle || f.movimiento || f.id)}</span>
          <span class="lista-monto">${clp(f.monto)}</span>
          <span class="lista-sub">${esc(fechaCorta(f.fecha))} · ${esc(f.id)}</span>
          <span class="chip ${chip}">${esc(f.estado || '')}</span></a>`;
        ul.appendChild(li);
      });
    }
    const planilla = enlaceSeguro(r.planillaUrl);
    $('#lnkPlanilla').hidden = planilla === '#';
    if (planilla !== '#') $('#lnkPlanilla').href = planilla;
  }

  async function pintarCola() {
    let items = [];
    try { items = await Api.pendientes(); } catch (e) { /* sin IndexedDB */ }
    const bloqueados = items.filter(i => (i.intentos || 0) >= 3);
    $('#avisoCola').hidden = !items.length;
    $('#btnDescartarCola').hidden = !bloqueados.length;
    if (!items.length) return;
    $('#textoCola').textContent = bloqueados.length
      ? `${bloqueados.length === 1 ? '1 documento no se pudo enviar' : bloqueados.length + ' documentos no se pudieron enviar'}: ${bloqueados[0].ultimoError || 'error del servidor'}`
      : (items.length === 1 ? '1 documento esperando conexión' : `${items.length} documentos esperando conexión`);
  }

  /** Botón "Enviar" del aviso de la cola: si hay documentos que parecen repetidos, pregunta antes de guardarlos. */
  async function enviarColaManual() {
    const repetidos = (await Api.pendientes()).filter(i => i.duplicado);
    let guardarRepetidos = false;
    if (repetidos.length) {
      guardarRepetidos = await preguntar('¿Guardar igual?', `${repetidos.length === 1 ? 'Un documento' : repetidos.length + ' documentos'} en espera ${repetidos.length === 1 ? 'parece repetido' : 'parecen repetidos'}: ${repetidos[0].ultimoError}.`, 'Guardar igual', 'No');
    }
    enviarCola(false, true, guardarRepetidos);
  }

  async function enviarCola(silencioso, incluirBloqueados, guardarRepetidos) {
    if (Api.demo) return;
    if (!Api.configurada() || !navigator.onLine) {
      if (!silencioso) toast(Api.configurada() ? 'Sin conexión a internet' : 'Primero vincula la app en Ajustes');
      return;
    }
    const n = await Api.enviarCola((r, item, e) => {
      if (r) toast(`${r.id} enviado a Drive`);
      else if (e && e.datos && e.datos.duplicado) toast(`Ya estaba registrado como ${e.datos.duplicado.id}`);
    }, incluirBloqueados, guardarRepetidos);
    await pintarCola();
    if (n) refrescarResumen(false);
  }

  async function descartarBloqueados() {
    const bloqueados = (await Api.pendientes()).filter(i => (i.intentos || 0) >= 3);
    if (!bloqueados.length) return;
    const d = bloqueados[0].payload && bloqueados[0].payload.datos;
    const detalle = d ? `${d.proveedor || d.detalle || 'documento'} · ${clp(d.monto)}` : 'documento';
    const si = await preguntar('Descartar sin enviar', `Se borrará del teléfono sin llegar a Drive: ${detalle}${bloqueados.length > 1 ? ` y ${bloqueados.length - 1} más` : ''}. ¿Seguro?`, 'Descartar', 'Cancelar');
    if (!si) return;
    for (const b of bloqueados) await Api.descartar(b.id);
    pintarCola();
  }

  function revisarSesion() {
    const n = est.paginas.length;
    $('#avisoSesion').hidden = !n || est.vista !== 'inicio';
    if (n) $('#textoSesion').textContent = `Tienes una captura sin terminar (${paginasTexto(n)}).`;
  }

  /** Recupera una captura guardada en el teléfono (por ejemplo, si el sistema cerró Chrome). */
  async function restaurarSesion() {
    let s = null;
    try { s = await DB.leer('sesion', 'actual'); } catch (e) { s = null; }
    if (!s || !s.paginas || !s.paginas.length || est.paginas.length) return;
    est.paginas = s.paginas.map(p => Object.assign({}, p, { miniUrl: URL.createObjectURL(p.mini) }));
    est.origen = s.origen;
    est.capturadoEn = s.capturadoEn;
    $('#chkUnir').checked = !!s.unir;
  }

  // ---------- Captura ----------

  function liberar(p) {
    if (p.miniUrl) URL.revokeObjectURL(p.miniUrl);
    p.miniUrl = null;
  }

  function nuevaCaptura() {
    est.paginas.forEach(liberar);
    Object.assign(est, { paginas: [], pdf: null, origen: null, capturadoEn: null, lectura: null, categoria: '', movimiento: 'Desembolso MP' });
    est.tocados = new Set();
    est.lecturaId++;
    $('#chkUnir').checked = false;
    limpiarFormulario();
    DB.borrar('sesion', 'actual').catch(() => {});
  }

  async function descartarSiHay() {
    if (!hayDocumento()) return true;
    const n = est.paginas.length;
    return preguntar('Captura sin terminar', n ? `¿Descartar ${n === 1 ? 'la página capturada' : `las ${n} páginas capturadas`}?` : '¿Descartar el PDF sin guardar?', 'Descartar', 'Conservar');
  }

  function agregarFoto(blob, origen) {
    const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), rot: 0, modo: 'documento', procesando: true };
    est.paginas.push(p);
    est.origen = est.origen || origen;
    est.capturadoEn = est.capturadoEn || new Date().toISOString();
    est.lectura = null;
    pintarPaginas();
    pintarContador();
    cadena = cadena.then(async () => {
      try {
        const fuente = await Escaner.cargar(blob);
        p.fuente = await Escaner.aJpeg(fuente, 0.9);
        p.quad = Escaner.detectar(fuente) || Escaner.COMPLETA;
        Object.assign(p, await Escaner.procesar(fuente, p));
        p.miniUrl = URL.createObjectURL(p.mini);
      } catch (e) {
        est.paginas = est.paginas.filter(x => x !== p);
        toast(e.message || 'No se pudo leer la imagen');
      }
      p.procesando = false;
      pintarPaginas();
      pintarContador();
      guardarSesion();
    });
    return cadena;
  }

  function tomarArchivos(evento, origen) {
    const archivos = Array.from(evento.target.files || []);
    evento.target.value = '';
    if (!archivos.length) return;
    if (est.vista !== 'paginas') ir('paginas');
    archivos.forEach(f => agregarFoto(f, origen));
  }

  function usarPdf(blob, nombre, origen) {
    if (blob.size > MAX_BYTES) { toast('El PDF supera 20 MB: pide una versión más liviana', 5000); return; }
    est.pdf = { blob, nombre };
    est.origen = origen;
    est.capturadoEn = new Date().toISOString();
    ir('datos');
    prepararDatos();
    leerDocumento();
  }

  async function guardarSesion() {
    const listas = est.paginas.filter(p => !p.procesando && p.salida);
    try {
      if (!listas.length) { await DB.borrar('sesion', 'actual'); return; }
      await DB.guardar('sesion', 'actual', {
        paginas: listas.map(p => ({ id: p.id, fuente: p.fuente, quad: p.quad, rot: p.rot, modo: p.modo, salida: p.salida, mini: p.mini, ancho: p.ancho, alto: p.alto })),
        origen: est.origen, capturadoEn: est.capturadoEn, unir: $('#chkUnir').checked
      });
    } catch (e) { /* sin espacio en el teléfono: la captura sigue en memoria */ }
  }

  function pintarPaginas() {
    const cont = $('#paginas');
    cont.innerHTML = '';
    est.paginas.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pagina' + (p.procesando ? ' procesando' : '');
      b.setAttribute('aria-label', `Página ${i + 1}: ajustar`);
      b.innerHTML = (p.miniUrl ? `<img src="${p.miniUrl}" alt="">` : '') + `<span class="pagina-num">${i + 1}</span>`;
      b.onclick = () => { if (!p.procesando) abrirEditor(p); };
      cont.appendChild(b);
    });
    $('#filaUnir').hidden = est.paginas.length < 2;
    const ocupado = est.paginas.some(p => p.procesando), n = est.paginas.length;
    $('#btnContinuar').disabled = !n || ocupado;
    $('#btnContinuar').textContent = ocupado ? 'Procesando…' : `Continuar (${paginasTexto(n)})`;
  }

  // ---------- Cámara dentro de la app ----------

  let flujo = null, captura = null, linterna = false, abriendoCamara = false;

  async function abrirCamara() {
    if (abriendoCamara || flujo) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('#inCamaraNativa').click(); return; }
    abriendoCamara = true;
    try {
      try {
        flujo = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
        });
      } catch (e) {
        toast(e.name === 'NotAllowedError' ? 'Sin permiso de cámara: se abre la cámara del teléfono' : 'Se abre la cámara del teléfono');
        $('#inCamaraNativa').click();
        return;
      }
      const video = $('#video');
      video.srcObject = flujo;
      try { await video.play(); } catch (e) { /* se reintenta al tocar */ }
      const pista = flujo.getVideoTracks()[0];
      pista.onended = () => { if (est.capa === 'camara') cerrarCapa(); };   // otra app tomó la cámara
      captura = 'ImageCapture' in window ? new ImageCapture(pista) : null;
      const cap = pista.getCapabilities ? pista.getCapabilities() : {};
      linterna = false;
      $('#btnFlash').hidden = !cap.torch;
      $('#btnFlash').classList.remove('activo');
      if (cap.focusMode && cap.focusMode.includes('continuous')) {
        pista.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      $('#capaCamara').hidden = false;
      abrirCapa('camara');
      pintarContador();
    } finally {
      abriendoCamara = false;
    }
  }

  function detenerCamara() {
    if (flujo) flujo.getTracks().forEach(t => { t.onended = null; t.stop(); });
    flujo = null;
    captura = null;
    $('#video').srcObject = null;
    $('#capaCamara').hidden = true;
    $('#btnDisparar').classList.remove('ocupado');
  }

  /** Foto a resolución alta pero acotada (~12 MP): evita que el teléfono se quede sin memoria. */
  async function fotoDeCaptura() {
    if (!captura) return null;
    try {
      const pc = await captura.getPhotoCapabilities();
      const maxW = pc.imageWidth && pc.imageWidth.max, maxH = pc.imageHeight && pc.imageHeight.max;
      if (maxW && maxH) {
        const k = Math.min(1, 4032 / Math.max(maxW, maxH));
        return await captura.takePhoto({ imageWidth: Math.round(maxW * k), imageHeight: Math.round(maxH * k) });
      }
      return await captura.takePhoto();
    } catch (e) {
      return null;
    }
  }

  async function disparar() {
    const boton = $('#btnDisparar');
    if (!flujo || boton.classList.contains('ocupado')) return;
    boton.classList.add('ocupado');
    try {
      const d = $('#destello');
      d.classList.remove('activo');
      void d.offsetWidth;
      d.classList.add('activo');
      let blob = await fotoDeCaptura();
      if (!blob) {
        const v = $('#video');
        if (!v.videoWidth) throw new Error('La cámara aún no está lista: intenta de nuevo');
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        blob = await Escaner.aJpeg(c, 0.92);
      }
      if (linterna && flujo) flujo.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
      if (navigator.vibrate) navigator.vibrate(25);
      agregarFoto(blob, 'camara');
    } catch (e) {
      toast(e.message || 'No se pudo tomar la foto');
    } finally {
      boton.classList.remove('ocupado');
    }
  }

  function pintarContador() {
    const n = est.paginas.length, ultima = est.paginas[n - 1];
    $('#contadorNum').textContent = n;
    const img = $('#contadorImg');
    if (ultima && ultima.miniUrl) img.src = ultima.miniUrl; else img.removeAttribute('src');
    $('#btnListoCamara').disabled = !n;
  }

  // ---------- Editor de recorte ----------

  let ed = null, arrastre = null;

  async function abrirEditor(p) {
    let fuente;
    try { fuente = await Escaner.cargar(p.fuente); } catch (e) { toast('No se pudo abrir la página'); return; }
    ed = { p, fuente, quad: p.quad.map(q => Object.assign({}, q)), rot: p.rot || 0, modo: p.modo || 'documento' };
    $('#capaEditor').hidden = false;
    abrirCapa('editor');
    pintarModo();
    requestAnimationFrame(dibujarEditor);
  }

  function ocultarEditor() {
    $('#capaEditor').hidden = true;
    ed = null;
    arrastre = null;
  }

  function dibujarEditor() {
    if (!ed) return;
    const cont = $('#editorLienzo'), cw = cont.clientWidth - 48, ch = cont.clientHeight - 48;
    const fw = ed.fuente.width, fh = ed.fuente.height, recto = ed.rot % 180 !== 0;
    const k = recto ? Math.min(cw / fh, ch / fw) : Math.min(cw / fw, ch / fh);
    const w = Math.max(1, Math.round(fw * k)), h = Math.max(1, Math.round(fh * k)), dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = $('#editorCanvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.getContext('2d').drawImage(ed.fuente, 0, 0, canvas.width, canvas.height);
    const escena = $('#editorEscena');
    escena.style.width = w + 'px';
    escena.style.height = h + 'px';
    escena.style.transform = `rotate(${ed.rot}deg)`;
    const svg = $('#editorSvg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.innerHTML = '<path class="ed-sombra"/><polygon class="ed-poligono"/>'
      + [0, 1, 2, 3].map(i => `<circle class="ed-asa" data-i="${i}" r="11"/>`).join('')
      + [0, 1, 2, 3].map(i => `<circle class="ed-asa-toque" data-i="${i}" r="28"/>`).join('');
    ed.w = w;
    ed.h = h;
    pintarQuad();
  }

  function pintarQuad() {
    const svg = $('#editorSvg'), pts = ed.quad.map(q => [q.x * ed.w, q.y * ed.h]);
    svg.querySelector('.ed-poligono').setAttribute('points', pts.map(p => p.join(',')).join(' '));
    svg.querySelector('.ed-sombra').setAttribute('d', `M0 0H${ed.w}V${ed.h}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z`);
    svg.querySelectorAll('circle').forEach(c => {
      const p = pts[Number(c.dataset.i)];
      c.setAttribute('cx', p[0]);
      c.setAttribute('cy', p[1]);
    });
  }

  /** Punto tocado → coordenadas de la imagen (0..1), considerando el giro de la vista. */
  function puntoEditor(e) {
    const r = $('#editorEscena').getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const a = -ed.rot * Math.PI / 180, dx = e.clientX - cx, dy = e.clientY - cy;
    const x = dx * Math.cos(a) - dy * Math.sin(a) + ed.w / 2, y = dx * Math.sin(a) + dy * Math.cos(a) + ed.h / 2;
    return { x: Math.min(1, Math.max(0, x / ed.w)), y: Math.min(1, Math.max(0, y / ed.h)) };
  }

  function pintarModo() {
    $('#edModoTexto').textContent = ed && ed.modo === 'color' ? 'Color' : 'B/N';
  }

  function aplicarEdicion() {
    const { p, fuente, quad, rot, modo } = ed;
    Object.assign(p, { quad, rot, modo, procesando: true });
    est.lectura = null;
    cerrarCapa();
    pintarPaginas();
    cadena = cadena.then(async () => {
      try {
        const nuevo = await Escaner.procesar(fuente, p);
        liberar(p);
        Object.assign(p, nuevo);
        p.miniUrl = URL.createObjectURL(p.mini);
      } catch (e) {
        toast('No se pudo procesar la página');
      }
      p.procesando = false;
      pintarPaginas();
      guardarSesion();
    });
  }

  function borrarPagina() {
    const p = ed.p;
    liberar(p);
    est.paginas = est.paginas.filter(x => x !== p);
    est.lectura = null;
    guardarSesion();
    cerrarCapa(est.paginas.length ? null : 'inicio');
  }

  // ---------- Datos del gasto ----------

  function llenarSelect(el, valores) {
    const actual = el.value;
    el.innerHTML = valores.map(v => `<option>${esc(v)}</option>`).join('');
    if (valores.includes(actual)) el.value = actual;
  }

  function limpiarFormulario() {
    ['fFecha', 'fMonto', 'fNumero', 'fProveedor', 'fRut', 'fCeco', 'fDetalle', 'fObs', 'fEmpresa', 'fAsistentes', 'fMotivo']
      .forEach(id => { document.getElementById(id).value = ''; });
    $$('.sugerido, .invalido').forEach(el => el.classList.remove('sugerido', 'invalido'));
    $('#fRinde').value = Api.config().nombre || '';
    ['#lectura', '#sugMonto', '#controlTarjeta', '#grupoRepresentacion'].forEach(s => { $(s).hidden = true; });
    $('#rutEstado').textContent = '';
    $('#cecoEstado').textContent = '';
  }

  function prepararDatos() {
    const L = listas();
    llenarSelect($('#fTipo'), L.tiposDoc);
    llenarSelect($('#fMedio'), L.medios);
    $('#listaCecos').innerHTML = L.cecos.map(c => `<option value="${esc(c.codigo)}">${esc(c.significado || '')}</option>`).join('');
    $('#fFecha').max = hoyISO();          // sin fecha por defecto: el mes de la rendición lo define la fecha del documento
    if (!$('#fRinde').value) $('#fRinde').value = Api.config().nombre || '';
    elegirMovimiento(est.movimiento);
  }

  function elegirMovimiento(mov) {
    est.movimiento = mov;
    $$('#segMovimiento button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.valor === mov)));
    const gasto = GASTOS.includes(mov);
    $('#grupoCategoria').hidden = !gasto;
    $('#campoCeco').hidden = !gasto;
    if (!est.tocados.has('medio')) {
      $('#fMedio').value = mov === 'Desembolso MP' ? 'Tarjeta MP' : mov === 'Rendición Santander' ? 'Tarjeta Santander' : 'Transferencia Santander';
    }
    if (gasto) {
      if (est.categoria === 'Recarga caja chica') est.categoria = '';
      $('#fDetalle').placeholder = '¿Qué se compró y para qué?';
      if (!est.tocados.has('tipoDoc') && $('#fTipo').value === 'Comprobante de transferencia') $('#fTipo').value = 'Boleta electrónica';
    } else {
      est.categoria = 'Recarga caja chica';
      $('#fDetalle').placeholder = 'Ej: recarga de caja chica desde Santander';
      if (!est.tocados.has('tipoDoc')) $('#fTipo').value = 'Comprobante de transferencia';
    }
    pintarCategorias();
    pintarControlTarjeta();
  }

  function pintarCategorias() {
    const cont = $('#chipsCategoria');
    cont.innerHTML = '';
    listas().categorias.filter(c => c.nombre !== 'Recarga caja chica').forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.nombre;
      b.setAttribute('aria-pressed', String(est.categoria === c.nombre));
      b.onclick = () => elegirCategoria(c);
      cont.appendChild(b);
    });
    $('#grupoRepresentacion').hidden = !(GASTOS.includes(est.movimiento) && est.categoria === 'Atención a clientes');
  }

  function elegirCategoria(c) {
    est.categoria = c.nombre;
    $('#chipsCategoria').classList.remove('invalido');
    if (!est.tocados.has('ceco')) {
      $('#fCeco').value = c.ceco || '';
      validarCeco();
    }
    pintarCategorias();
  }

  function validarRut() {
    const el = $('#fRut'), s = $('#rutEstado'), v = el.value.trim();
    if (!v) { s.textContent = ''; s.className = ''; return true; }
    const r = rutInfo(v);
    if (!r) { s.textContent = 'Formato no válido'; s.className = 'alerta'; return false; }
    el.value = r.texto;
    if (r.texto === '78.083.138-3') { s.textContent = 'Es el RUT de Telconsulting, no del proveedor'; s.className = 'alerta'; return false; }
    s.textContent = r.ok ? 'RUT válido' : 'Dígito verificador no válido';
    s.className = r.ok ? 'ok' : 'alerta';
    return r.ok;
  }

  function validarCeco() {
    const el = $('#fCeco'), s = $('#cecoEstado'), v = el.value.trim();
    if (!v) { s.textContent = ''; s.className = ''; return true; }
    const c = listas().cecos.find(x => x.codigo.toLowerCase() === v.toLowerCase());
    if (c) {
      if (c.codigo !== v) el.value = c.codigo;
      s.textContent = c.significado || 'En el catálogo oficial';
      s.className = 'ok';
      return true;
    }
    s.textContent = 'No está en el catálogo oficial de CeCo';
    s.className = 'alerta';
    return false;
  }

  async function leerDocumento() {
    const id = ++est.lecturaId;
    est.lectura = null;
    pintarLectura('leyendo');
    if (!Api.configurada()) { pintarLectura('sin-config'); return; }
    try {
      let datos;
      if (est.pdf) {
        if (est.pdf.blob.size > 6 * 1048576) { pintarLectura('grande'); return; }
        datos = { pdf: await aBase64(est.pdf.blob) };
      } else {
        datos = { paginas: [] };
        for (const p of est.paginas.slice(0, 6)) datos.paginas.push({ b64: await aBase64(p.salida), tipo: 'image/jpeg' });
      }
      const r = await Api.llamar('ocr', datos, { espera: 90000 });
      if (id !== est.lecturaId) return;
      est.lectura = r;
      aplicarSugeridos(r);
      pintarLectura(r.sugeridos && r.sugeridos.fecha ? 'ok' : 'ok-sin-fecha');
      pintarControlTarjeta();
      revisarMonto();
    } catch (e) {
      if (id !== est.lecturaId) return;
      pintarLectura(e.codigo === 'red' ? 'sin-red' : 'error', e.message);
    }
  }

  function pintarLectura(estado, detalle) {
    const el = $('#lectura'), ico = n => `<svg class="ico"><use href="#${n}"/></svg>`;
    const textos = {
      leyendo: '<span class="girando"></span><span>Leyendo el documento…</span>',
      ok: `${ico('i-check')}<span>Datos sugeridos desde el documento. Revísalos antes de guardar.</span>`,
      'ok-sin-fecha': `${ico('i-alerta')}<span>Datos sugeridos, pero no se leyó la fecha: ingrésala.</span>`,
      'sin-red': `${ico('i-nube')}<span>Sin conexión: completa los datos a mano.</span>`,
      'sin-config': `${ico('i-alerta')}<span>Vincula la app en Ajustes para leer el documento.</span>`,
      grande: `${ico('i-alerta')}<span>El PDF es muy grande para leerlo: completa los datos a mano.</span>`,
      error: `${ico('i-alerta')}<span>No se pudo leer el documento (${esc(detalle || 'error')}). Completa a mano.</span>`
    };
    el.className = 'lectura' + (estado === 'ok' ? ' ok' : estado === 'leyendo' ? '' : ' error');
    el.innerHTML = textos[estado];
    el.hidden = false;
  }

  function aplicarSugeridos(r) {
    const s = r.sugeridos || {};
    const poner = (campo, el, valor) => {
      if (valor === null || valor === undefined || valor === '' || est.tocados.has(campo)) return;
      el.value = valor;
      el.classList.add('sugerido');
    };
    poner('fecha', $('#fFecha'), s.fecha);
    if (s.monto) poner('monto', $('#fMonto'), miles(s.monto));
    if (s.tipoDoc && opciones('#fTipo').includes(s.tipoDoc)) poner('tipoDoc', $('#fTipo'), s.tipoDoc);
    poner('numero', $('#fNumero'), s.numero);
    poner('proveedor', $('#fProveedor'), s.proveedor);
    poner('rut', $('#fRut'), s.rut);
    validarRut();
    if (!est.tocados.has('medio') && est.movimiento === 'Desembolso MP') {
      const t = r.tarjetas && r.tarjetas['Tarjeta MP'];
      if (t && t.resultado === 'coincide') $('#fMedio').value = 'Tarjeta MP';
      else if (r.mercadoPago && opciones('#fMedio').includes('QR Mercado Pago')) $('#fMedio').value = 'QR Mercado Pago';
    }
  }

  function revisarMonto() {
    const nota = $('#sugMonto'), s = est.lectura && est.lectura.sugeridos;
    const leido = s && s.montoConfianza !== 'baja' && s.monto, escrito = Number(soloDigitos($('#fMonto').value));
    if (!leido || !escrito || leido === escrito) { nota.hidden = true; return; }
    nota.innerHTML = `<span>El documento dice <strong>${clp(leido)}</strong></span><button type="button" class="btn-texto">Usar</button>`;
    nota.querySelector('button').onclick = () => { $('#fMonto').value = miles(leido); nota.hidden = true; };
    nota.hidden = false;
  }

  function pintarControlTarjeta() {
    const el = $('#controlTarjeta'), medio = $('#fMedio').value;
    const t = /^Tarjeta/.test(medio) && est.lectura && est.lectura.tarjetas && est.lectura.tarjetas[medio];
    if (!t) { el.hidden = true; return; }
    const cuatro = x => '****' + x;
    const casos = {
      coincide: ['ok', 'i-check', `Tarjeta de la empresa verificada en el documento (${esc(String(t.texto || '').replace(/^✓\s*/, ''))})`],
      otra: ['alerta', 'i-alerta', `El documento muestra otra tarjeta (${esc((t.encontradas || []).map(cuatro).join(', '))})`],
      posible: ['revisar', 'i-alerta', 'Aparecen los dígitos de la tarjeta, pero no junto a la palabra tarjeta: revisa'],
      no_aparece: ['info', 'i-alerta', 'El documento no muestra la tarjeta (es normal en muchas boletas)'],
      sin_config: ['info', 'i-ajustes', 'Ingresa los 4 dígitos de la tarjeta en Ajustes para verificarla']
    };
    const c = casos[t.resultado];
    if (!c) { el.hidden = true; return; }
    el.className = 'control ' + c[0];
    el.innerHTML = `<svg class="ico"><use href="#${c[1]}"/></svg><span>${c[2]}</span>`;
    el.hidden = false;
  }

  function leerFormulario() {
    const gasto = GASTOS.includes(est.movimiento);
    return {
      movimiento: est.movimiento,
      fecha: $('#fFecha').value,
      monto: Number(soloDigitos($('#fMonto').value)),
      tipoDoc: $('#fTipo').value,
      numero: $('#fNumero').value.trim(),
      proveedor: $('#fProveedor').value.trim(),
      rut: $('#fRut').value.trim(),
      detalle: $('#fDetalle').value.trim(),
      categoria: gasto ? est.categoria : 'Recarga caja chica',
      ceco: gasto ? $('#fCeco').value.trim() : '',
      medio: $('#fMedio').value,
      rinde: $('#fRinde').value.trim(),
      observaciones: $('#fObs').value.trim(),
      representacion: gasto && est.categoria === 'Atención a clientes'
        ? { empresa: $('#fEmpresa').value.trim(), asistentes: $('#fAsistentes').value.trim(), motivo: $('#fMotivo').value.trim() }
        : null
    };
  }

  function validar(d) {
    $$('.invalido').forEach(el => el.classList.remove('invalido'));
    const falla = (sel, mensaje) => {
      const el = $(sel);
      el.classList.add('invalido');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return mensaje;
    };
    if (!hayDocumento()) return 'Falta el documento';
    if (!d.fecha) return falla('#fFecha', 'Falta la fecha del documento');
    if (d.fecha > hoyISO()) return falla('#fFecha', 'La fecha no puede ser futura');
    if (!(d.monto > 0)) return falla('#fMonto', 'Falta el monto');
    if (!d.detalle) return falla('#fDetalle', 'Escribe qué se compró y para qué');
    if (GASTOS.includes(d.movimiento) && !d.categoria) return falla('#chipsCategoria', 'Elige una categoría');
    if (d.representacion && !d.representacion.empresa) return falla('#fEmpresa', 'Falta la empresa cliente');
    if (d.representacion && !d.representacion.motivo) return falla('#fMotivo', 'Falta el motivo comercial');
    if (d.rut && !validarRut()) return falla('#fRut', 'Revisa el RUT del proveedor (o déjalo vacío)');
    // Sin las listas del servidor no se bloquea el CeCo: el servidor lo valida igual y deja la alerta.
    if (d.ceco && est.listas && !validarCeco()) return falla('#fCeco', 'El centro de costo no está en el catálogo oficial');
    return null;
  }

  async function armarArchivo(d) {
    if (est.pdf) return { blob: est.pdf.blob, paginas: null, nombreOriginal: est.pdf.nombre };
    let pags = est.paginas.map(p => ({ salida: p.salida, ancho: p.ancho, alto: p.alto }));
    if ($('#chkUnir').checked && pags.length > 1) pags = [await Escaner.unirTira(pags)];
    const paginasPdf = [];
    for (const p of pags) paginasPdf.push({ jpeg: new Uint8Array(await p.salida.arrayBuffer()), ancho: p.ancho, alto: p.alto });
    const titulo = [d.tipoDoc, d.numero, d.proveedor].filter(Boolean).join(' ') || 'Respaldo caja chica';
    return { blob: Pdf.crear(paginasPdf, { titulo, autor: d.rinde || 'Telconsulting' }), paginas: est.paginas.length, nombreOriginal: null };
  }

  async function guardar(forzar) {
    if (est.guardando) return;
    const d = leerFormulario(), error = validar(d);
    if (error) { toast(error); return; }
    if (est.paginas.some(p => p.procesando)) { toast('Espera a que terminen de procesarse las páginas'); return; }
    const boton = $('#btnGuardar');
    est.guardando = true;
    boton.disabled = true;
    boton.textContent = 'Armando el PDF…';
    let payload = null, reintentar = false;
    try {
      const archivo = await armarArchivo(d);
      if (archivo.blob.size > MAX_BYTES) throw new Api.ErrorApi('El documento supera 20 MB', 'tamano');
      payload = {
        datos: d,
        archivo: { b64: await aBase64(archivo.blob), paginas: archivo.paginas, nombreOriginal: archivo.nombreOriginal },
        ocr: est.lectura ? { texto: est.lectura.texto, firma: est.lectura.firma } : null,
        meta: { capturadoEn: est.capturadoEn, origen: est.origen, dispositivo: navigator.userAgent, versionApp: VERSION },
        forzar: !!forzar
      };
      if (!Api.configurada()) throw new Api.ErrorApi('La app aún no está vinculada', 'config');
      boton.textContent = 'Guardando en Drive…';
      const r = await Api.llamar('guardar', payload, { espera: 150000 });
      await terminarSesion();
      mostrarListo(r, d, null);
    } catch (e) {
      if (e.codigo === 'duplicado' && e.datos && e.datos.duplicado) {
        const dup = e.datos.duplicado, cuando = `${dup.id} (${fechaCorta(dup.fecha)} · ${clp(dup.monto)})`;
        if (dup.mismoArchivo) {
          await preguntar('Ya está registrado', `Este mismo documento ya está guardado como ${cuando}.`, 'Entendido', null);
        } else {
          reintentar = await preguntar('¿Documento repetido?', `Parece que ya está registrado como ${cuando}.\nMotivo: ${dup.motivo}.`, 'Guardar igual', 'No guardar');
        }
      } else if ((e.codigo === 'red' || e.codigo === 'config') && payload) {
        await Api.encolar(payload);
        await terminarSesion();
        mostrarListo(null, d, e.codigo);
      } else {
        toast('No se pudo guardar: ' + e.message, 6000);
      }
    } finally {
      est.guardando = false;
      boton.disabled = false;
      boton.textContent = 'Guardar en Drive';
    }
    if (reintentar) guardar(true);
  }

  async function terminarSesion() {
    est.paginas.forEach(liberar);
    est.paginas = [];
    est.pdf = null;
    est.lecturaId++;
    try { await DB.borrar('sesion', 'actual'); } catch (e) { /* nada que borrar */ }
  }

  function mostrarListo(r, d, enCola) {
    const icono = $('#listoIcono');
    icono.classList.toggle('cola', !!enCola);
    icono.innerHTML = `<svg class="ico"><use href="#${enCola ? 'i-nube' : 'i-check'}"/></svg>`;
    $('#listoTitulo').textContent = enCola ? 'Guardado en el teléfono' : 'Respaldado en Drive';
    $('#listoId').textContent = r ? r.id + (r.prueba ? ' · prueba' : '') : '';
    $('#listoDetalle').textContent = enCola
      ? (enCola === 'config' ? 'Se enviará a Drive cuando vincules la app en Ajustes.' : 'Se enviará a Drive apenas haya conexión.')
      : [d.tipoDoc + (d.numero ? ' ' + d.numero : ''), d.proveedor, clp(d.monto)].filter(Boolean).join(' · ');
    const controles = $('#listoControles');
    controles.innerHTML = '';
    if (r) {
      const t = String(r.controlTarjeta || '');
      if (t && t !== 'No aplica') {
        const clase = t[0] === '✓' ? 'ok' : t[0] === '✗' ? 'alerta' : 'revisar';
        controles.insertAdjacentHTML('beforeend', `<div class="control ${clase}"><span>Control tarjeta: ${esc(t)}</span></div>`);
      }
      (r.alertas || []).forEach(a => controles.insertAdjacentHTML('beforeend',
        `<div class="control revisar"><svg class="ico"><use href="#i-alerta"/></svg><span>${esc(a)}</span></div>`));
      $('#lnkPdf').href = enlaceSeguro(r.respaldoUrl);
      $('#lnkFila').href = enlaceSeguro(r.planillaUrl);
    }
    $('#listoEnlaces').hidden = !r;
    history.replaceState({ vista: 'listo', prof: profundidad() }, '');
    mostrar('listo');
    pintarCola();
  }

  // ---------- Ajustes y vinculación ----------

  function cargarAjustes() {
    const c = Api.config();
    $('#aUrl').value = c.url || '';
    $('#aToken').value = c.token || '';
    $('#aNombre').value = c.nombre || '';
    $('#aTarjetaMP').value = '';
    $('#aTarjetaSan').value = '';
    $('#aTarjetaMP').placeholder = (est.tarjetas && est.tarjetas.mp) || 'Últimos 4';
    $('#aTarjetaSan').placeholder = (est.tarjetas && est.tarjetas.santander) || 'Opcional';
    $('#estadoConexion').textContent = '';
    $('#version').textContent = `App Caja Chica v${VERSION} · Telconsulting`;
  }

  function leerConexion() {
    const url = $('#aUrl').value.trim(), token = $('#aToken').value.trim();
    if (url && !URL_SERVIDOR.test(url)) { toast('La dirección debe ser la del servidor y terminar en /exec'); return null; }
    return { url, token };
  }

  async function guardarAjustes() {
    const conexion = leerConexion();
    if (!conexion) return;
    const mp = soloDigitos($('#aTarjetaMP').value), san = soloDigitos($('#aTarjetaSan').value);
    if ((mp && mp.length !== 4) || (san && san.length !== 4)) { toast('Ingresa solo los últimos 4 dígitos de cada tarjeta'); return; }
    Api.guardarConfig(Object.assign(conexion, { nombre: $('#aNombre').value.trim() }));
    if (mp || san) {
      try {
        const r = await Api.llamar('configurar', Object.assign({}, mp ? { tarjetaMP: mp } : {}, san ? { tarjetaSantander: san } : {}));
        est.tarjetas = r.tarjetas || {};
        guardarLocal('tarjetas', est.tarjetas);
      } catch (e) {
        toast('Se guardó la conexión, pero no las tarjetas: ' + e.message, 6000);
        return;
      }
    }
    toast('Ajustes guardados');
    cargarConfig();
    history.back();
  }

  async function probarConexion() {
    const conexion = leerConexion(), el = $('#estadoConexion');
    if (!conexion) return;
    Api.guardarConfig(conexion);
    el.className = 'estado-conexion';
    el.textContent = 'Probando…';
    try {
      const r = await Api.llamar('ping');
      el.textContent = `Conectado ✓ ${r.cuenta ? '· ' + r.cuenta : ''} · servidor v${r.version}`;
      el.classList.add('ok');
      cargarConfig();
    } catch (e) {
      el.textContent = e.message;
      el.classList.add('error');
    }
  }

  async function cargarConfig() {
    if (!Api.configurada()) return;
    try {
      const r = await Api.llamar('config');
      est.listas = r.listas;
      est.tarjetas = r.tarjetas || {};
      guardarLocal('listas', r.listas);
      guardarLocal('tarjetas', est.tarjetas);
      if (est.vista === 'datos') { pintarCategorias(); validarCeco(); }
    } catch (e) {
      if (e.codigo === 'clave') toast('La clave de acceso no es válida: revisa Ajustes', 5000);
    }
  }

  /** Enlace de vinculación: …/#vincular=<base64url de {u: url, t: clave, n: nombre}>. El "#" no viaja a ningún servidor web. */
  async function vincularDesdeEnlace() {
    const m = location.hash.match(/^#vincular=([\w-]+)/);
    if (!m) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    let datos;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      datos = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
      if (!URL_SERVIDOR.test(datos.u || '') || !datos.t || String(datos.t).length < 24) throw new Error('incompleto');
    } catch (e) {
      toast('El enlace de vinculación no es válido');
      return;
    }
    const actual = Api.config();
    if (actual.url && (actual.url !== datos.u || actual.token !== datos.t)) {
      const si = await preguntar('Cambiar vinculación', 'Este enlace conecta la app con otro servidor. Acéptalo solo si te lo entregó Administración y Finanzas.', 'Reemplazar', 'Cancelar');
      if (!si) return;
    }
    Api.guardarConfig({ url: datos.u, token: datos.t, nombre: datos.n || actual.nombre || '' });
    toast('App vinculada con Drive ✓');
    $('#avisoConfig').hidden = true;
    cargarConfig();
    refrescarResumen(false);
  }

  /** Archivos recibidos con "Compartir" desde otra app (WhatsApp, Gmail, Galería…). */
  async function recibirCompartidos() {
    let lista = null;
    try {
      lista = await DB.leer('compartidos', 'ultimo');
      await DB.borrar('compartidos', 'ultimo');
    } catch (e) { lista = null; }
    history.replaceState(history.state, '', location.pathname);
    if (!lista || !lista.length) return;
    const pdf = lista.find(a => a.tipo === 'application/pdf');
    if (pdf) {
      if (!(await descartarSiHay())) { toast('Se conservó la captura anterior: comparte el PDF de nuevo después', 5000); return; }
      nuevaCaptura();
      usarPdf(pdf.blob, pdf.nombre, 'compartido');
      return;
    }
    const imagenes = lista.filter(a => /^image\//.test(a.tipo));
    if (!imagenes.length) return;
    if (est.paginas.length) {
      const agregar = await preguntar('Captura sin terminar', `Tienes ${paginasTexto(est.paginas.length)} sin guardar. ¿Agrego lo compartido a esa captura?`, 'Agregar', 'Empezar de cero');
      if (!agregar) nuevaCaptura();
    } else {
      nuevaCaptura();
    }
    ir('paginas');
    imagenes.forEach(a => agregarFoto(a.blob, 'compartido'));
  }

  // ---------- Instalación en el teléfono ----------

  /** Botón "Instalar" propio: Chrome ofrece la instalación y la app la muestra sin tener que buscarla en el menú. */
  function prepararInstalacion() {
    const instalada = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (instalada) return;
    let pedido = null;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      pedido = e;
      $('#avisoInstalar').hidden = false;
      $('#avisoNavegador').hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      pedido = null;
      $('#avisoInstalar').hidden = true;
      toast('App instalada ✓ Ábrela desde el ícono "Caja Chica"', 6000);
    });
    $('#btnInstalar').onclick = async () => {
      if (!pedido) return;
      pedido.prompt();
      const r = await pedido.userChoice.catch(() => null);
      pedido = null;
      $('#avisoInstalar').hidden = true;
      if (r && r.outcome === 'accepted') toast('Instalando… aparecerá el ícono "Caja Chica"', 6000);
    };
    // Navegadores que no instalan apps (p. ej. el de Xiaomi): se indica abrir el enlace en Chrome
    if (/MiuiBrowser|XiaoMi|HeyTap|OPR\/|Firefox/i.test(navigator.userAgent) || !/Chrome\//.test(navigator.userAgent)) {
      $('#avisoNavegador').hidden = false;
    }
  }

  // ---------- Eventos ----------

  function enlazar() {
    $('#btnVolver').onclick = () => history.back();
    $('#btnAjustes').onclick = () => ir('ajustes');
    $$('[data-ir]').forEach(b => { b.onclick = () => (b.dataset.ir === 'inicio' ? volverInicio() : ir(b.dataset.ir)); });

    $('#btnEscanear').onclick = async () => { if (await descartarSiHay()) { nuevaCaptura(); abrirCamara(); } };
    $('#btnGaleria').onclick = async () => { if (await descartarSiHay()) { nuevaCaptura(); $('#inGaleria').click(); } };
    $('#btnPdf').onclick = async () => { if (await descartarSiHay()) { nuevaCaptura(); $('#inPdf').click(); } };
    $('#btnRefrescar').onclick = () => refrescarResumen(true);
    $('#btnEnviarCola').onclick = enviarColaManual;
    $('#btnDescartarCola').onclick = descartarBloqueados;
    $('#btnRetomar').onclick = () => { $('#avisoSesion').hidden = true; pintarPaginas(); ir('paginas'); };
    $('#btnDescartar').onclick = () => { nuevaCaptura(); $('#avisoSesion').hidden = true; };

    $('#inGaleria').onchange = e => tomarArchivos(e, 'galeria');
    $('#inCamaraNativa').onchange = e => tomarArchivos(e, 'camara');
    $('#inPdf').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) usarPdf(f, f.name, 'pdf');
    };

    $('#btnMasCamara').onclick = () => abrirCamara();
    $('#btnMasGaleria').onclick = () => $('#inGaleria').click();
    $('#btnContinuar').onclick = () => { ir('datos'); prepararDatos(); leerDocumento(); };
    $('#chkUnir').onchange = () => guardarSesion();

    $('#btnDisparar').onclick = disparar;
    $('#btnCerrarCamara').onclick = () => cerrarCapa(est.paginas.length ? 'paginas' : null);
    $('#btnListoCamara').onclick = () => cerrarCapa('paginas');
    $('#contador').onclick = () => { if (est.paginas.length) cerrarCapa('paginas'); };
    $('#btnFlash').onclick = () => {
      if (!flujo) return;
      linterna = !linterna;
      flujo.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: linterna }] }).catch(() => {});
      $('#btnFlash').classList.toggle('activo', linterna);
    };

    const svg = $('#editorSvg');
    svg.addEventListener('pointerdown', e => {
      if (!ed || e.target.dataset.i === undefined) return;
      arrastre = Number(e.target.dataset.i);
      e.target.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (arrastre === null || !ed) return;
      ed.quad[arrastre] = puntoEditor(e);
      pintarQuad();
    });
    ['pointerup', 'pointercancel'].forEach(t => svg.addEventListener(t, () => { arrastre = null; }));
    $('#edGirar').onclick = () => { ed.rot = (ed.rot + 90) % 360; dibujarEditor(); };
    $('#edAuto').onclick = () => {
      const q = Escaner.detectar(ed.fuente);
      if (!q) toast('No se distingue el borde: ajusta las esquinas a mano');
      ed.quad = (q || Escaner.COMPLETA).map(p => Object.assign({}, p));
      pintarQuad();
    };
    $('#edTodo').onclick = () => { ed.quad = Escaner.COMPLETA.map(p => Object.assign({}, p)); pintarQuad(); };
    $('#edModo').onclick = () => { ed.modo = ed.modo === 'color' ? 'documento' : 'color'; pintarModo(); };
    $('#edBorrar').onclick = borrarPagina;
    $('#edListo').onclick = aplicarEdicion;
    window.addEventListener('resize', () => { if (ed) dibujarEditor(); });

    Object.keys(CAMPOS).forEach(id => {
      const el = document.getElementById(id), campo = CAMPOS[id];
      const tocar = () => { est.tocados.add(campo); el.classList.remove('sugerido', 'invalido'); };
      el.addEventListener('input', tocar);
      el.addEventListener('change', tocar);
    });
    $('#btnHoy').onclick = () => { $('#fFecha').value = hoyISO(); est.tocados.add('fecha'); $('#fFecha').classList.remove('sugerido', 'invalido'); };
    $('#fMonto').addEventListener('input', e => {
      const d = soloDigitos(e.target.value).replace(/^0+/, '');
      e.target.value = d ? miles(Number(d)) : '';
      revisarMonto();
    });
    $('#fRut').addEventListener('blur', validarRut);
    $('#fCeco').addEventListener('input', validarCeco);
    $('#fMedio').addEventListener('change', pintarControlTarjeta);
    $('#segMovimiento').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) elegirMovimiento(b.dataset.valor);
    });
    $('#form').addEventListener('submit', e => e.preventDefault());
    $('#btnGuardar').onclick = () => guardar(false);

    $('#btnOtro').onclick = () => volverInicio(() => { nuevaCaptura(); abrirCamara(); });
    $('#btnGuardarAjustes').onclick = guardarAjustes;
    $('#btnProbar').onclick = probarConexion;
    window.addEventListener('online', () => enviarCola(true));
  }

  async function iniciar() {
    history.replaceState({ vista: 'inicio', prof: 0 }, '');
    $('#avisoDemo').hidden = !Api.demo;
    est.listas = leerLocal('listas');
    est.tarjetas = leerLocal('tarjetas') || {};
    prepararInstalacion();
    enlazar();
    await restaurarSesion();
    mostrar('inicio');
    await vincularDesdeEnlace();
    cargarConfig();
    enviarCola(true);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    const q = new URLSearchParams(location.search);
    if (q.has('compartido')) await recibirCompartidos();
    else if (q.get('accion') === 'escanear' && await descartarSiHay()) { nuevaCaptura(); abrirCamara(); }

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      const habiaControlador = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (habiaControlador && est.vista === 'inicio' && !hayDocumento() && !est.guardando) location.reload();
      });
    }
  }

  iniciar();
})();
