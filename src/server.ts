import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import editImageRouter from "./routes/editImage";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

// Basic rate-limit for the edit endpoint
app.use(
  "/edit-image",
  rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true })
);

// Liveness
app.get("/health", (_req, res) => res.json({ ok: true }));

// Routes
app.use(editImageRouter);

// 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Export for Vercel
export default app;

// Start server locally
if (process.env.NODE_ENV !== "production") {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}
