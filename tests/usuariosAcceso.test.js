const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { empresasDeUsuario, normalizarIdsEmpresa, motivoNoEliminable } = require('../utils/usuariosAcceso');
const {
  condicionAccesoDe, filtroEmpresasVisibles, filtroEmpresasAdministrables, tipoAccesoEmpresa,
  filtroEmpresa, perteneceAlAlcance
} = require('../middleware/alcance');

const id = () => new mongoose.Types.ObjectId();

const FABIAN = id();
const SAMUEL = id();
const OTRO = id();
const KINGSTON = { _id: id(), ruc: '80055783-2', nombreFantasia: 'Kingston Center', usuarioId: FABIAN, usuariosConAcceso: [SAMUEL], activo: true };
const AJENA = { _id: id(), ruc: '80000001-1', razonSocial: 'Otra S.A.', usuarioId: OTRO, usuariosConAcceso: [], activo: true };

const sesion = (usuarioId, rol) => ({ tipoAutenticacion: 'jwt', usuario: { _id: usuarioId, rol } });
const conKey = (usuarioId, rol, empresaId = null) => ({ tipoAutenticacion: 'apikey', usuario: { _id: usuarioId, rol }, apiKey: { empresaId } });

test('empresasDeUsuario: propias como propietario, compartidas como compartida, el resto no', () => {
  const deFabian = empresasDeUsuario(FABIAN, [KINGSTON, AJENA]);
  assert.equal(deFabian.length, 1);
  assert.equal(deFabian[0].acceso, 'propietario');
  assert.equal(deFabian[0].nombre, 'Kingston Center');

  const deSamuel = empresasDeUsuario(SAMUEL, [KINGSTON, AJENA]);
  assert.deepEqual(deSamuel.map((e) => [e.ruc, e.acceso]), [['80055783-2', 'compartida']]);

  assert.deepEqual(empresasDeUsuario(id(), [KINGSTON, AJENA]), []);
  // Sin nombre de fantasía cae a la razón social
  assert.equal(empresasDeUsuario(OTRO, [AJENA])[0].nombre, 'Otra S.A.');
  // Documentos viejos sin el campo no rompen
  assert.deepEqual(empresasDeUsuario(SAMUEL, [{ ...KINGSTON, usuariosConAcceso: undefined }]), []);
});

test('normalizarIdsEmpresa: lista de ids válidos sin repetidos, o null', () => {
  const a = String(id());
  assert.deepEqual(normalizarIdsEmpresa([a, a, { _id: a }]), [a]);
  assert.deepEqual(normalizarIdsEmpresa([]), []);
  assert.equal(normalizarIdsEmpresa('no-es-lista'), null);
  assert.equal(normalizarIdsEmpresa([a, 'xyz']), null);
  assert.equal(normalizarIdsEmpresa([null]), null);
});

test('motivoNoEliminable: ni uno mismo ni el dueño de una empresa', () => {
  const usuario = { _id: SAMUEL, username: 'samuel' };
  assert.equal(motivoNoEliminable({ usuario, solicitanteId: FABIAN, empresasPropias: [] }), null);

  const yo = motivoNoEliminable({ usuario, solicitanteId: SAMUEL, empresasPropias: [] });
  assert.equal(yo.status, 400);
  assert.equal(yo.error, 'AUTO_ELIMINACION');

  const dueno = motivoNoEliminable({ usuario: { _id: FABIAN, username: 'fabian' }, solicitanteId: SAMUEL, empresasPropias: [KINGSTON] });
  assert.equal(dueno.status, 409);
  assert.equal(dueno.error, 'USUARIO_CON_EMPRESAS');
  assert.match(dueno.message, /Kingston Center/);
  assert.match(dueno.message, /Desactivá/);
});

test('filtroEmpresasVisibles: admin todo, usuario propias + compartidas, key atada solo la suya', () => {
  assert.deepEqual(filtroEmpresasVisibles(sesion(FABIAN, 'admin')), {});
  assert.deepEqual(filtroEmpresasVisibles(sesion(SAMUEL, 'usuario')), condicionAccesoDe(SAMUEL));
  assert.deepEqual(condicionAccesoDe(SAMUEL), { $or: [{ usuarioId: SAMUEL }, { usuariosConAcceso: SAMUEL }] });

  // Una API Key de un admin NO abre todo el sistema
  assert.deepEqual(filtroEmpresasVisibles(conKey(FABIAN, 'admin')), condicionAccesoDe(FABIAN));
  assert.deepEqual(filtroEmpresasVisibles(conKey(FABIAN, 'admin', KINGSTON._id)), { _id: KINGSTON._id });
});

test('filtroEmpresasAdministrables: solo el dueño o una sesión admin', () => {
  assert.deepEqual(filtroEmpresasAdministrables(sesion(FABIAN, 'admin')), {});
  assert.deepEqual(filtroEmpresasAdministrables(sesion(SAMUEL, 'usuario')), { usuarioId: SAMUEL });
  assert.deepEqual(filtroEmpresasAdministrables(sesion(SAMUEL, 'contador')), { usuarioId: SAMUEL });
  assert.deepEqual(filtroEmpresasAdministrables(conKey(FABIAN, 'admin')), { usuarioId: FABIAN });
});

test('tipoAccesoEmpresa: propietario > administrador > compartida', () => {
  assert.equal(tipoAccesoEmpresa(sesion(FABIAN, 'admin'), KINGSTON), 'propietario');
  assert.equal(tipoAccesoEmpresa(sesion(FABIAN, 'admin'), AJENA), 'administrador');
  assert.equal(tipoAccesoEmpresa(sesion(SAMUEL, 'usuario'), KINGSTON), 'compartida');
  assert.equal(tipoAccesoEmpresa(conKey(FABIAN, 'admin'), KINGSTON), 'propietario');
  // usuarioId populado
  assert.equal(tipoAccesoEmpresa(sesion(FABIAN, 'usuario'), { ...KINGSTON, usuarioId: { _id: FABIAN } }), 'propietario');
});

test('alcance de documentos: sin cambios para quien ya tenía el alcance resuelto', () => {
  const req = { alcance: { total: false, ids: [KINGSTON._id] } };
  assert.deepEqual(filtroEmpresa(req), { empresaId: { $in: [KINGSTON._id] } });
  assert.equal(perteneceAlAlcance(req, KINGSTON._id), true);
  assert.equal(perteneceAlAlcance(req, AJENA._id), false);
  assert.equal(perteneceAlAlcance(req, null), false);
  assert.deepEqual(filtroEmpresa({ alcance: { total: true, ids: null } }), {});
});
