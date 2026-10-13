/**
 * Sanitización contra inyección de operadores de MongoDB.
 *
 * Express parsea `?estado[$ne]=x` como `{ estado: { $ne: 'x' } }`, y un body
 * JSON puede traer claves `$where`, `$gt`, etc. Si esos objetos llegan a un
 * `find()`/`findOne()` se convierten en operadores de consulta: filtros que
 * se saltan (`{ $ne: null }` matchea cualquier valor) o expresiones
 * arbitrarias.
 *
 * Este middleware recorre body, query y params y ELIMINA toda clave que
 * empiece con `$`, a cualquier profundidad. Los valores no se tocan: un
 * string "$algo" como valor es inofensivo.
 */

function limpiar(objeto, visitados = new WeakSet()) {
  if (objeto === null || typeof objeto !== 'object') return objeto;
  if (visitados.has(objeto)) return objeto; // ciclos
  visitados.add(objeto);

  if (Array.isArray(objeto)) {
    for (const item of objeto) limpiar(item, visitados);
    return objeto;
  }

  for (const clave of Object.keys(objeto)) {
    if (clave.startsWith('$')) {
      delete objeto[clave];
      continue;
    }

    const valor = objeto[clave];
    const esObjetoPlano = valor !== null && typeof valor === 'object' && !Array.isArray(valor);
    const teniaClaves = esObjetoPlano && Object.keys(valor).length > 0;

    limpiar(valor, visitados);

    // Si el valor era un objeto compuesto SOLO por operadores (ej:
    // ?estado[$ne]=x -> { estado: { $ne: 'x' } }), tras limpiarlo queda {}.
    // Dejarlo asi rompe el cast de Mongoose (500): se descarta el campo
    // entero, que equivale a ignorar el filtro inyectado.
    if (teniaClaves && Object.keys(valor).length === 0) {
      delete objeto[clave];
    }
  }
  return objeto;
}

function sanitizarMongo(req, res, next) {
  // req.query puede ser un getter de solo lectura según la versión de
  // Express: se mutan las propiedades del objeto, no la referencia.
  for (const fuente of [req.body, req.query, req.params]) {
    if (fuente && typeof fuente === 'object') limpiar(fuente);
  }
  next();
}

module.exports = { sanitizarMongo, limpiar };
