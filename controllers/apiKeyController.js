const ApiKey = require('../models/ApiKey');
const crypto = require('crypto');

// Crear nueva API Key
exports.crearApiKey = async (req, res) => {
  try {
    const { nombre, descripcion, permisos, expiracion } = req.body;

    // Validar campos requeridos
    if (!nombre) {
      return res.status(400).json({
        success: false,
        error: 'El nombre es requerido'
      });
    }

    // Crear API Key
    const apiKey = new ApiKey({
      nombre,
      descripcion: descripcion || '',
      permisos: permisos || ['facturas:crear', 'facturas:leer', 'stats:leer'],
      expiracion: expiracion ? new Date(expiracion) : null,
      usuario: req.usuario._id,
      ipOrigen: req.ip
    });

    await apiKey.save();

    res.status(201).json({
      success: true,
      message: 'API Key creada exitosamente',
      data: {
        id: apiKey._id,
        key: apiKey._plainKey,  // ← Solo se muestra una vez (no queda en la BD)
        nombre: apiKey.nombre,
        descripcion: apiKey.descripcion,
        permisos: apiKey.permisos,
        expiracion: apiKey.expiracion,
        fechaCreacion: apiKey.fechaCreacion
      },
      advertencia: 'Guarda esta API Key en un lugar seguro. No podrás verla nuevamente después de cerrar esta respuesta.'
    });
  } catch (error) {
    console.error('Error creando API Key:', error);
    res.status(500).json({
      success: false,
      error: 'Error al crear API Key',
      message: error.message
    });
  }
};

// Listar API Keys del usuario
exports.listarApiKeys = async (req, res) => {
  try {
    const apiKeys = await ApiKey.find({ usuario: req.usuario._id })
      .select('-keyHash')
      .sort({ fechaCreacion: -1 });

    res.status(200).json({
      success: true,
      data: apiKeys.map(key => ({
        id: key._id,
        nombre: key.nombre,
        descripcion: key.descripcion,
        permisos: key.permisos,
        activa: key.activa,
        expiracion: key.expiracion,
        ultimoUso: key.ultimoUso,
        fechaCreacion: key.fechaCreacion,
        // keyParcial guardado; fallback para docs anteriores a la migración 002
        keyParcial: key.keyParcial || (key.key ? `${key.key.substring(0, 8)}...${key.key.substring(key.key.length - 8)}` : 'N/A')
      }))
    });
  } catch (error) {
    console.error('Error listando API Keys:', error);
    res.status(500).json({
      success: false,
      error: 'Error al listar API Keys',
      message: error.message
    });
  }
};

// Revocar API Key
exports.revocarApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const apiKey = await ApiKey.findOne({ 
      _id: id, 
      usuario: req.usuario._id 
    });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'API Key no encontrada'
      });
    }

    apiKey.activa = false;
    await apiKey.save();

    res.status(200).json({
      success: true,
      message: 'API Key revocada exitosamente'
    });
  } catch (error) {
    console.error('Error revocando API Key:', error);
    res.status(500).json({
      success: false,
      error: 'Error al revocar API Key',
      message: error.message
    });
  }
};

// Obtener detalles de una API Key
exports.obtenerApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const apiKey = await ApiKey.findOne({ 
      _id: id, 
      usuario: req.usuario._id 
    }).select('-keyHash -key');

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'API Key no encontrada'
      });
    }

    res.status(200).json({
      success: true,
      data: apiKey
    });
  } catch (error) {
    console.error('Error obteniendo API Key:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener API Key',
      message: error.message
    });
  }
};

// Renovar API Key (generar nueva key manteniendo la misma configuración)
exports.renovarApiKey = async (req, res) => {
  try {
    const { id } = req.params;

    const apiKey = await ApiKey.findOne({ 
      _id: id, 
      usuario: req.usuario._id 
    });

    if (!apiKey) {
      return res.status(404).json({
        success: false,
        error: 'API Key no encontrada'
      });
    }

    // Generar nueva key (el hook pre-save deriva hash + parcial
    // y descarta el texto plano)
    apiKey.key = crypto.randomBytes(32).toString('hex');

    await apiKey.save();

    res.status(200).json({
      success: true,
      message: 'API Key renovada exitosamente',
      data: {
        id: apiKey._id,
        key: apiKey._plainKey,  // ← Solo se muestra una vez (no queda en la BD)
        nombre: apiKey.nombre,
        fechaCreacion: apiKey.fechaCreacion
      },
      advertencia: 'Guarda esta API Key en un lugar seguro. La key anterior ha sido invalidada.'
    });
  } catch (error) {
    console.error('Error renovando API Key:', error);
    res.status(500).json({
      success: false,
      error: 'Error al renovar API Key',
      message: error.message
    });
  }
};
