import "dotenv/config";
import express from "express";
import morgan from "morgan";
import scan from "./scan.js"; // nuestra función de escaneo
import cron from "node-cron";

const app = express();
app.use(morgan("dev"));
app.use(express.json()); // importante


app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "shopify-missing-metafields ✅\n\nEndpoints:\n  GET  /health\n  GET  /scan\n  POST /scan\n"
  );
});

app.get("/scan", async (_req, res) => {
  try {
    const result = await scan();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Scan error:", err);
    res.status(500).json({ ok: false, error: err?.message || "error" });
  }
});


// ping
app.get("/health", (_req, res) => res.json({ ok: true }));

// dispara el escaneo manualmente desde el navegador o Postman
app.post("/scan", async (_req, res) => {
  try {
    const result = await scan(); // genera Excel y envía email
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Scan error:", err);
    res.status(500).json({ ok: false, error: err?.message || "error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🚀 Server running on http://localhost:${port}`));



// ---- CRON semanal: lunes 09:00 Europe/Madrid ----
let isRunning = false;
cron.schedule(
  "0 9 * * 1",
  async () => {
    if (isRunning) {
      console.log("⏭️  Scan saltado: ya hay uno en curso");
      return;
    }
    isRunning = true;
    console.log("🕘 Lanzando scan semanal…");
    try {
      const result = await scan();
      console.log("✅ Scan semanal enviado:", result);
    } catch (e) {
      console.error("❌ Error en scan semanal:", e);
    } finally {
      isRunning = false;
    }
  },
  { timezone: process.env.TIMEZONE || "Europe/Madrid" }
);