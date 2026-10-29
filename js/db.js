/* Almacenamiento local en el teléfono (IndexedDB): captura en curso, cola sin conexión y archivos compartidos.
   Lo usan la app y el service worker. El modo demostración (?demo) usa una base aparte. */
const DB = (() => {
  const ALMACENES = ['sesion', 'cola', 'compartidos'];
  const NOMBRE = typeof location !== 'undefined' && /[?&]demo\b/.test(location.search) ? 'caja-chica-demo' : 'caja-chica';
  let conexion;

  function abrir() {
    if (!conexion) {
      conexion = new Promise((ok, mal) => {
        const r = indexedDB.open(NOMBRE, 1);
        r.onupgradeneeded = () => {
          for (const nombre of ALMACENES) {
            if (!r.result.objectStoreNames.contains(nombre)) r.result.createObjectStore(nombre);
          }
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => mal(r.error);
      });
    }
    return conexion;
  }

  async function operar(almacen, modo, accion) {
    const db = await abrir();
    return new Promise((ok, mal) => {
      const t = db.transaction(almacen, modo);
      const pedido = accion(t.objectStore(almacen));
      t.oncomplete = () => ok(pedido ? pedido.result : undefined);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error || new Error('Operación cancelada'));
    });
  }

  return {
    leer: (almacen, clave) => operar(almacen, 'readonly', s => s.get(clave)),
    guardar: (almacen, clave, valor) => operar(almacen, 'readwrite', s => s.put(valor, clave)),
    borrar: (almacen, clave) => operar(almacen, 'readwrite', s => s.delete(clave)),
    todos: almacen => operar(almacen, 'readonly', s => s.getAll())
  };
})();
