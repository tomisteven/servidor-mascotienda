const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const generateTicketNumber = require('../utils/generateTicketNumber');

// @desc    Obtener todas las ventas
// @route   GET /api/sales
// @access  Private
const getSales = async (req, res) => {
  try {
    const { startDate, endDate, empleado, metodoPago } = req.query;
    let query = {};

    if (startDate || endDate) {
      query.fecha = {};
      if (startDate) {
        // Si viene solo fecha YYYY-MM-DD, ajustamos al inicio del día en Arg (03:00 UTC)
        const s = new Date(startDate);
        if (startDate.length <= 10) s.setUTCHours(3, 0, 0, 0); 
        query.fecha.$gte = s;
      }
      if (endDate) {
        // Si viene solo fecha, ajustamos al fin del día en Arg (02:59:59 del día siguiente UTC)
        const e = new Date(endDate);
        if (endDate.length <= 10) e.setUTCHours(26, 59, 59, 999); // 23+3 = 26
        query.fecha.$lte = e;
      }
    }

    if (empleado) query.empleado = empleado;
    if (metodoPago) query.metodoPago = metodoPago;

    const sales = await Sale.find(query)
      .populate('empleado', 'nombre')
      .populate('items.producto', 'nombre sku')
      .sort({ fecha: -1 });
      
    res.json(sales);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas' });
  }
};

// @desc    Obtener venta por ID
// @route   GET /api/sales/:id
// @access  Private
const getSaleById = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .populate('empleado', 'nombre')
      .populate('items.producto', 'nombre sku');

    if (sale) {
      res.json(sale);
    } else {
      res.status(404).json({ message: 'Venta no encontrada' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la venta' });
  }
};

// @desc    Crear venta nueva transaccionalmente
// @route   POST /api/sales
// @access  Private
const createSale = async (req, res) => {
  try {
    const { items, descuento, metodoPago, montoPagado } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ message: 'No hay productos en la venta' });
    }

    let subtotal = 0;
    const saleItems = [];
    const stockMovements = [];
    const productsToUpdate = [];

    // Validar stock y preparar items
    for (const item of items) {
      const product = await Product.findById(item.producto);
      
      if (!product) {
        throw new Error(`Producto no encontrado: ${item.producto}`);
      }
      
      let itemSubtotal = 0;
      let stockDeduction = 0;
      let precioVentaHisto = product.precioVenta;
      let kilosVendidosCalculados = item.kilosVendidos || 0;

      if (product.esGenerico) {
         if (item.precioUnitario === undefined || item.precioUnitario < 0) {
            throw new Error(`Debe proporcionar un precio para el producto genérico: ${product.nombre}`);
         }
         precioVentaHisto = item.precioUnitario;
         itemSubtotal = precioVentaHisto * item.cantidad;
         stockDeduction = item.cantidad;
      } else if (item.esVentaSuelta && product.esBolsaAlimento) {
         if (!product.kilosPorBolsa || product.kilosPorBolsa <= 0) {
            throw new Error(`El producto ${product.nombre} no tiene kilos configurados para venta suelta`);
         }
         if (item.subtotal !== undefined) {
             itemSubtotal = item.subtotal;
             precioVentaHisto = item.subtotal; // Subtotal es el unitario para esta linea en este caso
             
             if (item.kilosVendidos === undefined) {
                 // Si solo mandaron dinero (subtotal), calculamos kilos
                 const margenSuelto = product.margenSuelto || 42;
                 const pricePerKg = (product.precioVenta / product.kilosPorBolsa) * (1 + (margenSuelto/100));
                 kilosVendidosCalculados = itemSubtotal / pricePerKg;
             }
         } else {
             // Si solo mandaron cantidad (como kilos), este bloque no se usaría porque el front manda subtotal
             throw new Error(`Debe mandar el subtotal cobrado para venta suelta de: ${product.nombre}`);
         }
         // La venta suelta NO descuenta stock del producto de bolsa, según requerimiento del usuario.
         // El usuario maneja el stock de bolsas abiertas de forma externa o solo le interesa el stock de bolsas cerradas.
         stockDeduction = 0;
      } else {
         itemSubtotal = product.precioVenta * item.cantidad;
         stockDeduction = item.cantidad;
      }

      const availableStock = product.stock || 0;
      // Convert to fixed for comparison to avoid floating point issues (e.g. 0.3 - 0.1 > 0.2)
      if (availableStock < stockDeduction - 0.0001) {
        throw new Error(`Stock insuficiente para el producto: ${product.nombre}. Solicitado: ${stockDeduction.toFixed(2)}, Disponible: ${availableStock.toFixed(2)}`);
      }

      subtotal += itemSubtotal;

      // Calcular costo proporcional para ventas sueltas
      let precioCompraHisto = product.precioCompra;
      if (item.esVentaSuelta && product.esBolsaAlimento && product.kilosPorBolsa > 0) {
         precioCompraHisto = (product.precioCompra / product.kilosPorBolsa) * kilosVendidosCalculados;
      }

      saleItems.push({
        producto: product._id,
        cantidad: item.cantidad,
        precioVentaHisto: precioVentaHisto,
        precioCompraHisto: precioCompraHisto,
        subtotal: itemSubtotal,
        esVentaSuelta: item.esVentaSuelta || false,
        kilosVendidos: kilosVendidosCalculados
      });

      // Preparar mov. stock solo si hay algo que descontar
      if (stockDeduction > 0) {
        stockMovements.push({
          producto: product._id,
          tipo: 'venta',
          cantidad: stockDeduction,
          stockAnterior: product.stock,
          stockNuevo: product.stock - stockDeduction,
          motivo: 'Venta completada',
          usuario: req.user._id
        });

        // Preparar actualización producto
        productsToUpdate.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $inc: { stock: -stockDeduction } }
          }
        });
      }
    }

    const discountAmount = descuento ? (subtotal * (descuento / 100)) : 0;
    const totalFinal = subtotal - discountAmount;
    const vuelto = montoPagado - totalFinal;

    if (vuelto < -0.01) {
        throw new Error('El monto pagado es menor al total de la venta');
    }

    const numeroTicket = await generateTicketNumber();

    const sale = new Sale({
      numeroTicket,
      empleado: req.user._id,
      items: saleItems,
      subtotal,
      descuento: descuento || 0,
      totalFinal,
      metodoPago,
      montoPagado,
      vuelto: vuelto < 0 ? 0 : vuelto,
      estado: 'completada'
    });

    const createdSale = await sale.save();

    // Modificar los motivos de stock para incluir el nro de ticket
    stockMovements.forEach(sm => sm.motivo = `Venta ${createdSale.numeroTicket}`);

    await StockMovement.insertMany(stockMovements);
    await Product.bulkWrite(productsToUpdate);

    res.status(201).json(createdSale);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// @desc    Anular venta (reponer stock)
// @route   PATCH /api/sales/:id/anular
// @access  Private/Admin
const cancelSale = async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);

    if (!sale) {
      throw new Error('Venta no encontrada');
    }

    if (sale.estado === 'anulada') {
      throw new Error('La venta ya está anulada');
    }

    const stockMovements = [];
    const productsToUpdate = [];

    // Revertir inventario
    for (const item of sale.items) {
      const product = await Product.findById(item.producto);
      
      if (product) {
        let stockRestored = item.cantidad;
        if (item.esVentaSuelta && product.esBolsaAlimento && product.kilosPorBolsa) {
             stockRestored = (item.kilosVendidos || 0) / product.kilosPorBolsa;
        }

        stockMovements.push({
          producto: product._id,
          tipo: 'ajuste', // O 'entrada' pero ajuste por anulación es mejor
          cantidad: stockRestored,
          stockAnterior: product.stock,
          stockNuevo: product.stock + stockRestored,
          motivo: `Anulación de ticket ${sale.numeroTicket}`,
          usuario: req.user._id
        });

        productsToUpdate.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $inc: { stock: stockRestored } }
          }
        });
      }
    }

    sale.estado = 'anulada';
    await sale.save();

    if (stockMovements.length > 0) {
      await StockMovement.insertMany(stockMovements);
      await Product.bulkWrite(productsToUpdate);
    }

    res.json({ message: 'Venta anulada exitosamente', sale });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

module.exports = {
  getSales,
  getSaleById,
  createSale,
  cancelSale
};
