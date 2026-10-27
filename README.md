# POS-CAN

Punto de venta gratis para tiendas de barrio. Funciona en celular, tablet o computador,
**sin internet** y sin servidor: los datos se guardan en el propio dispositivo.

## Funciones

- **Vender**: búsqueda rápida, lector de código de barras (escribe/escanea y Enter),
  cobro en efectivo con cálculo de cambio, transferencia o fiado.
- **Inventario**: costo, precio, margen, stock y alertas de productos por agotarse.
  Registro de compras con costo promedio ponderado.
- **Fiados**: cuaderno de clientes con saldo, cupo máximo, abonos, historial y
  recordatorio por WhatsApp.
- **Caja**: apertura con base, ingresos, gastos, anulación de ventas y cierre con
  cálculo de sobrante o faltante.
- **Ganancias**: ventas, costo, ganancia bruta y neta por día, semana, mes o año;
  gráfico de 14 días y productos más rentables.
- **Ajustes**: moneda y formato regional, copia de seguridad (JSON), exportar
  inventario a CSV y productos de ejemplo.

## Uso

Abre `index.html` en el navegador, o sírvelo localmente para poder instalarlo como app:

```bash
npx serve .        # o: python3 -m http.server 8080
```

En el celular, abre la dirección en Chrome y elige **"Agregar a pantalla de inicio"**.
Para publicarlo gratis en internet puedes usar GitHub Pages, Netlify o Cloudflare Pages.

> Importante: los datos viven en el navegador del dispositivo. Descarga una copia de
> seguridad desde **Ajustes** con frecuencia.
