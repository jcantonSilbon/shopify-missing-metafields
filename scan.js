// scan.js
import "dotenv/config";
import { shopifyGraphQL } from "./shopify.js";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";
import path from "path";
import os from "os";

// 1) Metafields requeridos
const REQUIRED = {
    PRODUCT: [{ namespace: "custom", key: "newsection" }],
    COLLECTION: [{ namespace: "custom", key: "coleccion" }],
    PAGE: [{ namespace: "custom", key: "familia" }],
};

const mfKey = ({ namespace, key }) => `${namespace}.${key}`;

// ---------- helpers de campos aliased ----------
function buildNodeFieldsWithAliasedMetafields(req, extraFields = "") {
    const aliased = req
        .map(
            (r, i) => `
    mf${i}: metafield(namespace: "${r.namespace}", key: "${r.key}") {
      namespace
      key
      value
    }`
        )
        .join("\n");

    return `
    id
    handle
    title
    ${extraFields}
    ${aliased}
  `;
}

function computeMissingFromAliases(node, req) {
    const missing = [];
    req.forEach((r, i) => {
        if (!node[`mf${i}`]) missing.push(`${r.namespace}.${r.key}`);
    });
    return missing;
}

// 2) Paginación genérica con sortKey opcional
async function fetchPaged(root, nodeFields, { sortKey, queryStr } = {}) {
    const out = [];
    let cursor = null;
    let hasNext = true;

    while (hasNext) {
        const hasQuery = Boolean(queryStr);
        const header = `query($cursor: String${hasQuery ? ", $query: String" : ""})`;
        const args = [`first: 200`, `after: $cursor`];
        if (sortKey) args.push(`sortKey: ${sortKey}`);
        if (hasQuery) args.push(`query: $query`);

        const query = `
      ${header} {
        ${root}(${args.join(", ")}) {
          edges { cursor node { ${nodeFields} } }
          pageInfo { hasNextPage }
        }
      }
    `;

        const variables = hasQuery ? { cursor, query: queryStr } : { cursor };
        const data = await shopifyGraphQL(query, variables);
        const conn = data[root];
        out.push(...conn.edges.map(e => e.node));
        hasNext = conn.pageInfo.hasNextPage;
        cursor = hasNext ? conn.edges.at(-1).cursor : null;
    }
    return out;
}



// 3) Checkers por tipo (con estado y filtro de visibilidad/publicación)
// --- PRODUCTS: solo activos y publicados ---
async function fetchProductsMissing() {
    const req = REQUIRED.PRODUCT;
    if (!req.length) return [];

    const nodeFields = `
    id
    handle
    title
    metafield(namespace: "custom", key: "newsection") { id }
  `;

    // Filtra por estado y publicación con query
    const items = await fetchPaged("products", nodeFields, {
        sortKey: "ID",
        queryStr: "status:ACTIVE AND published_status:published"
    });

    return items
        .map((p) => {
            const missing = [];
            if (!p.metafield) missing.push(`${req[0].namespace}.${req[0].key}`);
            return missing.length
                ? { type: "PRODUCT", estado: "Activo", id: p.id, handle: p.handle, title: p.title, missing }
                : null;
        })
        .filter(Boolean);
}




// --- COLLECTIONS: solo publicadas ---
async function fetchCollectionsMissing() {
    const req = REQUIRED.COLLECTION;
    if (!req.length) return [];

    const nodeFields = `
    id
    handle
    title
    metafield(namespace: "custom", key: "coleccion") { id }
  `;

    // Filtra por publicadas (sin timestamps raros)
    const items = await fetchPaged("collections", nodeFields, {
        sortKey: "ID",
        queryStr: "published_status:published"
    });

    return items
        .map((c) => {
            const missing = [];
            if (!c.metafield) missing.push(`${req[0].namespace}.${req[0].key}`);
            return missing.length
                ? { type: "COLLECTION", estado: "Publicada", id: c.id, handle: c.handle, title: c.title, missing }
                : null;
        })
        .filter(Boolean);
}




// --- PAGES: solo visibles (SIN query ni sortKey) ---
async function fetchPagesMissing() {
    const req = REQUIRED.PAGE;
    if (!req.length) return [];

    const nodeFields = `
    id
    handle
    title
    publishedAt
    metafield(namespace: "custom", key: "familia") { id }
  `;

    const items = await fetchPaged("pages", nodeFields); // SIN query y SIN sortKey

    return items
        .map((p) => {
            // visible si tiene publishedAt
            if (!p.publishedAt) return null;
            const missing = [];
            if (!p.metafield) missing.push(`${req[0].namespace}.${req[0].key}`);
            return missing.length
                ? { type: "PAGE", estado: "Visible", id: p.id, handle: p.handle, title: p.title, missing }
                : null;
        })
        .filter(Boolean);
}



// 4) Excel (añadimos columna Estado)
async function buildReport(rows) {
    // Orden: Activo > Visible > Publicada
    const weight = (r) => (
        r.estado === "Activo" ? 3 :
            r.estado === "Visible" ? 2 :
                r.estado === "Publicada" ? 1 : 0
    );
    rows.sort((a, b) => weight(b) - weight(a));

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Faltan Metafields");
    ws.columns = [
        { header: "Tipo", key: "type", width: 12 },
        { header: "Estado", key: "estado", width: 14 },            // <--- NUEVO
        { header: "ID", key: "id", width: 36 },
        { header: "Handle", key: "handle", width: 30 },
        { header: "Título", key: "title", width: 40 },
        { header: "Metafields faltantes", key: "missing", width: 50 }
    ];
    rows.forEach(r => ws.addRow({
        type: r.type,
        estado: r.estado,
        id: r.id,
        handle: r.handle || "",
        title: r.title,
        missing: r.missing.join(", ")
    }));
    const filename = `missing-metafields_${new Date().toISOString().slice(0, 10)}.xlsx`;
    const outPath = path.join(os.tmpdir(), filename);
    await wb.xlsx.writeFile(outPath);
    return outPath;
}


// 5) Email (SMTP)
async function sendReportEmail(filePath, total, counts) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: false, // STARTTLS
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        requireTLS: true,
        tls: { ciphers: "TLSv1.2" },
    });

    const to = (process.env.REPORT_TO_EMAIL || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (!to.length) throw new Error("Falta REPORT_TO_EMAIL");

    const filename = path.basename(filePath);
    const when = new Date().toLocaleString("es-ES", {
        timeZone: process.env.TIMEZONE || "Europe/Madrid",
    });

    // Asunto claro con totales por tipo
    const subject =
        `[Shopify] Metafields faltantes — ` +
        `Prod ${counts.products} · Col ${counts.collections} · Pág ${counts.pages} (Total ${total})`;

    // Cuerpo muy conciso y accionable
    const text = [
        "Resumen rápido:",
        `• Productos (Activos y publicados): ${counts.products}  → falta 'custom.newsection'`,
        `• Colecciones (Publicadas): ${counts.collections}       → falta 'custom.coleccion'`,
        `• Páginas (Visibles): ${counts.pages}                  → falta 'custom.familia'`,
        "",
        `Adjunto: ${filename}`,
        "Acción: rellenar los metafields indicados en el Excel.",
        "",
        "Frecuencia: viernes a las 12:19 (Europe/Madrid).",
        `Generado: ${when}`
    ].join("\n");

    await transporter.sendMail({
        from: process.env.SMTP_USER,
        to,
        subject,
        text,
        attachments: [{ filename, path: filePath }],
    });
}

// 6) Orquestación
export default async function scan() {
    const [prods, cols, pages] = await Promise.all([
        fetchProductsMissing(),
        fetchCollectionsMissing(),
        fetchPagesMissing(),
    ]);
    const rows = [...prods, ...cols, ...pages];
    const excelPath = await buildReport(rows);
    const counts = {
        products: prods.length,
        collections: cols.length,
        pages: pages.length,
    };
    await sendReportEmail(excelPath, rows.length, counts);
    return { missing: rows.length, file: excelPath };
}

if (process.argv[1]?.endsWith("scan.js")) {
    scan()
        .then((r) => console.log("✅ Done:", r))
        .catch((e) => {
            console.error("❌ Error:", e);
            process.exit(1);
        });
}
