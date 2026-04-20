const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');

// Helper para obtener el inicio del día en Argentina (UTC-3)
const getArgStartOfDay = (date = new Date()) => {
  const argDateStr = date.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const [y, m, d] = argDateStr.split('-').map(Number);
  // Argentina es UTC-3, por lo que 00:00 local es 03:00 UTC
  return new Date(Date.UTC(y, m - 1, d, 3, 0, 0, 0));
};

// Helper para obtener el rango de fechas según el período
const getDateRange = (period, dateStr, yearStr, monthStr) => {
  let start, end;
  const now = new Date();

  switch (period) {
    case 'daily':
      if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        start = new Date(Date.UTC(y, m - 1, d, 3, 0, 0, 0));
      } else {
        start = getArgStartOfDay(now);
      }
      end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
      break;
    case 'weekly':
      // Para semanal, retrocedemos al principio de la semana según Arg
      if (dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        start = new Date(Date.UTC(y, m - 1, d, 3, 0, 0, 0));
      } else {
        const argNow = getArgStartOfDay(now);
        // getDay() devuelve el día de la semana (0-6)
        // Pero tenemos que tener cuidado porque argNow es UTC (las 03:00)
        // La fecha UTC de argNow es el mismo día civil que en Arg
        const dayOfWeek = argNow.getUTCDay(); 
        start = new Date(argNow.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
      }
      end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);
      break;
    case 'monthly':
      const yStr = yearStr ? parseInt(yearStr) : parseInt(now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).split('-')[0]);
      const mStr = monthStr ? parseInt(monthStr) - 1 : parseInt(now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).split('-')[1]) - 1;
      start = new Date(Date.UTC(yStr, mStr, 1, 3, 0, 0, 0));
      end = new Date(Date.UTC(yStr, mStr + 1, 0, 23, 59, 59, 999) + 3 * 3600 * 1000);
      break;
    case 'annual':
      const yr = yearStr ? parseInt(yearStr) : parseInt(now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).split('-')[0]);
      start = new Date(Date.UTC(yr, 0, 1, 3, 0, 0, 0));
      end = new Date(Date.UTC(yr, 11, 31, 23, 59, 59, 999) + 3 * 3600 * 1000);
      break;
    default:
      start = new Date(0);
      end = new Date();
  }
  return { start, end };
};

const buildReportAggregation = async (startDate, endDate, groupByFormat) => {
  const matchStage = {
    $match: {
      fecha: { $gte: startDate, $lte: endDate },
      estado: 'completada'
    }
  };

  const mainStats = await Sale.aggregate([
    matchStage,
    {
      $unwind: '$items'
    },
    {
      $group: {
        _id: '$_id', // Agrupar por venta primero para sumar totales correctamente y no duplicar monto pagado
        totalFinal: { $first: '$totalFinal' },
        metodoPago: { $first: '$metodoPago' },
        fecha: { $first: '$fecha' },
        costoVenta: { $sum: { $multiply: ['$items.precioCompraHisto', '$items.cantidad'] } }
      }
    },
    {
      $group: {
        _id: groupByFormat ? { $dateToString: { format: groupByFormat, date: '$fecha' } } : null,
        totalVentas: { $sum: 1 },
        montoTotal: { $sum: '$totalFinal' },
        costoTotal: { $sum: '$costoVenta' }
      }
    },
    {
      $project: {
        totalVentas: 1,
        montoTotal: 1,
        costoTotal: 1,
        gananciaNeta: { $subtract: ['$montoTotal', '$costoTotal'] },
        ticketPromedio: { $divide: ['$montoTotal', { $cond: [{ $eq: ['$totalVentas', 0] }, 1, '$totalVentas'] }] }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  const paymentMethods = await Sale.aggregate([
    matchStage,
    {
      $group: {
       _id: '$metodoPago',
       total: { $sum: '$totalFinal' },
       count: { $sum: 1 }
      }
    }
  ]);

  return {
    timeline: mainStats,
    paymentMethods
  };
};

const getReport = async (req, res, period, groupByFormat) => {
  try {
    const { date, year, month } = req.query;
    const { start, end } = getDateRange(period, date, year, month);

    const stats = await buildReportAggregation(start, end, groupByFormat);

    // Sumario total (ya que timeline puede venir separado por dias/horas)
    let totalVentas = 0;
    let montoTotal = 0;
    let costoTotal = 0;

    stats.timeline.forEach(t => {
      totalVentas += t.totalVentas;
      montoTotal += t.montoTotal;
      costoTotal += t.costoTotal;
    });

    const gananciaNeta = montoTotal - costoTotal;
    const ticketPromedio = totalVentas > 0 ? montoTotal / totalVentas : 0;

    res.json({
      periodo: { start, end },
      totales: {
        totalVentas,
        montoTotal,
        costoTotal,
        gananciaNeta,
        ticketPromedio
      },
      ventasPorMetodoPago: stats.paymentMethods,
      timeline: stats.timeline // ventas por hora/día/mes dependiendo del groupByFormat
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al generar reporte' });
  }
};

// @desc    Reporte Diario
// @route   GET /api/reports/daily
const getDailyReport = (req, res) => getReport(req, res, 'daily', '%H'); // Agrupa por hora

// @desc    Reporte Semanal
// @route   GET /api/reports/weekly
const getWeeklyReport = (req, res) => getReport(req, res, 'weekly', '%Y-%m-%d'); // Agrupa por dia

// @desc    Reporte Mensual
// @route   GET /api/reports/monthly
const getMonthlyReport = (req, res) => getReport(req, res, 'monthly', '%Y-%m-%d'); // Agrupa por dia

// @desc    Reporte Anual
// @route   GET /api/reports/annual
const getAnnualReport = (req, res) => getReport(req, res, 'annual', '%Y-%m'); // Agrupa por mes

// @desc    Top Productos Vendidos
// @route   GET /api/reports/top-products
const getTopProductsReport = async (req, res) => {
  try {
    const { period, date, year, month } = req.query;
    const { start, end } = getDateRange(period || 'monthly', date, year, month);

    const topProducts = await Sale.aggregate([
      {
        $match: {
          fecha: { $gte: start, $lte: end },
          estado: 'completada'
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.producto',
          cantidadVendida: { $sum: '$items.cantidad' },
          ingresosGenerados: { $sum: '$items.subtotal' }
        }
      },
      { $sort: { cantidadVendida: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productoInfo'
        }
      },
      { $unwind: '$productoInfo' },
      {
        $project: {
          _id: 1,
          cantidadVendida: 1,
          ingresosGenerados: 1,
          nombre: '$productoInfo.nombre',
          sku: '$productoInfo.sku',
          imagen: '$productoInfo.imagen'
        }
      }
    ]);

    res.json(topProducts);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener top productos' });
  }
};

// @desc    Resumen general Dashboard
// @route   GET /api/reports/summary
const getDashboardSummary = async (req, res) => {
  try {
    const todayStart = getArgStartOfDay();
    
    const matchStage = {
      $match: {
        fecha: { $gte: todayStart },
        estado: 'completada'
      }
    };

    const dailyStats = await Sale.aggregate([
      matchStage,
      { $unwind: '$items' },
      {
        $group: {
          _id: '$_id',
          totalFinal: { $first: '$totalFinal' },
          costoVenta: { $sum: { $multiply: ['$items.precioCompraHisto', '$items.cantidad'] } }
        }
      },
      {
        $group: {
          _id: null,
          totalVentas: { $sum: 1 },
          montoTotal: { $sum: '$totalFinal' },
          costoTotal: { $sum: '$costoVenta' }
        }
      }
    ]);

    const stats = dailyStats[0] || { totalVentas: 0, montoTotal: 0, costoTotal: 0 };
    const gananciaHoy = stats.montoTotal - stats.costoTotal;

    // Obtener productos mas vendidos de hoy
    const topToday = await Sale.aggregate([
      matchStage,
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.producto',
          cantidad: { $sum: '$items.cantidad' }
        }
      },
      { $sort: { cantidad: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'producto'
        }
      },
      { $unwind: '$producto' },
      {
        $project: {
          nombre: '$producto.nombre',
          cantidad: 1
        }
      }
    ]);

    // Ventas por hora
    const ventasPorHora = await Sale.aggregate([
      matchStage,
      {
        $group: {
          _id: { $hour: { date: '$fecha', timezone: 'America/Argentina/Buenos_Aires'} },
          total: { $sum: '$totalFinal' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      ventasHoy: stats.totalVentas,
      facturacionHoy: stats.montoTotal,
      gananciaHoy,
      topProducts: topToday,
      ventasPorHora
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al generar resumen' });
  }
};

// @desc    Estadísticas Globales (Stock y Ventas Históricas)
// @route   GET /api/reports/global-stats
const getGlobalStats = async (req, res) => {
  try {
    // 1. Estadísticas de Productos
    const totalProducts = await Product.countDocuments({ activo: true });
    
    // Valor del Stock (Costo y Venta)
    const inventoryVal = await Product.aggregate([
      { $match: { activo: true } },
      {
        $group: {
          _id: null,
          totalCost: { $sum: { $multiply: ['$stock', '$precioCompra'] } },
          totalSalesValue: { $sum: { $multiply: ['$stock', '$precioVenta'] } }
        }
      }
    ]);

    // Breakdown por Categoría
    const categoryBreakdown = await Product.aggregate([
      { $match: { activo: true } },
      {
        $group: {
          _id: '$categoria',
          count: { $sum: 1 },
          stockTotal: { $sum: '$stock' },
          valorCoste: { $sum: { $multiply: ['$stock', '$precioCompra'] } }
        }
      },
      {
        $lookup: {
          from: 'categories',
          localField: '_id',
          foreignField: '_id',
          as: 'categoriaInfo'
        }
      },
      { $unwind: '$categoriaInfo' },
      {
        $project: {
          nombre: '$categoriaInfo.nombre',
          count: 1,
          stockTotal: 1,
          valorCoste: 1
        }
      },
      { $sort: { valorCoste: -1 } }
    ]);

    // 2. Estadísticas de Ventas Históricas (Solo completadas)
    const saleStats = await Sale.aggregate([
      { $match: { estado: 'completada' } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$_id',
          totalFinal: { $first: '$totalFinal' },
          totalCosto: { $sum: { $multiply: ['$items.precioCompraHisto', '$items.cantidad'] } }
        }
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          billing: { $sum: '$totalFinal' },
          cost: { $sum: '$totalCosto' }
        }
      }
    ]);

    const stats = saleStats[0] || { count: 0, billing: 0, cost: 0 };

    res.json({
      productos: {
        total: totalProducts,
        valorCoste: inventoryVal[0]?.totalCost || 0,
        valorVenta: inventoryVal[0]?.totalSalesValue || 0,
        breakdown: categoryBreakdown
      },
      ventas: {
        totalCount: stats.count,
        facturacionTotal: stats.billing,
        gananciaTotal: stats.billing - stats.cost
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estadísticas globales' });
  }
};

// @desc    Data para el heatmap de ventas (facturación y ganancia diaria)
// @route   GET /api/reports/sales-heatmap
const getSalesHeatmap = async (req, res) => {
  try {
    const months = req.query.months || 6;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);
    
    // Ajustar al inicio del día en Arg (UTC-3)
    const [y, m, d] = startDate.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).split('-').map(Number);
    const startDateArg = new Date(Date.UTC(y, m - 1, d, 3, 0, 0, 0));

    const heatmapData = await Sale.aggregate([
      {
        $match: {
          fecha: { $gte: startDateArg, $lte: endDate },
          estado: 'completada'
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$_id',
          totalFinal: { $first: '$totalFinal' },
          fecha: { $first: '$fecha' },
          costoVenta: { $sum: { $multiply: ['$items.precioCompraHisto', '$items.cantidad'] } }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$fecha", timezone: "America/Argentina/Buenos_Aires" } },
          total: { $sum: '$totalFinal' },
          costo: { $sum: '$costoVenta' }
        }
      },
      {
        $project: {
          _id: 0,
          date: '$_id',
          total: 1,
          profit: { $subtract: ['$total', '$costo'] }
        }
      },
      { $sort: { date: 1 } }
    ]);

    res.json(heatmapData);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener datos del heatmap' });
  }
};

module.exports = {
  getDailyReport,
  getWeeklyReport,
  getMonthlyReport,
  getAnnualReport,
  getTopProductsReport,
  getDashboardSummary,
  getGlobalStats,
  getSalesHeatmap
};
