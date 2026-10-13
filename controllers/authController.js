const jwt = require('jsonwebtoken');
const User = require('../models/User');
const JWT_SECRET = require('../config/jwtSecret');

// Generar token JWT
const generarToken = (userId) => {
  return jwt.sign(
    { userId },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
};

// Registro de usuario
exports.registrar = async (req, res) => {
  try {
    const { username, email, password, nombre, apellido, rol } = req.body;

    // Validar campos requeridos
    if (!username || !email || !password || !nombre || !apellido) {
      return res.status(400).json({
        success: false,
        error: 'Todos los campos son requeridos'
      });
    }

    // Verificar si el usuario ya existe
    const usuarioExistente = await User.findOne({ 
      $or: [{ email }, { username }] 
    });

    if (usuarioExistente) {
      return res.status(400).json({
        success: false,
        error: 'Ya existe un usuario con ese email o nombre de usuario'
      });
    }

    // Crear usuario
    const usuario = new User({
      username,
      email,
      password,
      nombre,
      apellido,
      rol: rol || 'usuario'
    });

    await usuario.save();

    // Generar token
    const token = generarToken(usuario._id);

    res.status(201).json({
      success: true,
      message: 'Usuario registrado exitosamente',
      data: {
        usuario: {
          id: usuario._id,
          username: usuario.username,
          email: usuario.email,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          rol: usuario.rol
        },
        token
      }
    });
  } catch (error) {
    console.error('Error registrando usuario:', error);
    res.status(500).json({
      success: false,
      error: 'Error al registrar usuario',
      message: error.message
    });
  }
};

// Login de usuario
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validar campos requeridos
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username y password son requeridos'
      });
    }

    // Buscar usuario
    const usuario = await User.findOne({ 
      $or: [{ username }, { email: username }] 
    });

    if (!usuario || !usuario.activo) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas'
      });
    }

    // Verificar password
    const passwordValido = await usuario.compararPassword(password);

    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        error: 'Credenciales inválidas'
      });
    }

    // Actualizar último acceso
    usuario.ultimoAcceso = new Date();
    await usuario.save();

    // Generar token
    const token = generarToken(usuario._id);

    res.status(200).json({
      success: true,
      message: 'Login exitoso',
      data: {
        usuario: {
          id: usuario._id,
          username: usuario.username,
          email: usuario.email,
          nombre: usuario.nombre,
          apellido: usuario.apellido,
          rol: usuario.rol
        },
        token
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar sesión',
      message: error.message
    });
  }
};

// Obtener perfil del usuario actual
exports.getPerfil = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        usuario: {
          id: req.usuario._id,
          username: req.usuario.username,
          email: req.usuario.email,
          nombre: req.usuario.nombre,
          apellido: req.usuario.apellido,
          rol: req.usuario.rol,
          activo: req.usuario.activo,
          ultimoAcceso: req.usuario.ultimoAcceso,
          fechaCreacion: req.usuario.fechaCreacion
        }
      }
    });
  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener perfil',
      message: error.message
    });
  }
};

// Actualizar perfil
exports.actualizarPerfil = async (req, res) => {
  try {
    const { nombre, apellido, email } = req.body;

    const usuario = await User.findById(req.usuario._id);

    if (nombre) usuario.nombre = nombre;
    if (apellido) usuario.apellido = apellido;
    if (email) usuario.email = email;

    await usuario.save();

    res.status(200).json({
      success: true,
      message: 'Perfil actualizado exitosamente',
      data: {
        usuario: {
          id: usuario._id,
          username: usuario.username,
          email: usuario.email,
          nombre: usuario.nombre,
          apellido: usuario.apellido
        }
      }
    });
  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({
      success: false,
      error: 'Error al actualizar perfil',
      message: error.message
    });
  }
};

// Cambiar password
exports.cambiarPassword = async (req, res) => {
  try {
    const { passwordActual, passwordNuevo } = req.body;

    if (!passwordActual || !passwordNuevo) {
      return res.status(400).json({
        success: false,
        error: 'Password actual y nuevo son requeridos'
      });
    }

    const usuario = await User.findById(req.usuario._id);

    const passwordValido = await usuario.compararPassword(passwordActual);

    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        error: 'Password actual inválido'
      });
    }

    usuario.password = passwordNuevo;
    await usuario.save();

    res.status(200).json({
      success: true,
      message: 'Password actualizado exitosamente'
    });
  } catch (error) {
    console.error('Error cambiando password:', error);
    res.status(500).json({
      success: false,
      error: 'Error al cambiar password',
      message: error.message
    });
  }
};

// Logout (opcional, el cliente puede eliminar el token)
exports.logout = async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logout exitoso'
  });
};
