/* Comunicación con el servidor (Apps Script de la cuenta de Telconsulting) y cola sin conexión. */
const Api = (() => {
  const demo = new URLSearchParams(location.search).has('demo');
  const CLAVE = demo ? 'cc-demo.config' : 'cc.config';

  class ErrorApi extends Error {
    constructor(mensaje, codigo, datos) { super(mensaje); this.codigo = codigo; this.datos = datos; }
  }

  function config() {
    try { return JSON.parse(localStorage.getItem(CLAVE)) || {}; } catch (e) { return {}; }
  }
  function guardarConfig(cambios) {
    localStorage.setItem(CLAVE, JSON.stringify(Object.assign(config(), cambios)));
  }
  const configurada = () => demo || !!(config().url && config().token);

  async function llamar(accion, datos = {}, { espera = 60000 } = {}) {
    if (demo) return Demo.responder(accion, datos);
    const { url, token } = config();
    if (!url || !token) throw new ErrorApi('Falta vincular la app con Drive (Ajustes)', 'config');
    if (!navigator.onLine) throw new ErrorApi('Sin conexión a internet', 'red');
    const control = new AbortController(), reloj = setTimeout(() => control.abort(), espera);
    let respuesta;
    try {
      // Cuerpo en texto plano: evita la verificación previa (CORS) que Apps Script no responde.
      respuesta = await fetch(url, {
        method: 'POST', body: JSON.stringify(Object.assign({ accion, token }, datos)),
        signal: control.signal, redirect: 'follow', cache: 'no-store'
      });
    } catch (e) {
      throw new ErrorApi(e.name === 'AbortError' ? 'El servidor tardó demasiado en responder' : 'Sin conexión con el servidor', 'red');
    } finally {
      clearTimeout(reloj);
    }
    const texto = await respuesta.text();
    let j;
    try { j = JSON.parse(texto); } catch (e) {
      throw new ErrorApi(respuesta.ok ? 'Respuesta inesperada: revisa la dirección del servidor en Ajustes'
        : 'Error del servidor (' + respuesta.status + ')', 'servidor');
    }
    if (!j.ok) throw new ErrorApi(j.error || 'Error del servidor', j.codigo || 'servidor', j);
    return j;
  }

  // ---------- Cola sin conexión ----------

  /** Guarda un envío para cuando vuelva la conexión. accion: 'guardar' (documento) o 'entregarTarjeta' (acta). */
  async function encolar(payload, accion) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await DB.guardar('cola', id, { id, accion: accion || 'guardar', payload, creado: new Date().toISOString(), intentos: 0 });
    return id;
  }

  const pendientes = async () => (await DB.todos('cola')) || [];

  /** Envía lo que esté en cola, de a un envío a la vez. Los que fallaron 3 veces solo se reintentan a pedido. */
  let envioEnCurso = null;
  function enviarCola(alAvanzar, incluirBloqueados, guardarRepetidos) {
    if (demo) return Promise.resolve(0);
    if (!envioEnCurso) {
      envioEnCurso = enviarPendientes(alAvanzar, !!incluirBloqueados, !!guardarRepetidos).finally(() => { envioEnCurso = null; });
    }
    return envioEnCurso;
  }

  const enVuelo = new Set();          // envíos que la app está mandando ahora mismo (la cola no los repite en paralelo)

  /**
   * Envía YA un elemento de la cola (el acta recién firmada: se guarda primero en el teléfono y después se manda).
   * Bien → se borra de la cola y devuelve la respuesta. Sin red o sin respuesta → queda en la cola y lanza el error.
   * El servidor la rechaza → se saca de la cola y lanza el error (para corregir los datos en pantalla).
   */
  async function enviarUno(id, espera) {
    const item = await DB.leer('cola', id);
    if (!item) throw new ErrorApi('El envío ya no está en el teléfono', 'servidor');
    enVuelo.add(id);
    try {
      const r = await llamar(item.accion || 'guardar', item.payload, { espera: espera || 150000 });
      await DB.borrar('cola', id);
      return r;
    } catch (e) {
      if (e.codigo !== 'red' && e.codigo !== 'config' && e.codigo !== 'clave') await DB.borrar('cola', id);
      throw e;
    } finally {
      enVuelo.delete(id);
    }
  }

  async function enviarPendientes(alAvanzar, incluirBloqueados, guardarRepetidos) {
    let enviados = 0;
    for (const item of await pendientes()) {
      if (enVuelo.has(item.id)) continue;
      if ((item.intentos || 0) >= 3 && !incluirBloqueados) continue;
      if (item.duplicado && !guardarRepetidos) continue;     // un "parecido" solo se guarda si la persona lo confirma
      try {
        const payload = item.duplicado ? Object.assign({}, item.payload, { forzar: true }) : item.payload;
        // Las actas llevan su idCliente: si ya habían llegado, el servidor devuelve la misma (no se duplican)
        const r = await llamar(item.accion || 'guardar', payload, { espera: 150000 });
        await DB.borrar('cola', item.id);
        enviados++;
        if (alAvanzar) alAvanzar(r, item, null);
      } catch (e) {
        if (e.codigo === 'red' || e.codigo === 'config' || e.codigo === 'clave') break;
        if (e.codigo === 'duplicado') {
          const dup = e.datos && e.datos.duplicado;
          if (dup && dup.mismoArchivo) {          // ya había llegado (se perdió la respuesta): no se repite
            await DB.borrar('cola', item.id);
            if (alAvanzar) alAvanzar(null, item, e);
            continue;
          }
          item.intentos = 3;                      // parecido a otro registro: queda retenido hasta que la persona decida
          item.duplicado = dup || true;
          item.ultimoError = dup ? `parece repetido de ${dup.id} (${dup.motivo})` : 'parece repetido';
          await DB.guardar('cola', item.id, item);
          continue;
        }
        item.intentos = (item.intentos || 0) + 1;
        item.ultimoError = e.message;
        await DB.guardar('cola', item.id, item);
      }
    }
    return enviados;
  }

  const descartar = id => DB.borrar('cola', id);

  return { demo, ErrorApi, config, guardarConfig, configurada, llamar, encolar, enviarUno, pendientes, enviarCola, descartar };
})();

/* Respuestas simuladas para probar la app sin servidor (?demo). */
const Demo = (() => {
  const espera = ms => new Promise(r => setTimeout(r, ms));
  let correlativo = 7;
  const listas = {
    movimientos: ['Desembolso MP', 'Ingreso caja chica', 'Rendición Santander'],
    tiposDoc: ['Boleta electrónica', 'Factura electrónica', 'Factura exenta electrónica', 'Boleta manual',
      'Comprobante de pago', 'Comprobante de transferencia', 'Nota de crédito', 'Guía de despacho', 'Otro'],
    categorias: [
      { nombre: 'Alimentación equipo', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Atención a clientes', ceco: 'ADMTVA-GASVAR-GASCOM' },
      { nombre: 'Movilización y estacionamiento', ceco: '' }, { nombre: 'Combustible', ceco: '' },
      { nombre: 'Materiales y ferretería', ceco: '' }, { nombre: 'Insumos de oficina', ceco: 'ADMVTA-GASVAR-GASADM' },
      { nombre: 'Aseo y cafetería', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Envíos y courier', ceco: '' },
      { nombre: 'Trámites y notaría', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Tecnología y accesorios', ceco: '' },
      { nombre: 'Recarga caja chica', ceco: '' }, { nombre: 'Otros', ceco: '' }
    ],
    medios: ['Tarjeta MP', 'QR Mercado Pago', 'Transferencia MP', 'Tarjeta Santander', 'Transferencia Santander', 'Efectivo'],
    estados: ['Pendiente revisión', 'Revisado', 'Conciliado', 'Observado', 'Anulado'],
    cecos: [{ codigo: 'ADMVTA-GASVAR-GASADM', significado: 'Gastos administrativos variables' },
      { codigo: 'ADMTVA-GASVAR-GASCOM', significado: 'Gastos comerciales variables' },
      { codigo: 'nRC-INT-SAT', significado: 'Internet satelital no recurrente' }]
  };
  const base = { movimiento: 'Desembolso MP', tipoDoc: 'Boleta electrónica', rut: '', ceco: '', medio: 'Tarjeta MP', rinde: 'Demo', observaciones: '', conciliacion: '' };
  const ultimos = [
    Object.assign({}, base, { id: 'CC-2026-0006', fecha: '2026-10-27', proveedor: 'COPEC S.A.', numero: '45872310', rut: '99.520.000-7', monto: 25990,
      detalle: 'Combustible camioneta', categoria: 'Combustible', estado: 'Pendiente revisión', controlTarjeta: '✓ ****1234', respaldoUrl: '#' }),
    Object.assign({}, base, { id: 'CC-2026-0005', fecha: '2026-10-24', proveedor: 'Ferretería El Maestro Ltda.', numero: '7781', monto: 59500,
      detalle: 'Materiales instalación', categoria: 'Materiales y ferretería', estado: 'Conciliado', conciliacion: 'MP 24-10 op 1234',
      controlTarjeta: '✓ ****1234', respaldoUrl: '#' }),
    Object.assign({}, base, { id: 'CC-2026-0004', fecha: '2026-10-22', proveedor: 'Estacionamientos Central', numero: '', monto: 12490,
      tipoDoc: 'Comprobante de pago', detalle: 'Estacionamiento visita cliente', categoria: 'Movilización y estacionamiento',
      estado: 'Observado', controlTarjeta: '✗ Otra tarjeta ****5678', respaldoUrl: '#' })
  ];
  const buscar = id => ultimos.find(f => f.id === id);
  // Custodia simulada de la tarjeta: empieza sin entregas; cada acta cambia de titular
  let custodia = [], correlativoActa = 0;
  const huellas = {}, actas = {};
  const normal = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const custodiaPublica = () => custodia.map(c => ({ tarjeta: c.tarjeta, ultimos4: c.ultimos4, titular: c.titular, desde: c.desde, id: c.id, tipo: c.tipo }));

  async function responder(accion, datos) {
    await espera(accion === 'ocr' ? 1600 : accion === 'guardar' ? 1400 : 300);
    switch (accion) {
      case 'ping': return { ok: true, version: 'demo', cuenta: 'demo@telconsulting.cl' };
      case 'config': return { ok: true, listas, tarjetas: { mp: '****1234', santander: '' }, planillaUrl: '#', version: 'demo',
        custodia: custodiaPublica(), huellasQr: Object.assign({}, huellas) };
      case 'configurar': return { ok: true, tarjetas: { mp: '****' + (datos.tarjetaMP || '1234'), santander: '' } };
      case 'resumen': return {
        ok: true, saldo: 154510, planillaUrl: '#', ultimos: ultimos.slice(0, 5), custodia: custodiaPublica(), huellasQr: Object.assign({}, huellas),
        mes: { mes: '2026-10', documentos: 6, desembolsos: 245300, ingresos: 400000, conTarjeta: 5, tarjetaOk: 4 }
      };
      case 'ocr': return {
        ok: true, texto: 'COPEC S.A.\nR.U.T.: 99.520.000-7\nBOLETA ELECTRONICA\nN° 45872310\nTOTAL $ 25.990\n************1234',
        sugeridos: { tipoDoc: 'Boleta electrónica', numero: '45872310', fecha: '2026-10-27', monto: 25990, montoConfianza: 'alta', rut: '99.520.000-7', proveedor: 'COPEC S.A.' },
        tarjetas: { 'Tarjeta MP': { resultado: 'coincide', encontradas: ['1234'], texto: '✓ ****1234' },
          'Tarjeta Santander': { resultado: 'sin_config', encontradas: ['1234'], texto: 'Tarjeta sin configurar' } },
        mercadoPago: false
      };
      case 'guardar': {
        const id = 'CC-2026-' + String(++correlativo).padStart(4, '0'), d = datos.datos || {};
        ultimos.unshift(Object.assign({}, base, d, { id, estado: 'Pendiente revisión', controlTarjeta: '✓ ****1234', respaldoUrl: '#',
          representacion: undefined }));
        return { ok: true, id, fila: 4 + correlativo, respaldoUrl: '#', resumenUrl: '#', planillaUrl: '#', controlTarjeta: '✓ ****1234', alertas: [] };
      }
      case 'historial': return { ok: true, filas: ultimos.slice(), total: ultimos.length };
      case 'registro': {
        const f = buscar(datos.id);
        if (!f) return Promise.reject(new Api.ErrorApi('No existe el registro ' + datos.id, 'servidor'));
        const motivo = f.estado === 'Pendiente revisión' ? '' : 'ya está ' + f.estado.toLowerCase();
        return { ok: true, registro: Object.assign({}, f), representacion: f.categoria === 'Atención a clientes' ? (f.rep || null) : null, deshacer: { permitido: !motivo, motivo } };
      }
      case 'actualizar': {
        const f = buscar(datos.id);
        Object.keys(datos.cambios || {}).forEach(k => { if (k === 'representacion') f.rep = datos.cambios[k]; else f[k] = datos.cambios[k]; });
        return { ok: true, id: datos.id, cambios: Object.keys(datos.cambios || {}) };
      }
      case 'deshacer': {
        const i = ultimos.findIndex(f => f.id === datos.id);
        if (i >= 0) ultimos.splice(i, 1);
        const liberado = Number(datos.id.slice(-4)) === correlativo;
        if (liberado) correlativo--;
        return { ok: true, id: datos.id, deshecho: true, correlativoLiberado: liberado, archivosEnPapelera: 2 };
      }
      case 'entregarTarjeta': {
        if (actas[datos.idCliente]) return Object.assign({}, actas[datos.idCliente], { repetida: true });
        const n = ++correlativoActa, id = 'TE-2026-' + String(n).padStart(4, '0'), ahora = new Date().toISOString();
        const u4 = datos.tarjeta.ultimos4, anterior = custodia.find(c => c.ultimos4 === u4);
        const alertas = anterior && normal(anterior.titular) !== normal(datos.entrega.nombre) ? ['La tarjeta figuraba en poder de ' + anterior.titular] : [];
        if (!datos.lugar || datos.lugar.lat === undefined) alertas.push('Sin ubicación GPS: ' + ((datos.lugar && datos.lugar.error) || 'no disponible'));
        const periodo = datos.tipo === 'Devolución' && anterior
          ? { desde: anterior.desde, hasta: ahora, documentos: 2, monto: 38480, saldoInicial: anterior.saldo === undefined ? null : anterior.saldo,
            saldoFinal: datos.saldo === undefined ? null : datos.saldo }
          : null;
        custodia = custodia.filter(c => c.ultimos4 !== u4).concat([{ tarjeta: '****' + u4, ultimos4: u4, titular: datos.recibe.nombre,
          desde: ahora, id, tipo: datos.tipo, saldo: datos.saldo }]);
        if (datos.tarjeta.qrHuella) huellas[datos.tarjeta.qrHuella] = u4;
        const r = { ok: true, id, codigo: 'A1B2-C3D' + n, actaUrl: '#', fichaUrl: '#', fotoUrl: null, planillaUrl: '#', momentoServidor: ahora,
          direccion: datos.lugar && datos.lugar.lat !== undefined ? 'Av. Providencia 2250, Providencia, Región Metropolitana' : '',
          titular: { tarjeta: '****' + u4, ultimos4: u4, nombre: datos.recibe.nombre, desde: ahora, id }, alertas, periodo };
        actas[datos.idCliente] = r;
        return r;
      }
      case 'anular': {
        const f = buscar(datos.id);
        if (f) { f.estado = 'Anulado'; f.observaciones = 'Anulado: ' + datos.motivo; }
        return { ok: true, id: datos.id, estado: 'Anulado' };
      }
      default: return { ok: true };
    }
  }
  return { responder, listas };
})();
