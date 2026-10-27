#!/bin/bash
# Genera dist/pos-can.html: la app completa en un solo archivo (para compartirla o publicarla).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
body=$(sed -n '/<body>/,/<\/body>/p' index.html | sed '1d;$d' | grep -v '<script src=')
{
  echo '<meta charset="utf-8">'
  echo '<title>POS-CAN</title>'
  echo '<meta name="claude:viewport-fit-sides" content="cover">'
  echo '<meta name="description" content="Punto de venta para tiendas de barrio: inventario, fiados, caja y ganancias.">'
  echo '<style>'; cat styles.css; echo '</style>'
  echo "$body"
  echo '<script>window.POSCAN_SINGLE_FILE = true;</script>'
  echo '<script>'; cat app.js; echo '</script>'
} > dist/pos-can.html
echo "dist/pos-can.html ($(wc -c < dist/pos-can.html) bytes)"
