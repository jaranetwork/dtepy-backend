#!/usr/bin/env node

/**
 * Resetea la contraseña de un usuario existente (sin conocer la anterior).
 * Complementa a crear-admin.js: ese crea, este resetea.
 *
 * Uso: node resetear-password.js <email-o-username> <password-nuevo>
 */

const mongoose = require('mongoose');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const User = require('./models/User');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';

async function resetearPassword(identificador, passwordNuevo) {
  if (!identificador || !passwordNuevo) {
    console.error('Uso: node resetear-password.js <email-o-username> <password-nuevo>');
    process.exit(1);
  }

  if (passwordNuevo.length < 6) {
    console.error('❌ El password debe tener al menos 6 caracteres');
    process.exit(1);
  }

  try {
    console.log('📦 Conectando a MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado a MongoDB\n');

    const usuario = await User.findOne({
      $or: [{ username: identificador }, { email: identificador }]
    });

    if (!usuario) {
      console.error(`❌ No se encontró un usuario con username o email: ${identificador}`);
      process.exit(1);
    }

    // Asignar el password en claro: el hook pre-save de User.js lo hashea
    // con bcrypt antes de persistirlo.
    usuario.password = passwordNuevo;
    await usuario.save();

    console.log('✅ Contraseña actualizada correctamente');
    console.log(`   Usuario:  ${usuario.username}`);
    console.log(`   Email:    ${usuario.email}`);
    console.log(`   Rol:      ${usuario.rol}`);
    console.log('\n⚠️  Recomendación: iniciar sesión y cambiarla desde el perfil.');
  } catch (error) {
    console.error('❌ Error al resetear la contraseña:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

resetearPassword(process.argv[2], process.argv[3]);
