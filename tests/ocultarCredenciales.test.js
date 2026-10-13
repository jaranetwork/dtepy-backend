const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ocultarCredenciales } = require('../utils/ocultarCredenciales');

test('la contraseña de la URI de MongoDB no llega al log', () => {
  assert.equal(
    ocultarCredenciales('mongodb://mongo:s3cr3t@db-host:27017/sifen_db?authSource=admin&directConnection=true'),
    'mongodb://mongo:***@db-host:27017/sifen_db?authSource=admin&directConnection=true'
  );
});

test('también con srv y caracteres escapados en la contraseña', () => {
  assert.equal(
    ocultarCredenciales('mongodb+srv://admin:p%40ss%3Aword@cluster0.example.net/db'),
    'mongodb+srv://admin:***@cluster0.example.net/db'
  );
});

test('una URI sin credenciales o vacía queda igual', () => {
  assert.equal(ocultarCredenciales('mongodb://localhost:27017/sifen_db'), 'mongodb://localhost:27017/sifen_db');
  assert.equal(ocultarCredenciales(undefined), '');
});
