const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiKey = require('../models/ApiKey');
const JWT_SECRET = require('../config/jwtSecret');

// Middleware para verificar el token JWT O API Key
const verificarToken = async (req, res, next) => {
  try {
    // Obtener token del header
    const authHeader = req.headers['authorization'];
    const token = authHeader?.replace('Bearer ', '');
    
    // Si no hay token, intentar con API Key
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No se proporcionó token de autenticación o API Key'
      });
    }

    // Intentar verificar como JWT primero
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Buscar usuario en la base de datos
      const usuario = await User.findById(decoded.userId).select('-password');
      
      if (!usuario || !usuario.activo) {
        return res.status(401).json({
          success: false,
          error: 'Usuario no encontrado o inactivo'
        });
      }

      // Agregar usuario al request
      req.usuario = usuario;
      req.tipoAutenticacion = 'jwt';
      
      next();
      return;
    } catch (jwtError) {
      // No es un JWT válido, intentar como API Key
    }

    // Intentar como API Key
    const apiKey = await ApiKey.encontrarPorKey(token);
    
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Token o API Key inválidos'
      });
    }

    // Verificar si la API Key expiró
    if (apiKey.expiracion && apiKey.expiracion < new Date()) {
      apiKey.activa = false;
      await apiKey.save();
      return res.status(401).json({
        success: false,
        error: 'API Key expirada'
      });
    }

    // Buscar el usuario propietario de la API Key
    const usuario = await User.findById(apiKey.usuario).select('-password');
    
    if (!usuario || !usuario.activo) {
      return res.status(401).json({
        success: false,
        error: 'Usuario de la API Key no encontrado o inactivo'
      });
    }

    // Actualizar último uso
    apiKey.ultimoUso = new Date();
    apiKey.ipOrigen = req.ip;
    await apiKey.save();

    // Agregar usuario y API Key al request
    req.usuario = usuario;
    req.apiKey = apiKey;
    req.tipoAutenticacion = 'apikey';
    
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Token inválido'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expirado'
      });
    }
    
    console.error('Error verificando autenticación:', error);
    res.status(500).json({
      success: false,
      error: 'Error al verificar autenticación'
    });
  }
};

// Middleware para verificar rol de administrador
const verificarAdmin = (req, res, next) => {
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado. Se requiere rol de administrador'
    });
  }
  next();
};

// Middleware para verificar permisos de API Key.
// Una sesión JWT pasa siempre (el usuario opera con su rol); una API Key
// tiene que declarar el permiso. Deniega por defecto: antes, una key sin
// lista de permisos caía en un next() final y pasaba igual.
const verificarPermiso = (permisoRequerido) => {
  return (req, res, next) => {
    if (req.tipoAutenticacion === 'jwt') {
      return next();
    }

    const permisos = req.apiKey?.permisos || [];
    if (permisos.includes(permisoRequerido) || permisos.includes('admin')) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'API Key no tiene permisos suficientes',
      permisosRequeridos: [permisoRequerido],
      permisosActuales: permisos
    });
  };
};

// Middleware para operaciones que solo tienen sentido en una sesión de
// usuario: gestionar credenciales (API Keys, perfil, contraseña) y
// administrar empresas/certificados. Una API Key filtrada no debe poder
// crear más credenciales ni cambiar la configuración tributaria.
const requerirSesionUsuario = (req, res, next) => {
  if (req.tipoAutenticacion !== 'jwt') {
    return res.status(403).json({
      success: false,
      error: 'Esta operación requiere una sesión de usuario (no está permitida con API Key)'
    });
  }
  next();
};

// Middleware para operaciones destructivas (borrado masivo de datos):
// exige una sesión de usuario admin (JWT). Una API Key nunca alcanza,
// aunque su dueño sea admin: una key filtrada no debe poder borrar datos
// ni el rastro de auditoría.
const requerirSesionAdmin = (req, res, next) => {
  if (req.tipoAutenticacion !== 'jwt') {
    return res.status(403).json({
      success: false,
      error: 'Esta operación requiere una sesión de usuario (no está permitida con API Key)'
    });
  }
  if (req.usuario.rol !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Acceso denegado. Se requiere rol de administrador'
    });
  }
  next();
};

module.exports = {
  verificarToken,
  verificarAdmin,
  verificarPermiso,
  requerirSesionUsuario,
  requerirSesionAdmin
};
