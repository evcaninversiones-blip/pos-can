/* POS-CAN — punto de venta para tiendas de barrio.
 * Todo se guarda en el navegador (localStorage); usa Ajustes > Copia de seguridad
 * para exportar o restaurar los datos. */
'use strict';

const STORAGE_KEY = 'poscan:db:v1';

// ---------- Datos ----------

const emptyDb = () => ({
  settings: { storeName: 'Mi Tienda', currency: 'COP', locale: 'es-CO', ownerName: '' },
  products: [],
  customers: [],
  sales: [],
  payments: [],     // abonos de fiados
  movements: [],    // ingresos y gastos de caja
  cashSessions: [], // aperturas y cierres de caja
});

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyDb(), ...JSON.parse(raw) };
  } catch (e) { console.error(e); }
  // Primera vez: arranca con productos y un cliente de ejemplo para probar.
  const fresh = emptyDb();
  seedDemo(fresh);
  fresh.customers.push({ id: uid(), name: 'Doña Rosa (ejemplo)', phone: '3001234567', limit: 50000 });
  fresh.settings.demo = true;
  return fresh;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('No se pudo guardar. Exporta una copia de seguridad.');
  }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
const now = () => new Date().toISOString();
const byId = (list, id) => list.find((x) => x.id === id);

// ---------- Formato ----------

function money(n) {
  try {
    return new Intl.NumberFormat(db.settings.locale, {
      style: 'currency', currency: db.settings.currency, maximumFractionDigits: 0,
    }).format(n || 0);
  } catch {
    return '$' + Math.round(n || 0).toLocaleString();
  }
}

const num = (v) => {
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const fmtDate = (iso) => new Date(iso).toLocaleString(db.settings.locale, {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});

const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ---------- Cálculos ----------

const openSession = () => db.cashSessions.find((s) => !s.closedAt);

function customerBalance(customerId) {
  const owed = db.sales
    .filter((s) => s.method === 'fiado' && s.customerId === customerId)
    .reduce((a, s) => a + s.total, 0);
  const paid = db.payments
    .filter((p) => p.customerId === customerId)
    .reduce((a, p) => a + p.amount, 0);
  return owed - paid;
}

function sessionSummary(session) {
  const inSession = (x) => x.cashSessionId === session.id;
  const sales = db.sales.filter(inSession);
  const cashSales = sales.filter((s) => s.method === 'efectivo').reduce((a, s) => a + s.total, 0);
  const transferSales = sales.filter((s) => s.method === 'transferencia').reduce((a, s) => a + s.total, 0);
  const fiadoSales = sales.filter((s) => s.method === 'fiado').reduce((a, s) => a + s.total, 0);
  const abonos = db.payments.filter((p) => inSession(p) && p.method === 'efectivo').reduce((a, p) => a + p.amount, 0);
  const moves = db.movements.filter(inSession);
  const ingresos = moves.filter((m) => m.type === 'ingreso').reduce((a, m) => a + m.amount, 0);
  const gastos = moves.filter((m) => m.type === 'gasto').reduce((a, m) => a + m.amount, 0);
  const expected = session.openingAmount + cashSales + abonos + ingresos - gastos;
  return { sales, cashSales, transferSales, fiadoSales, abonos, ingresos, gastos, expected, moves };
}

function periodStats(from, to) {
  const inRange = (x) => x.date >= from && x.date < to;
  const sales = db.sales.filter(inRange);
  const revenue = sales.reduce((a, s) => a + s.total, 0);
  const cost = sales.reduce((a, s) => a + s.cost, 0);
  const expenses = db.movements
    .filter((m) => inRange(m) && m.type === 'gasto' && !m.isPurchase)
    .reduce((a, m) => a + m.amount, 0);
  return { sales, revenue, cost, gross: revenue - cost, expenses, net: revenue - cost - expenses };
}

// ---------- Navegación ----------

let currentTab = 'venta';
let cart = [];
let productFilter = '';
let inventoryFilter = '';
let reportRange = 'hoy';

const views = {};

function render() {
  document.getElementById('store-name').textContent = db.settings.storeName;
  const pill = document.getElementById('cash-status');
  const session = openSession();
  pill.textContent = session ? 'Caja abierta' : 'Caja cerrada';
  pill.className = 'pill ' + (session ? 'open' : 'closed');
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
  document.getElementById('view').innerHTML = views[currentTab]();
  afterRender[currentTab]?.();
}

const afterRender = {};

document.querySelector('.tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  currentTab = btn.dataset.tab;
  render();
  window.scrollTo(0, 0);
});

// Acciones con data-action en cualquier vista.
const actions = {};
document.getElementById('view').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  actions[el.dataset.action]?.(el.dataset, el);
});

// ---------- Modal genérico ----------

function openModal(html, onSubmit, { okText = 'Guardar', danger = false } = {}) {
  const dialog = document.getElementById('modal');
  const form = document.getElementById('modal-form');
  form.innerHTML = html + `
    <div class="modal-actions">
      <button type="button" class="btn secondary" value="cancel" data-close>Cancelar</button>
      <button type="submit" class="btn ${danger ? 'danger' : ''}" value="ok">${esc(okText)}</button>
    </div>`;
  form.querySelector('[data-close]').onclick = () => dialog.close();
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (onSubmit(data, form) !== false) dialog.close();
  };
  if (!dialog.open) dialog.showModal();
  form.querySelector('input, select')?.focus();
}

// Confirmación dentro de la app (el visor de claude.ai bloquea confirm/prompt).
function askConfirm(message, onYes, { okText = 'Sí, continuar', danger = false, typed = '' } = {}) {
  openModal(`
    <h2>¿Estás seguro?</h2>
    <p>${esc(message)}</p>
    ${typed ? `<label for="confirm-typed">Escribe ${typed} para confirmar</label><input id="confirm-typed" name="typed" autocomplete="off">` : ''}`,
    (data) => {
      if (typed && data.typed !== typed) { toast(`Escribe ${typed} exactamente`); return false; }
      onYes();
    }, { okText, danger });
}

// ---------- VENDER ----------

views.venta = () => {
  const q = productFilter.toLowerCase();
  const products = db.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.category || '').toLowerCase().includes(q))
    .slice(0, 60);
  const total = cart.reduce((a, l) => a + l.qty * l.price, 0);
  const session = openSession();

  return `
  ${db.settings.demo ? `<div class="card notice">
    <div class="spread"><span><strong>Estás viendo datos de ejemplo.</strong> Pruébalo todo con tranquilidad; cuando quieras usarlo de verdad, empieza de cero.</span>
    <span class="row"><button class="btn small secondary" data-action="keep-demo">Ocultar aviso</button>
    <button class="btn small" data-action="clear-demo">Empezar de cero</button></span></div></div>` : ''}
  ${session ? '' : `<div class="card" style="border-left:4px solid var(--danger)">
    <div class="spread"><span>La caja está cerrada. Ábrela para registrar ventas.</span>
    <button class="btn small" data-action="go-caja">Abrir caja</button></div></div>`}
  <div class="grid grid-2">
    <section class="card">
      <h2>Productos</h2>
      <div class="row">
        <input class="grow" id="product-search" placeholder="Buscar o escanear código de barras…" value="${esc(productFilter)}" autocomplete="off">
        <button class="btn secondary" data-action="quick-item">+ Varios</button>
      </div>
      ${db.products.length === 0
        ? `<div class="empty">Aún no tienes productos.<br><br><button class="btn" data-action="new-product">Agregar primer producto</button></div>`
        : `<div class="product-grid">${products.map((p) => `
          <button class="product-tile ${p.stock <= p.minStock ? 'low' : ''}" data-action="add-to-cart" data-id="${p.id}">
            <div>${esc(p.name)}</div>
            <div class="price">${money(p.price)}</div>
            <div class="stock">Stock: ${p.stock}</div>
          </button>`).join('')}</div>`}
    </section>

    <section class="card">
      <div class="spread"><h2>Venta actual</h2>
        ${cart.length ? '<button class="btn small secondary" data-action="clear-cart">Vaciar</button>' : ''}</div>
      ${cart.length === 0 ? '<div class="empty">Toca un producto para agregarlo</div>' : cart.map((l, i) => `
        <div class="cart-line">
          <div><div>${esc(l.name)}</div><div class="muted">${money(l.price)} c/u</div></div>
          <div class="qty">
            <button data-action="qty" data-i="${i}" data-d="-1">−</button>
            <input type="number" min="0" step="any" value="${l.qty}" data-qty="${i}" inputmode="decimal">
            <button data-action="qty" data-i="${i}" data-d="1">+</button>
          </div>
          <strong class="num">${money(l.qty * l.price)}</strong>
        </div>`).join('')}
      <div class="total">${money(total)}</div>
      <div class="grid" style="grid-template-columns:1fr 1fr 1fr">
        <button class="btn" data-action="checkout" data-method="efectivo" ${cart.length && session ? '' : 'disabled'}>💵 Efectivo</button>
        <button class="btn secondary" data-action="checkout" data-method="transferencia" ${cart.length && session ? '' : 'disabled'}>📱 Transfer.</button>
        <button class="btn accent" data-action="checkout" data-method="fiado" ${cart.length && session ? '' : 'disabled'}>📒 Fiado</button>
      </div>
    </section>
  </div>`;
};

afterRender.venta = () => {
  const input = document.getElementById('product-search');
  input.addEventListener('input', () => {
    productFilter = input.value;
    const pos = input.selectionStart;
    render();
    const again = document.getElementById('product-search');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  // Lector de código de barras: escribe el código y presiona Enter.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const code = input.value.trim();
    const p = db.products.find((x) => x.barcode && x.barcode === code)
      || (db.products.filter((x) => x.name.toLowerCase().includes(code.toLowerCase())).length === 1
        && db.products.find((x) => x.name.toLowerCase().includes(code.toLowerCase())));
    if (p) { addToCart(p); productFilter = ''; render(); document.getElementById('product-search').focus(); }
  });
  document.querySelectorAll('[data-qty]').forEach((el) => el.addEventListener('change', () => {
    const line = cart[+el.dataset.qty];
    line.qty = Math.max(0, num(el.value));
    if (line.qty === 0) cart.splice(+el.dataset.qty, 1);
    render();
  }));
};

function addToCart(p) {
  const line = cart.find((l) => l.productId === p.id);
  if (line) line.qty += 1;
  else cart.push({ productId: p.id, name: p.name, price: p.price, cost: p.cost, qty: 1 });
}

actions['go-caja'] = () => { currentTab = 'caja'; render(); };
actions['add-to-cart'] = ({ id }) => { addToCart(byId(db.products, id)); render(); };
actions['clear-cart'] = () => { cart = []; render(); };
actions.qty = ({ i, d }) => {
  const line = cart[+i];
  line.qty = Math.max(0, line.qty + +d);
  if (line.qty === 0) cart.splice(+i, 1);
  render();
};

actions['quick-item'] = () => openModal(`
  <h2>Producto sin registrar</h2>
  <label>Descripción</label><input name="name" value="Varios" required>
  <label>Precio</label><input name="price" type="number" min="0" step="any" inputmode="decimal" required>`,
  ({ name, price }) => {
    cart.push({ productId: null, name, price: num(price), cost: 0, qty: 1 });
    render();
  });

actions.checkout = ({ method }) => {
  const total = cart.reduce((a, l) => a + l.qty * l.price, 0);
  if (method === 'efectivo') {
    openModal(`
      <h2>Cobrar ${money(total)}</h2>
      <label>Recibido</label><input name="received" type="number" min="0" step="any" inputmode="decimal" value="${total}">
      <p id="change" class="total">Cambio: ${money(0)}</p>`,
      ({ received }) => {
        const r = num(received);
        if (r < total) { toast('El dinero recibido no alcanza'); return false; }
        finishSale(method, null, r);
      });
    const input = document.querySelector('#modal-form [name=received]');
    const upd = () => { document.getElementById('change').textContent = 'Cambio: ' + money(Math.max(0, num(input.value) - total)); };
    input.addEventListener('input', upd);
    input.select();
  } else if (method === 'fiado') {
    if (!db.customers.length) { toast('Primero crea un cliente en Fiados'); currentTab = 'fiados'; render(); return; }
    openModal(`
      <h2>Fiar ${money(total)}</h2>
      <label>Cliente</label>
      <select name="customerId" required>${db.customers.map((c) => {
        const bal = customerBalance(c.id);
        return `<option value="${c.id}">${esc(c.name)} — debe ${money(bal)}</option>`;
      }).join('')}</select>`,
      ({ customerId }) => {
        const c = byId(db.customers, customerId);
        const bal = customerBalance(customerId);
        if (c.limit && bal + total > c.limit) {
          askConfirm(`${c.name} debe ${money(bal)} y superaría su cupo de ${money(c.limit)}. ¿Fiar de todas formas?`,
            () => finishSale(method, customerId), { okText: 'Fiar' });
          return false;
        }
        finishSale(method, customerId);
      });
  } else {
    askConfirm(`Confirma que recibiste la transferencia de ${money(total)}.`, () => finishSale(method), { okText: 'Recibida' });
  }
};

function finishSale(method, customerId = null, received = null) {
  const session = openSession();
  const items = cart.map((l) => ({ ...l }));
  const total = items.reduce((a, l) => a + l.qty * l.price, 0);
  const cost = items.reduce((a, l) => a + l.qty * l.cost, 0);
  for (const l of items) {
    const p = l.productId && byId(db.products, l.productId);
    if (p) p.stock = +(p.stock - l.qty).toFixed(3);
  }
  db.sales.push({
    id: uid(), date: now(), items, total, cost, method, customerId,
    received, change: received != null ? received - total : null, cashSessionId: session.id,
  });
  save();
  cart = [];
  toast(`Venta registrada: ${money(total)}` + (received != null && received > total ? ` · Cambio ${money(received - total)}` : ''));
  render();
}

// ---------- INVENTARIO ----------

views.inventario = () => {
  const q = inventoryFilter.toLowerCase();
  const list = db.products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.barcode || '').includes(q) || (p.category || '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const low = db.products.filter((p) => p.stock <= p.minStock);
  const value = db.products.reduce((a, p) => a + Math.max(0, p.stock) * p.cost, 0);
  const valueSale = db.products.reduce((a, p) => a + Math.max(0, p.stock) * p.price, 0);

  return `
  <div class="stats">
    <div class="stat"><div class="label">Productos</div><div class="value">${db.products.length}</div></div>
    <div class="stat ${low.length ? 'bad' : ''}"><div class="label">Por agotarse</div><div class="value">${low.length}</div></div>
    <div class="stat"><div class="label">Inventario a costo</div><div class="value">${money(value)}</div></div>
    <div class="stat good"><div class="label">Inventario a precio venta</div><div class="value">${money(valueSale)}</div></div>
  </div>
  <section class="card" style="margin-top:12px">
    <div class="row">
      <input class="grow" id="inv-search" placeholder="Buscar producto…" value="${esc(inventoryFilter)}">
      <button class="btn" data-action="new-product">+ Producto</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Producto</th><th class="num">Costo</th><th class="num">Precio</th><th class="num">Margen</th><th class="num">Stock</th><th></th></tr></thead>
      <tbody>${list.length ? list.map((p) => {
        const margin = p.price ? Math.round(((p.price - p.cost) / p.price) * 100) : 0;
        return `<tr>
          <td>${esc(p.name)}<div class="muted">${esc(p.category || '')}${p.barcode ? ' · ' + esc(p.barcode) : ''}</div></td>
          <td class="num">${money(p.cost)}</td>
          <td class="num">${money(p.price)}</td>
          <td class="num">${margin}%</td>
          <td class="num">${p.stock <= p.minStock ? `<span class="badge red">${p.stock}</span>` : p.stock}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn small accent" data-action="restock" data-id="${p.id}" title="Registrar compra">+ Stock</button>
            <button class="btn small secondary" data-action="edit-product" data-id="${p.id}">Editar</button>
          </td></tr>`;
      }).join('') : '<tr><td colspan="6" class="empty">Sin productos</td></tr>'}</tbody>
    </table></div>
  </section>`;
};

afterRender.inventario = () => {
  const input = document.getElementById('inv-search');
  input.addEventListener('input', () => {
    inventoryFilter = input.value;
    const pos = input.selectionStart;
    render();
    const again = document.getElementById('inv-search');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
};

function productForm(p = {}) {
  return `
    <h2>${p.id ? 'Editar producto' : 'Nuevo producto'}</h2>
    <label>Nombre</label><input name="name" value="${esc(p.name || '')}" required>
    <div class="row">
      <div class="grow"><label>Código de barras</label><input name="barcode" value="${esc(p.barcode || '')}"></div>
      <div class="grow"><label>Categoría</label><input name="category" value="${esc(p.category || '')}" list="categories"></div>
    </div>
    <datalist id="categories">${[...new Set(db.products.map((x) => x.category).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="row">
      <div class="grow"><label>Costo (compra)</label><input name="cost" type="number" min="0" step="any" inputmode="decimal" value="${p.cost ?? ''}" required></div>
      <div class="grow"><label>Precio de venta</label><input name="price" type="number" min="0" step="any" inputmode="decimal" value="${p.price ?? ''}" required></div>
    </div>
    <div class="row">
      <div class="grow"><label>Stock actual</label><input name="stock" type="number" step="any" inputmode="decimal" value="${p.stock ?? 0}"></div>
      <div class="grow"><label>Avisar cuando queden</label><input name="minStock" type="number" min="0" step="any" inputmode="decimal" value="${p.minStock ?? 5}"></div>
    </div>
    ${p.id ? `<p><button type="button" class="btn small danger" id="delete-product">Eliminar producto</button></p>` : ''}`;
}

function readProduct(data) {
  return {
    name: data.name.trim(), barcode: data.barcode.trim(), category: data.category.trim(),
    cost: num(data.cost), price: num(data.price), stock: num(data.stock), minStock: num(data.minStock),
  };
}

actions['new-product'] = () => openModal(productForm(), (data) => {
  const fields = readProduct(data);
  if (fields.barcode && db.products.some((x) => x.barcode === fields.barcode)) { toast('Ese código de barras ya existe'); return false; }
  db.products.push({ id: uid(), ...fields });
  save(); render(); toast('Producto agregado');
});

actions['edit-product'] = ({ id }) => {
  const p = byId(db.products, id);
  openModal(productForm(p), (data) => {
    Object.assign(p, readProduct(data));
    save(); render(); toast('Producto actualizado');
  });
  document.getElementById('delete-product').onclick = () => {
    askConfirm(`Se eliminará "${p.name}". Las ventas anteriores se conservan.`, () => {
      db.products = db.products.filter((x) => x.id !== id);
      save(); render(); toast('Producto eliminado');
    }, { okText: 'Eliminar', danger: true });
  };
};

actions.restock = ({ id }) => {
  const p = byId(db.products, id);
  const session = openSession();
  openModal(`
    <h2>Compra: ${esc(p.name)}</h2>
    <label>Cantidad recibida</label><input name="qty" type="number" min="0" step="any" inputmode="decimal" required>
    <label>Costo unitario</label><input name="cost" type="number" min="0" step="any" inputmode="decimal" value="${p.cost}">
    <label>Proveedor (opcional)</label><input name="supplier">
    ${session ? `<label><input type="checkbox" name="fromCash" style="width:auto"> Pagar con dinero de la caja</label>` : ''}`,
    ({ qty, cost, supplier, fromCash }) => {
      const q = num(qty);
      const c = num(cost);
      // Costo promedio ponderado para que las ganancias sean realistas.
      const oldStock = Math.max(0, p.stock);
      p.cost = oldStock + q > 0 ? Math.round(((oldStock * p.cost) + (q * c)) / (oldStock + q)) : c;
      p.stock = +(p.stock + q).toFixed(3);
      if (fromCash && session) {
        db.movements.push({
          id: uid(), date: now(), type: 'gasto', amount: q * c, isPurchase: true,
          concept: `Compra ${p.name} x${q}${supplier ? ' — ' + supplier : ''}`, cashSessionId: session.id,
        });
      }
      save(); render(); toast(`Stock de ${p.name}: ${p.stock}`);
    });
};

// ---------- FIADOS ----------

views.fiados = () => {
  const list = db.customers
    .map((c) => ({ ...c, balance: customerBalance(c.id) }))
    .sort((a, b) => b.balance - a.balance);
  const totalOwed = list.reduce((a, c) => a + Math.max(0, c.balance), 0);
  const debtors = list.filter((c) => c.balance > 0).length;

  return `
  <div class="stats">
    <div class="stat bad"><div class="label">Total por cobrar</div><div class="value">${money(totalOwed)}</div></div>
    <div class="stat"><div class="label">Clientes que deben</div><div class="value">${debtors}</div></div>
    <div class="stat"><div class="label">Clientes</div><div class="value">${db.customers.length}</div></div>
  </div>
  <section class="card" style="margin-top:12px">
    <div class="spread"><h2>Cuaderno de fiados</h2><button class="btn" data-action="new-customer">+ Cliente</button></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Cliente</th><th class="num">Debe</th><th class="num">Cupo</th><th></th></tr></thead>
      <tbody>${list.length ? list.map((c) => `
        <tr>
          <td><a href="#" data-action="customer-detail" data-id="${c.id}">${esc(c.name)}</a><div class="muted">${esc(c.phone || '')}</div></td>
          <td class="num">${c.balance > 0 ? `<span class="badge ${c.limit && c.balance >= c.limit ? 'red' : 'amber'}">${money(c.balance)}</span>` : '<span class="badge green">Al día</span>'}</td>
          <td class="num">${c.limit ? money(c.limit) : '—'}</td>
          <td class="num" style="white-space:nowrap">
            <button class="btn small" data-action="payment" data-id="${c.id}" ${c.balance > 0 ? '' : 'disabled'}>Abonar</button>
            ${c.phone && c.balance > 0 ? `<a class="btn small secondary" href="${whatsappLink(c)}" target="_blank" rel="noopener" title="Recordar por WhatsApp">💬</a>` : ''}
          </td>
        </tr>`).join('') : '<tr><td colspan="4" class="empty">Sin clientes. Agrega uno para poder fiar.</td></tr>'}</tbody>
    </table></div>
  </section>`;
};

function customerForm(c = {}) {
  return `
    <h2>${c.id ? 'Editar cliente' : 'Nuevo cliente'}</h2>
    <label>Nombre</label><input name="name" value="${esc(c.name || '')}" required>
    <label>Celular</label><input name="phone" type="tel" value="${esc(c.phone || '')}">
    <label>Cupo máximo de fiado (0 = sin límite)</label><input name="limit" type="number" min="0" step="any" inputmode="decimal" value="${c.limit ?? 0}">`;
}

actions['new-customer'] = () => openModal(customerForm(), ({ name, phone, limit }) => {
  db.customers.push({ id: uid(), name: name.trim(), phone: phone.trim(), limit: num(limit) });
  save(); render(); toast('Cliente agregado');
});

actions.payment = ({ id }) => {
  const c = byId(db.customers, id);
  const bal = customerBalance(id);
  const session = openSession();
  openModal(`
    <h2>Abono de ${esc(c.name)}</h2>
    <p class="muted">Debe ${money(bal)}</p>
    <label>Valor del abono</label><input name="amount" type="number" min="1" max="${bal}" step="any" inputmode="decimal" value="${bal}" required>
    <label>Medio de pago</label>
    <select name="method"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select>
    <label>Nota (opcional)</label><input name="note">`,
    ({ amount, method, note }) => {
      const a = num(amount);
      if (a <= 0) return false;
      if (method === 'efectivo' && !session) { toast('Abre la caja para recibir efectivo'); return false; }
      db.payments.push({ id: uid(), date: now(), customerId: id, amount: a, method, note, cashSessionId: session?.id ?? null });
      save(); render(); toast(`Abono registrado. Nuevo saldo: ${money(bal - a)}`);
    });
};

function whatsappLink(c) {
  const phone = c.phone.replace(/\D/g, '');
  const msg = `Hola ${c.name}, te saluda ${db.settings.storeName}. Te recordamos que tienes un saldo pendiente de ${money(customerBalance(c.id))}. ¡Gracias!`;
  return esc(`https://wa.me/${phone.length === 10 ? '57' + phone : phone}?text=${encodeURIComponent(msg)}`);
}

actions['customer-detail'] = ({ id }) => {
  const c = byId(db.customers, id);
  const entries = [
    ...db.sales.filter((s) => s.method === 'fiado' && s.customerId === id)
      .map((s) => ({ date: s.date, text: s.items.map((i) => `${i.qty}× ${i.name}`).join(', '), amount: s.total })),
    ...db.payments.filter((p) => p.customerId === id)
      .map((p) => ({ date: p.date, text: 'Abono' + (p.note ? ' — ' + p.note : ''), amount: -p.amount })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  openModal(customerForm(c) + `
    <h3>Movimientos · saldo ${money(customerBalance(id))}</h3>
    <div class="table-wrap" style="max-height:240px;overflow:auto"><table><tbody>
      ${entries.map((e) => `<tr><td class="muted">${fmtDate(e.date)}</td><td>${esc(e.text)}</td>
        <td class="num" style="color:${e.amount < 0 ? 'var(--ok)' : 'var(--danger)'}">${money(Math.abs(e.amount))}</td></tr>`).join('') || '<tr><td class="empty">Sin movimientos</td></tr>'}
    </tbody></table></div>
    ${entries.length === 0 ? '<p><button type="button" class="btn small danger" id="delete-customer">Eliminar cliente</button></p>' : ''}`,
    ({ name, phone, limit }) => {
      Object.assign(c, { name: name.trim(), phone: phone.trim(), limit: num(limit) });
      save(); render();
    });
  const del = document.getElementById('delete-customer');
  if (del) del.onclick = () => {
    db.customers = db.customers.filter((x) => x.id !== id);
    save(); document.getElementById('modal').close(); render();
  };
};

// ---------- CAJA ----------

views.caja = () => {
  const session = openSession();
  const history = db.cashSessions.filter((s) => s.closedAt).slice(-10).reverse();

  if (!session) {
    return `
    <section class="card">
      <h2>Abrir caja</h2>
      <p class="muted">Cuenta el dinero con el que empiezas el día (la base).</p>
      <button class="btn block" data-action="open-cash">Abrir caja</button>
    </section>
    ${historyTable(history)}`;
  }

  const s = sessionSummary(session);
  return `
  <div class="stats">
    <div class="stat"><div class="label">Base inicial</div><div class="value">${money(session.openingAmount)}</div></div>
    <div class="stat good"><div class="label">Ventas en efectivo</div><div class="value">${money(s.cashSales)}</div></div>
    <div class="stat"><div class="label">Transferencias</div><div class="value">${money(s.transferSales)}</div></div>
    <div class="stat"><div class="label">Fiado hoy</div><div class="value">${money(s.fiadoSales)}</div></div>
    <div class="stat good"><div class="label">Abonos en efectivo</div><div class="value">${money(s.abonos)}</div></div>
    <div class="stat bad"><div class="label">Gastos / salidas</div><div class="value">${money(s.gastos)}</div></div>
  </div>
  <section class="card" style="margin-top:12px">
    <div class="spread">
      <div><div class="muted">Debe haber en caja</div><div class="total" style="text-align:left;margin:0">${money(s.expected)}</div></div>
      <div class="row">
        <button class="btn secondary" data-action="movement" data-type="ingreso">+ Ingreso</button>
        <button class="btn secondary" data-action="movement" data-type="gasto">− Gasto</button>
        <button class="btn danger" data-action="close-cash">Cerrar caja</button>
      </div>
    </div>
    <p class="muted">Abierta: ${fmtDate(session.openedAt)} · ${s.sales.length} ventas</p>
  </section>
  <section class="card">
    <h3>Movimientos del turno</h3>
    <div class="table-wrap"><table><tbody>
      ${[...s.sales.map((x) => ({ date: x.date, text: `Venta (${x.method})` + (x.customerId ? ' — ' + esc(byId(db.customers, x.customerId)?.name || '') : ''), amount: x.total, id: x.id, sale: true })),
        ...s.moves.map((m) => ({ date: m.date, text: esc(m.concept), amount: m.type === 'gasto' ? -m.amount : m.amount }))]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => `<tr><td class="muted">${fmtDate(e.date)}</td><td>${e.text}</td>
          <td class="num" style="color:${e.amount < 0 ? 'var(--danger)' : 'inherit'}">${money(e.amount)}</td>
          <td class="num">${e.sale ? `<button class="btn small secondary" data-action="void-sale" data-id="${e.id}" title="Anular venta">✕</button>` : ''}</td></tr>`)
        .join('') || '<tr><td class="empty">Sin movimientos aún</td></tr>'}
    </tbody></table></div>
  </section>
  ${historyTable(history)}`;
};

function historyTable(history) {
  if (!history.length) return '';
  return `<section class="card"><h3>Cierres anteriores</h3><div class="table-wrap"><table>
    <thead><tr><th>Cierre</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead>
    <tbody>${history.map((h) => {
      const diff = h.countedAmount - h.expected;
      return `<tr><td>${fmtDate(h.closedAt)}</td><td class="num">${money(h.expected)}</td><td class="num">${money(h.countedAmount)}</td>
        <td class="num"><span class="badge ${diff === 0 ? 'green' : diff > 0 ? 'amber' : 'red'}">${diff > 0 ? '+' : ''}${money(diff)}</span></td></tr>`;
    }).join('')}</tbody></table></div></section>`;
}

actions['open-cash'] = () => {
  const last = db.cashSessions.filter((s) => s.closedAt).at(-1);
  openModal(`
    <h2>Abrir caja</h2>
    <label>Dinero inicial (base)</label>
    <input name="amount" type="number" min="0" step="any" inputmode="decimal" value="${last ? last.countedAmount : 0}" required>`,
    ({ amount }) => {
      db.cashSessions.push({ id: uid(), openedAt: now(), openingAmount: num(amount), closedAt: null });
      save(); render(); toast('Caja abierta');
    });
};

actions['close-cash'] = () => {
  const session = openSession();
  const s = sessionSummary(session);
  openModal(`
    <h2>Cerrar caja</h2>
    <p>Debe haber <strong>${money(s.expected)}</strong></p>
    <label>¿Cuánto dinero contaste?</label>
    <input name="counted" type="number" min="0" step="any" inputmode="decimal" value="${s.expected}" required>`,
    ({ counted }) => {
      const c = num(counted);
      Object.assign(session, { closedAt: now(), countedAmount: c, expected: s.expected });
      save(); render();
      const diff = c - s.expected;
      toast(diff === 0 ? 'Caja cuadrada ✔' : diff > 0 ? `Sobrante de ${money(diff)}` : `Faltante de ${money(-diff)}`);
    });
};

actions.movement = ({ type }) => {
  const session = openSession();
  openModal(`
    <h2>${type === 'gasto' ? 'Registrar gasto o salida' : 'Registrar ingreso'}</h2>
    <label>Concepto</label>
    <input name="concept" required placeholder="${type === 'gasto' ? 'Ej: Pago de luz, domicilio, almuerzo' : 'Ej: Recarga, préstamo'}">
    <label>Valor</label><input name="amount" type="number" min="1" step="any" inputmode="decimal" required>`,
    ({ concept, amount }) => {
      db.movements.push({ id: uid(), date: now(), type, concept, amount: num(amount), cashSessionId: session.id });
      save(); render();
    });
};

actions['void-sale'] = ({ id }) => {
  const sale = byId(db.sales, id);
  askConfirm(`Se anulará la venta de ${money(sale.total)} y el stock volverá al inventario.`, () => {
    for (const l of sale.items) {
      const p = l.productId && byId(db.products, l.productId);
      if (p) p.stock = +(p.stock + l.qty).toFixed(3);
    }
    db.sales = db.sales.filter((s) => s.id !== id);
    save(); render(); toast('Venta anulada');
  }, { okText: 'Anular venta', danger: true });
};

// ---------- GANANCIAS ----------

function rangeBounds(range) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (range === 'semana') start.setDate(start.getDate() - 6);
  if (range === 'mes') start.setDate(1);
  if (range === 'ano') { start.setMonth(0, 1); }
  return [start.toISOString(), end.toISOString(), start];
}

views.reportes = () => {
  const [from, to] = rangeBounds(reportRange);
  const st = periodStats(from, to);

  // Gráfico de los últimos 14 días.
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    days.push(dayKey(d.toISOString()));
  }
  const byDay = Object.fromEntries(days.map((d) => [d, { rev: 0, profit: 0 }]));
  for (const s of db.sales) {
    const k = dayKey(s.date);
    if (byDay[k]) { byDay[k].rev += s.total; byDay[k].profit += s.total - s.cost; }
  }
  const max = Math.max(1, ...Object.values(byDay).map((d) => d.rev));

  // Productos más vendidos y más rentables en el periodo.
  const prod = {};
  for (const s of st.sales) for (const l of s.items) {
    const k = l.productId || l.name;
    prod[k] ??= { name: l.name, qty: 0, rev: 0, profit: 0 };
    prod[k].qty += l.qty; prod[k].rev += l.qty * l.price; prod[k].profit += l.qty * (l.price - l.cost);
  }
  const top = Object.values(prod).sort((a, b) => b.profit - a.profit).slice(0, 10);
  const avgTicket = st.sales.length ? st.revenue / st.sales.length : 0;

  return `
  <div class="row no-print" style="margin-bottom:12px">
    ${[['hoy', 'Hoy'], ['semana', '7 días'], ['mes', 'Este mes'], ['ano', 'Este año']].map(([k, l]) =>
      `<button class="btn small ${reportRange === k ? '' : 'secondary'}" data-action="range" data-range="${k}">${l}</button>`).join('')}
  </div>
  <div class="stats">
    <div class="stat"><div class="label">Ventas</div><div class="value">${money(st.revenue)}</div></div>
    <div class="stat"><div class="label">Costo de lo vendido</div><div class="value">${money(st.cost)}</div></div>
    <div class="stat good"><div class="label">Ganancia bruta</div><div class="value">${money(st.gross)}</div></div>
    <div class="stat bad"><div class="label">Gastos</div><div class="value">${money(st.expenses)}</div></div>
    <div class="stat ${st.net >= 0 ? 'good' : 'bad'}"><div class="label">Ganancia neta</div><div class="value">${money(st.net)}</div></div>
    <div class="stat"><div class="label">Nº ventas · ticket prom.</div><div class="value">${st.sales.length} · ${money(avgTicket)}</div></div>
  </div>
  <section class="card" style="margin-top:12px">
    <h3>Últimos 14 días</h3>
    <div class="bar-chart">${days.map((d) => `
      <div class="bar" style="height:${(byDay[d].rev / max) * 100}%" title="${d}: ventas ${money(byDay[d].rev)}, ganancia ${money(byDay[d].profit)}">
        <div class="profit" style="height:${byDay[d].rev ? Math.max(0, (byDay[d].profit / byDay[d].rev) * 100) : 0}%"></div>
      </div>`).join('')}</div>
    <div class="bar-labels">${days.map((d) => `<span>${d.slice(8)}</span>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--brand)"></i>Ventas</span><span><i style="background:var(--accent)"></i>Ganancia</span></div>
  </section>
  <section class="card">
    <h3>Productos que más ganancia dejan</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Producto</th><th class="num">Unidades</th><th class="num">Ventas</th><th class="num">Ganancia</th></tr></thead>
      <tbody>${top.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${+p.qty.toFixed(2)}</td><td class="num">${money(p.rev)}</td><td class="num">${money(p.profit)}</td></tr>`).join('')
        || '<tr><td colspan="4" class="empty">Sin ventas en este periodo</td></tr>'}</tbody>
    </table></div>
  </section>`;
};

actions.range = ({ range }) => { reportRange = range; render(); };

// ---------- AJUSTES ----------

views.ajustes = () => `
  <section class="card">
    <h2>Mi tienda</h2>
    <form id="settings-form">
      <label>Nombre de la tienda</label><input name="storeName" value="${esc(db.settings.storeName)}">
      <label>Dueño / responsable</label><input name="ownerName" value="${esc(db.settings.ownerName || '')}">
      <div class="row">
        <div class="grow"><label>Moneda</label>
          <select name="currency">${['COP', 'MXN', 'USD', 'PEN', 'CLP', 'ARS', 'VES', 'GTQ', 'DOP', 'EUR'].map((c) =>
            `<option ${db.settings.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div class="grow"><label>Formato regional</label>
          <select name="locale">${[['es-CO', 'Colombia'], ['es-MX', 'México'], ['es-PE', 'Perú'], ['es-CL', 'Chile'], ['es-AR', 'Argentina'], ['es-VE', 'Venezuela'], ['es-EC', 'Ecuador'], ['es-US', 'Estados Unidos'], ['es-ES', 'España']].map(([k, l]) =>
            `<option value="${k}" ${db.settings.locale === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <p><button class="btn" type="submit">Guardar</button></p>
    </form>
  </section>
  <section class="card">
    <h2>Copia de seguridad</h2>
    <p class="muted">Tus datos se guardan solo en este dispositivo. Descarga una copia con frecuencia.</p>
    <div class="row">
      ${window.POSCAN_SINGLE_FILE ? '' : '<button class="btn" data-action="export">⬇ Descargar copia</button>'}
      <button class="btn ${window.POSCAN_SINGLE_FILE ? '' : 'secondary'}" data-action="copy-backup">Copiar copia</button>
      <button class="btn secondary" data-action="paste-backup">Pegar copia</button>
      <label class="btn secondary" style="margin:0">⬆ Restaurar copia<input type="file" id="import-file" accept="application/json" hidden></label>
      ${window.POSCAN_SINGLE_FILE ? '' : '<button class="btn secondary" data-action="export-csv">Inventario CSV</button>'}
    </div>
  </section>
  <section class="card">
    <h2>Datos de prueba</h2>
    <div class="row">
      <button class="btn secondary" data-action="demo">Cargar productos de ejemplo</button>
      <button class="btn danger" data-action="reset">Borrar todos los datos</button>
    </div>
  </section>
  <p class="muted" style="text-align:center">POS-CAN v1.0 · Funciona sin internet</p>`;

afterRender.ajustes = () => {
  document.getElementById('settings-form').onsubmit = (e) => {
    e.preventDefault();
    Object.assign(db.settings, Object.fromEntries(new FormData(e.target)));
    save(); render(); toast('Ajustes guardados');
  };
  document.getElementById('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.products) || !data.settings) throw new Error('formato');
      askConfirm('La copia reemplazará todos los datos actuales.', () => {
        db = { ...emptyDb(), ...data };
        save(); render(); toast('Copia restaurada');
      }, { okText: 'Restaurar', danger: true });
    } catch {
      toast('El archivo no es una copia válida de POS-CAN');
    }
  };
};

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

actions['copy-backup'] = async () => {
  const text = JSON.stringify(db);
  try {
    await navigator.clipboard.writeText(text);
    toast('Copia copiada. Pégala en una nota o mensaje para guardarla.');
  } catch {
    openModal(`<h2>Tu copia de seguridad</h2><p class="muted">Selecciona todo el texto y cópialo.</p>
      <textarea id="backup-text" rows="8" readonly>${esc(text)}</textarea>`, () => {}, { okText: 'Listo' });
    document.getElementById('backup-text').select();
  }
};

actions['paste-backup'] = () => openModal(`
  <h2>Restaurar copia</h2>
  <label for="backup-paste">Pega aquí el texto de la copia</label>
  <textarea id="backup-paste" name="text" rows="8" required></textarea>`,
  ({ text }) => {
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data.products) || !data.settings) throw new Error('formato');
      askConfirm('La copia reemplazará todos los datos actuales.', () => {
        db = { ...emptyDb(), ...data };
        save(); render(); toast('Copia restaurada');
      }, { okText: 'Restaurar', danger: true });
    } catch {
      toast('Ese texto no es una copia válida de POS-CAN');
    }
    return false;
  }, { okText: 'Restaurar' });

actions.export = () => download(`poscan-copia-${dayKey(now())}.json`, JSON.stringify(db, null, 2), 'application/json');

actions['export-csv'] = () => {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Nombre', 'Código', 'Categoría', 'Costo', 'Precio', 'Stock', 'Stock mínimo'],
    ...db.products.map((p) => [p.name, p.barcode, p.category, p.cost, p.price, p.stock, p.minStock])];
  download(`poscan-inventario-${dayKey(now())}.csv`, '﻿' + rows.map((r) => r.map(q).join(';')).join('\n'), 'text/csv');
};

function seedDemo(target) {
  const demo = [
    ['Arroz 500g', 'Granos', 1900, 2500, 40], ['Aceite 1L', 'Abarrotes', 7800, 9500, 12], ['Huevo unidad', 'Lácteos y huevos', 450, 600, 90],
    ['Leche 1L', 'Lácteos y huevos', 3200, 4000, 24], ['Pan tajado', 'Panadería', 4500, 5800, 8], ['Gaseosa 400ml', 'Bebidas', 1700, 2500, 36],
    ['Agua 600ml', 'Bebidas', 900, 1500, 30], ['Azúcar 1kg', 'Abarrotes', 3600, 4500, 15], ['Café 250g', 'Abarrotes', 8200, 10500, 6],
    ['Jabón de barra', 'Aseo', 2100, 3000, 20], ['Papel higiénico x4', 'Aseo', 5200, 6900, 10], ['Galletas paquete', 'Mecato', 1200, 1800, 25],
  ];
  for (const [name, category, cost, price, stock] of demo) {
    if (!target.products.some((p) => p.name === name)) target.products.push({ id: uid(), name, category, barcode: '', cost, price, stock, minStock: 5 });
  }
}

actions.demo = () => { seedDemo(db); save(); render(); toast('Productos de ejemplo cargados'); };

actions['clear-demo'] = () => askConfirm('Se borrarán los productos, clientes y ventas de ejemplo para que empieces con tu tienda vacía.', () => {
  db = emptyDb(); db.settings.demo = false; cart = [];
  save(); render(); toast('Listo. Agrega tus productos en Inventario.');
}, { okText: 'Empezar de cero', danger: true });

actions['keep-demo'] = () => { db.settings.demo = false; save(); render(); };

actions.reset = () => {
  askConfirm('Se borrarán todos los productos, clientes, ventas y cierres de caja. Guarda una copia antes si la necesitas.', () => {
    db = emptyDb(); db.settings.demo = false; cart = [];
    save(); render(); toast('Datos borrados');
  }, { okText: 'Borrar todo', danger: true, typed: 'BORRAR' });
};

// ---------- Inicio ----------

render();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.POSCAN_SINGLE_FILE) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
